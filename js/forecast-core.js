const SunCalc = globalThis.SunCalc;

const EARTH_RADIUS_KM = 6371;
const EARTH_OMEGA = (2 * Math.PI) / 86400;

export const CLOUD_LAYER_HEIGHTS = {
  low: 1.5,
  mid: 4.5,
  high: 9.0,
};

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function maxIlluminationDistance(heightKm) {
  return Math.sqrt(2 * EARTH_RADIUS_KM * heightKm);
}

export function sunsetVelocity(latDeg) {
  return EARTH_RADIUS_KM * EARTH_OMEGA * Math.cos((latDeg * Math.PI) / 180);
}

export function firecloudDurationSeconds(heightKm, latDeg) {
  const velocity = Math.max(sunsetVelocity(latDeg), 1e-6);
  return maxIlluminationDistance(heightKm) / velocity;
}

export function aodFactor(aod = 0.25) {
  const threshold = 0.25;
  const penalty = Math.max(0, aod - threshold);
  return Math.exp(-1.8 * penalty);
}

export function aodLabel(aod = 0) {
  if (aod < 0.1) return '清洁 (<0.1)';
  if (aod < 0.3) return '轻污 (0.1–0.3)';
  if (aod < 0.6) return '中污 (0.3–0.6)';
  if (aod < 1.0) return '大污 (0.6–1.0)';
  return '重污 (≥1.0)';
}

export function scoreLabel(score = 0) {
  if (score < 0.3) return { label: '不烧', css: 'score-none' };
  if (score < 1.0) return { label: '微烧', css: 'score-micro' };
  if (score < 2.0) return { label: '小烧', css: 'score-small' };
  if (score < 3.0) return { label: '中烧', css: 'score-medium' };
  if (score < 4.0) return { label: '大烧', css: 'score-large' };
  return { label: '超烧', css: 'score-super' };
}

export function scoreToColor(score = 0) {
  if (score < 0.3) return '#4a9eff';
  if (score < 1.0) return '#78d97e';
  if (score < 2.0) return '#f5e642';
  if (score < 3.0) return '#ff9020';
  if (score < 4.0) return '#ff4d1a';
  return '#cc0066';
}

export function estimateCloudBase(lowCover = 0, midCover = 0, highCover = 0) {
  if (lowCover >= 20) return { layer: 'low', heightKm: CLOUD_LAYER_HEIGHTS.low };
  if (midCover >= 20) return { layer: 'mid', heightKm: CLOUD_LAYER_HEIGHTS.mid };
  if (highCover >= 20) return { layer: 'high', heightKm: CLOUD_LAYER_HEIGHTS.high };
  return { layer: 'mixed', heightKm: CLOUD_LAYER_HEIGHTS.mid };
}

function layerScore(coverPct, heightKm, deltaTSeconds, latDeg, isEvening) {
  if (coverPct < 3) return 0;

  const coreDuration = firecloudDurationSeconds(heightKm, latDeg);
  const effectiveDuration = coreDuration * 3;
  const dt = isEvening ? -deltaTSeconds : deltaTSeconds;

  let timeFactor = 0;
  if (dt < -effectiveDuration * 0.2) {
    timeFactor = 0;
  } else if (dt < 0) {
    timeFactor = Math.max(0, 1 + dt / (effectiveDuration * 0.2));
  } else if (dt < effectiveDuration * 0.4) {
    timeFactor = 1.0;
  } else if (dt < effectiveDuration) {
    timeFactor = 1.0 - 0.5 * ((dt - effectiveDuration * 0.4) / (effectiveDuration * 0.6));
  }

  const cover = coverPct / 100;
  let coverFactor = 0;
  if (cover < 0.05) {
    coverFactor = cover / 0.05;
  } else if (cover < 0.2) {
    coverFactor = 0.5 + 0.5 * ((cover - 0.05) / 0.15);
  } else if (cover <= 0.8) {
    coverFactor = 1.0;
  } else {
    coverFactor = Math.max(0, (1 - cover) / 0.2);
  }

  const heightFactor = Math.min(maxIlluminationDistance(heightKm) / 340, 1.0);

  return timeFactor * coverFactor * (0.4 + heightFactor * 0.6);
}

function eventScore({ lat, lon, hourlyEntry, time, eventType }) {
  const sunTimes = SunCalc.getTimes(time, lat, lon);
  const eventTime = eventType === 'sunset' ? sunTimes.sunset : sunTimes.sunrise;
  if (!eventTime || Number.isNaN(eventTime.getTime())) return null;

  const deltaT = (time.getTime() - eventTime.getTime()) / 1000;
  const maxWindow = 90 * 60;
  if (Math.abs(deltaT) > maxWindow) {
    return {
      score: 0,
      deltaT,
      eventTime,
      outsideWindow: true,
    };
  }

  const cloudLow = hourlyEntry.cloud_cover_low ?? 0;
  const cloudMid = hourlyEntry.cloud_cover_mid ?? 0;
  const cloudHigh = hourlyEntry.cloud_cover_high ?? 0;
  const aod = hourlyEntry.aerosol_optical_depth ?? 0.2;
  const isEvening = eventType === 'sunset';

  const highScore = layerScore(cloudHigh, CLOUD_LAYER_HEIGHTS.high, deltaT, lat, isEvening);
  const midScore = layerScore(cloudMid, CLOUD_LAYER_HEIGHTS.mid, deltaT, lat, isEvening);
  const lowScore = layerScore(cloudLow, CLOUD_LAYER_HEIGHTS.low, deltaT, lat, isEvening);

  const lowBlock = Math.max(0.3, 1 - Math.pow(cloudLow / 100, 1.5) * 0.7);

  const rawScore = highScore * 2.5 * lowBlock + midScore * 1.8 * lowBlock + lowScore * 1.0;
  const score = clamp(rawScore * aodFactor(aod) * 1.1, 0, 5);

  return {
    score,
    eventType,
    eventTime,
    deltaT,
    cloudLow,
    cloudMid,
    cloudHigh,
    aod,
    aodMult: aodFactor(aod),
    lowBlock,
    rawScore,
    highScore,
    midScore,
    lowScore,
    dominantLayer: estimateCloudBase(cloudLow, cloudMid, cloudHigh),
  };
}

export function buildCityForecast(city, weatherData) {
  const hourly = weatherData?.hourly;
  if (!hourly?.time?.length) return { series: [], daily: [], best: null };

  const series = [];

  for (let i = 0; i < hourly.time.length; i += 1) {
    const time = parseForecastTime(hourly.time[i]);
    const entry = {
      cloud_cover: hourly.cloud_cover?.[i] ?? 0,
      cloud_cover_low: hourly.cloud_cover_low?.[i] ?? 0,
      cloud_cover_mid: hourly.cloud_cover_mid?.[i] ?? 0,
      cloud_cover_high: hourly.cloud_cover_high?.[i] ?? 0,
      aerosol_optical_depth: hourly.aerosol_optical_depth?.[i] ?? 0.2,
    };

    const sunset = eventScore({ lat: city.lat, lon: city.lon, hourlyEntry: entry, time, eventType: 'sunset' });
    const sunrise = eventScore({ lat: city.lat, lon: city.lon, hourlyEntry: entry, time, eventType: 'sunrise' });
    const sunsetScore = sunset?.score ?? 0;
    const sunriseScore = sunrise?.score ?? 0;
    const score = Math.max(sunsetScore, sunriseScore);

    series.push({
      time: time.toISOString(),
      score,
      sunsetScore,
      sunriseScore,
      detail: score === sunsetScore ? sunset : sunrise,
      cloudLow: entry.cloud_cover_low,
      cloudMid: entry.cloud_cover_mid,
      cloudHigh: entry.cloud_cover_high,
      aod: entry.aerosol_optical_depth,
    });
  }

  const grouped = new Map();
  for (const point of series) {
    const date = localDayKey(point.time);
    if (!grouped.has(date)) grouped.set(date, []);
    grouped.get(date).push(point);
  }

  const daily = [...grouped.entries()].map(([date, points]) => {
    const sunsetBest = points.reduce((best, cur) => (cur.sunsetScore > (best?.sunsetScore ?? -1) ? cur : best), null);
    const sunriseBest = points.reduce((best, cur) => (cur.sunriseScore > (best?.sunriseScore ?? -1) ? cur : best), null);
    const best = [sunsetBest, sunriseBest].filter(Boolean).sort((a, b) => b.score - a.score)[0] ?? null;
    return {
      date,
      sunset: sunsetBest,
      sunrise: sunriseBest,
      best,
    };
  });

  const best = [...series].sort((a, b) => b.score - a.score)[0] ?? null;
  return { series, daily, best };
}

export function formatTime(dateLike) {
  const date = dateLike instanceof Date ? dateLike : new Date(dateLike);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Shanghai',
  });
}

export function formatDate(dateLike) {
  const date = dateLike instanceof Date ? dateLike : new Date(dateLike);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleDateString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
    timeZone: 'Asia/Shanghai',
  });
}

export function formatAxisTime(dateLike) {
  const date = dateLike instanceof Date ? dateLike : new Date(dateLike);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Shanghai',
  });
}

export function formatLocalDate(dateLike) {
  const date = dateLike instanceof Date ? dateLike : new Date(dateLike);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'Asia/Shanghai',
  });
}

export function localDayKey(dateLike) {
  const date = dateLike instanceof Date ? dateLike : new Date(dateLike);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

export function parseForecastTime(value) {
  if (!value) return new Date(NaN);
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(value)) return new Date(value);
  const iso = value.length === 16 ? `${value}:00+08:00` : `${value}+08:00`;
  return new Date(iso);
}
