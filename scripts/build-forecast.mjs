import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import SunCalc from 'suncalc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const OUT_PATH = path.join(DIST, 'data', 'latest.json');

const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/gfs';
const AIR_QUALITY_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';

const BASE_WEATHER_VARS = [
  'cloud_cover',
  'cloud_cover_low',
  'cloud_cover_mid',
  'cloud_cover_high',
].join(',');

const AIR_QUALITY_VARS = 'aerosol_optical_depth';

const PRESSURE_LEVELS = [1000, 925, 850, 700, 600, 500, 400];
const SAMPLE_DISTANCES_KM = [40, 80, 120, 180, 240, 320, 420, 560];
const CONCURRENCY = 6;
const EARTH_RADIUS_KM = 6371;

globalThis.SunCalc = SunCalc;

const { CITIES } = await import('../js/cities.js');
const { parseForecastTime, localDayKey } = await import('../js/forecast-core.js');

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, retries = 2) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': 'SunsetWhisper/1.0 (+https://github.com/lzq1206/SunsetWhisper)' },
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(900 * (attempt + 1));
    }
  }
  throw lastError;
}

function toBearingFromSunCalcAzimuth(azimuthRad) {
  return (azimuthRad * 180 / Math.PI + 180 + 360) % 360;
}

function destinationPoint(lat, lon, bearingDeg, distanceKm) {
  const br = bearingDeg * Math.PI / 180;
  const d = distanceKm / EARTH_RADIUS_KM;
  const lat1 = lat * Math.PI / 180;
  const lon1 = lon * Math.PI / 180;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(br),
  );
  const lon2 = lon1 + Math.atan2(
    Math.sin(br) * Math.sin(d) * Math.cos(lat1),
    Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
  );

  return {
    lat: lat2 * 180 / Math.PI,
    lon: ((lon2 * 180 / Math.PI + 540) % 360) - 180,
  };
}

function pressureVars() {
  const vars = [];
  for (const lv of PRESSURE_LEVELS) {
    vars.push(`relative_humidity_${lv}hPa`);
    vars.push(`cloud_cover_${lv}hPa`);
    vars.push(`geopotential_height_${lv}hPa`);
  }
  return vars.join(',');
}

function levelWeight(level) {
  if (level <= 700) return 1.05;
  if (level <= 850) return 0.9;
  return 0.7;
}

function timeFactor(eventType, deltaMinutes) {
  const target = eventType === 'sunset' ? 35 : -35;
  const window = 95;
  return clamp(1 - Math.abs(deltaMinutes - target) / window, 0, 1);
}

function aodClarity(aod) {
  const penalty = Math.max(0, (aod ?? 0.2) - 0.2);
  return Math.exp(-1.6 * penalty);
}

function illuminationDistance(heightKm) {
  return Math.sqrt(2 * EARTH_RADIUS_KM * Math.max(heightKm, 0.2));
}

const THRESHOLDS = {
  cloudPresent: { rh: 78, cloudCover: 8 },
  cloudBlock: { rh: 82, cloudCover: 20 },
  lowerBlock: { rh: 80, cloudCover: 15 },
};

function samplePointScore(samplePoint, index, distanceKm) {
  const states = [];

  for (const lv of PRESSURE_LEVELS) {
    const rh = samplePoint.hourly?.[`relative_humidity_${lv}hPa`]?.[index];
    const cc = samplePoint.hourly?.[`cloud_cover_${lv}hPa`]?.[index];
    const gh = samplePoint.hourly?.[`geopotential_height_${lv}hPa`]?.[index];
    const heightKm = gh != null ? gh / 1000 : (lv <= 850 ? 1.8 : lv <= 600 ? 4.5 : 8.0);

    const humidity = rh ?? 0;
    const cloudCover = cc ?? 0;
    const hasCloud = humidity >= THRESHOLDS.cloudPresent.rh && cloudCover >= THRESHOLDS.cloudPresent.cloudCover;
    const blocksLight = humidity >= THRESHOLDS.cloudBlock.rh && cloudCover >= THRESHOLDS.cloudBlock.cloudCover;

    states.push({
      level: lv,
      rh: humidity,
      cloudCover,
      heightKm,
      hasCloud,
      blocksLight,
    });
  }

  const cloudCandidates = [];
  for (const state of states) {
    if (!state.hasCloud) continue;
    const dMax = illuminationDistance(state.heightKm);
    if (distanceKm > dMax) continue;

    const lowerBlock = states
      .filter((s) => s.blocksLight && s.heightKm < state.heightKm)
      .reduce((mx, s) => Math.max(mx, s.cloudCover), 0);

    const transmittance = 1 - clamp(lowerBlock / 100, 0, 0.85);
    const humidityFactor = clamp((state.rh - THRESHOLDS.cloudPresent.rh) / (100 - THRESHOLDS.cloudPresent.rh), 0, 1);
    const cloudFactor = clamp(state.cloudCover / 100, 0, 1);

    cloudCandidates.push({
      ...state,
      lowerBlock,
      transmittance,
      score: cloudFactor * humidityFactor * transmittance * levelWeight(state.level),
      dMax,
    });
  }

  const layers = states.map((state) => ({
    level: state.level,
    rh: state.rh,
    cloudCover: state.cloudCover,
    heightKm: state.heightKm,
    hasCloud: state.hasCloud,
  }));

  if (!cloudCandidates.length) {
    return {
      score: 0,
      cloudBaseKm: null,
      dominant: null,
      lowerBlock: 0,
      cloudLow: states.find((s) => s.level === 1000)?.cloudCover ?? 0,
      cloudMid: states.find((s) => s.level === 700)?.cloudCover ?? 0,
      cloudHigh: states.find((s) => s.level === 500)?.cloudCover ?? 0,
      layers,
    };
  }

  const best = cloudCandidates.sort((a, b) => b.score - a.score)[0];
  return {
    score: best.score,
    cloudBaseKm: best.heightKm,
    dominant: best.level,
    lowerBlock: best.lowerBlock,
    cloudLow: states.find((s) => s.level === 1000)?.cloudCover ?? 0,
    cloudMid: states.find((s) => s.level === 700)?.cloudCover ?? 0,
    cloudHigh: states.find((s) => s.level === 500)?.cloudCover ?? 0,
    layers,
  };
}

function evaluateEventAtHour({ city, baseWeather, sampleData, index, eventType, eventTime }) {
  const hourly = baseWeather.hourly;
  const localTime = parseForecastTime(hourly.time[index]);
  const deltaMinutes = (localTime.getTime() - eventTime.getTime()) / 60000;
  const tf = timeFactor(eventType, deltaMinutes);
  if (tf <= 0) {
    return {
      score: 0,
      eventType,
      eventTime: eventTime.toISOString(),
      deltaT: deltaMinutes * 60,
      outsideWindow: true,
    };
  }

  const pointScores = sampleData[eventType].map((pt, pIdx) => samplePointScore(pt, index, SAMPLE_DISTANCES_KM[pIdx]));
  const validScores = pointScores.map((x) => x.score).filter((x) => x > 0);
  const coverage = pointScores.filter((x) => x.score > 0.15).length / pointScores.length;
  const topMean = validScores.length
    ? validScores.sort((a, b) => b - a).slice(0, 3).reduce((s, v) => s + v, 0) / Math.min(3, validScores.length)
    : 0;

  const baseHeights = pointScores.map((x) => x.cloudBaseKm).filter((x) => x != null).sort((a, b) => a - b);
  const cloudBaseKm = baseHeights.length ? baseHeights[Math.floor(baseHeights.length / 2)] : null;

  const dominantLevel = pointScores
    .map((x) => x.dominant)
    .filter((x) => x != null)
    .sort((a, b) => a - b)[0] ?? null;

  const lowBlock = pointScores.reduce((s, x) => s + (x.lowerBlock ?? 0), 0) / pointScores.length;

  const aod = hourly.aerosol_optical_depth?.[index] ?? 0.2;
  const clarity = aodClarity(aod);

  const raw = (0.62 * topMean + 0.38 * coverage) * tf * clarity;
  const finalScore = clamp(raw * 5.2, 0, 5);

  const pathProfile = pointScores.map((point, pIdx) => ({
    distanceKm: SAMPLE_DISTANCES_KM[pIdx],
    score: point.score,
    dominantLevel: point.dominant,
    cloudBaseKm: point.cloudBaseKm,
    lowerBlock: point.lowerBlock,
    layers: point.layers,
  }));

  return {
    score: finalScore,
    eventType,
    eventTime: eventTime.toISOString(),
    deltaT: deltaMinutes * 60,
    cloudLow: hourly.cloud_cover_low?.[index] ?? 0,
    cloudMid: hourly.cloud_cover_mid?.[index] ?? 0,
    cloudHigh: hourly.cloud_cover_high?.[index] ?? 0,
    aod,
    aodMult: clarity,
    lowBlock,
    rawScore: raw,
    coverage,
    pathMean: topMean,
    dominantLayer: {
      layer: dominantLevel == null ? 'mixed' : dominantLevel >= 700 ? 'low-mid' : 'mid-high',
      pressureLevel: dominantLevel,
      heightKm: cloudBaseKm ?? null,
    },
    pathProfile,
    strict: {
      algorithm: 'ray-path-humidity-v1',
      samplePoints: SAMPLE_DISTANCES_KM.length,
      pathDistancesKm: SAMPLE_DISTANCES_KM,
    },
  };
}

function buildStrictForecast(city, baseWeather, sampleData) {
  const hourly = baseWeather.hourly;
  if (!hourly?.time?.length) return { series: [], daily: [], best: null };

  const series = [];

  for (let i = 0; i < hourly.time.length; i += 1) {
    const time = parseForecastTime(hourly.time[i]);
    const sunTimes = SunCalc.getTimes(time, city.lat, city.lon);

    const sunsetDetail = evaluateEventAtHour({
      city,
      baseWeather,
      sampleData,
      index: i,
      eventType: 'sunset',
      eventTime: sunTimes.sunset,
    });

    const sunriseDetail = evaluateEventAtHour({
      city,
      baseWeather,
      sampleData,
      index: i,
      eventType: 'sunrise',
      eventTime: sunTimes.sunrise,
    });

    const sunsetScore = sunsetDetail?.score ?? 0;
    const sunriseScore = sunriseDetail?.score ?? 0;
    const score = Math.max(sunsetScore, sunriseScore);

    series.push({
      time: time.toISOString(),
      score,
      sunsetScore,
      sunriseScore,
      detail: sunsetScore >= sunriseScore ? sunsetDetail : sunriseDetail,
      cloudLow: hourly.cloud_cover_low?.[i] ?? 0,
      cloudMid: hourly.cloud_cover_mid?.[i] ?? 0,
      cloudHigh: hourly.cloud_cover_high?.[i] ?? 0,
      aod: hourly.aerosol_optical_depth?.[i] ?? 0.2,
    });
  }

  const grouped = new Map();
  for (const point of series) {
    const date = localDayKey(point.time);
    if (!grouped.has(date)) grouped.set(date, []);
    grouped.get(date).push(point);
  }

  const daily = [...grouped.entries()].map(([date, points]) => {
    const sunset = points.reduce((best, cur) => (cur.sunsetScore > (best?.sunsetScore ?? -1) ? cur : best), null);
    const sunrise = points.reduce((best, cur) => (cur.sunriseScore > (best?.sunriseScore ?? -1) ? cur : best), null);
    const best = [sunset, sunrise].filter(Boolean).sort((a, b) => b.score - a.score)[0] ?? null;
    return { date, sunset, sunrise, best };
  });

  const best = [...series].sort((a, b) => b.score - a.score)[0] ?? null;
  return { series, daily, best };
}

async function fetchBaseWeather(city) {
  const weatherParams = new URLSearchParams({
    latitude: city.lat,
    longitude: city.lon,
    hourly: BASE_WEATHER_VARS,
    timezone: 'Asia/Shanghai',
    forecast_days: 3,
  });

  const aqParams = new URLSearchParams({
    latitude: city.lat,
    longitude: city.lon,
    hourly: AIR_QUALITY_VARS,
    timezone: 'Asia/Shanghai',
    forecast_days: 3,
  });

  const [weather, aq] = await Promise.all([
    fetchJson(`${OPEN_METEO_URL}?${weatherParams}`),
    fetchJson(`${AIR_QUALITY_URL}?${aqParams}`).catch(() => null),
  ]);

  if (aq?.hourly?.aerosol_optical_depth && weather?.hourly) {
    weather.hourly.aerosol_optical_depth = aq.hourly.aerosol_optical_depth;
  }

  return weather;
}

async function fetchPressurePoint(point) {
  const params = new URLSearchParams({
    latitude: point.lat,
    longitude: point.lon,
    timezone: 'Asia/Shanghai',
    forecast_days: 3,
    hourly: pressureVars(),
  });
  return fetchJson(`${OPEN_METEO_URL}?${params}`);
}

async function fetchPathSamples(city, weather) {
  const t0 = parseForecastTime(weather.hourly.time[0]);
  const st = SunCalc.getTimes(t0, city.lat, city.lon);
  const sunriseBearing = toBearingFromSunCalcAzimuth(SunCalc.getPosition(st.sunrise, city.lat, city.lon).azimuth);
  const sunsetBearing = toBearingFromSunCalcAzimuth(SunCalc.getPosition(st.sunset, city.lat, city.lon).azimuth);

  const sunrisePoints = SAMPLE_DISTANCES_KM.map((d) => destinationPoint(city.lat, city.lon, sunriseBearing, d));
  const sunsetPoints = SAMPLE_DISTANCES_KM.map((d) => destinationPoint(city.lat, city.lon, sunsetBearing, d));

  const [sunriseData, sunsetData] = await Promise.all([
    Promise.all(sunrisePoints.map((p) => fetchPressurePoint(p))),
    Promise.all(sunsetPoints.map((p) => fetchPressurePoint(p))),
  ]);

  return {
    sunrise: sunriseData,
    sunset: sunsetData,
    bearings: { sunrise: sunriseBearing, sunset: sunsetBearing },
  };
}

async function fetchCity(city) {
  try {
    const baseWeather = await fetchBaseWeather(city);
    const sampleData = await fetchPathSamples(city, baseWeather);
    const forecast = buildStrictForecast(city, baseWeather, sampleData);
    const best = forecast.best;

    return {
      id: city.id,
      name: city.name,
      lat: city.lat,
      lon: city.lon,
      province: city.province,
      region: city.region,
      forecast,
      source: 'open-meteo-gfs-strict',
      bestScore: best?.score ?? 0,
      bestEventType: best?.detail?.eventType ?? null,
      bestEventTime: best?.detail?.eventTime ?? null,
      strictMeta: {
      model: 'ray-path-humidity-v1',
      pressureLevels: PRESSURE_LEVELS,
      sampleDistancesKm: SAMPLE_DISTANCES_KM,
      sunriseBearing: sampleData.bearings.sunrise,
      sunsetBearing: sampleData.bearings.sunset,
      thresholds: THRESHOLDS,
    },
    };
  } catch (error) {
    return {
      id: city.id,
      name: city.name,
      lat: city.lat,
      lon: city.lon,
      province: city.province,
      region: city.region,
      forecast: { series: [], daily: [], best: null },
      source: 'error',
      error: String(error),
      bestScore: 0,
      bestEventType: null,
      bestEventTime: null,
    };
  }
}

async function runWithLimit(items, limit, worker) {
  const results = [];
  let index = 0;
  const runners = Array.from({ length: limit }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await worker(items[current], current);
    }
  });
  await Promise.all(runners);
  return results;
}

async function copyRecursive(src, dest) {
  const stat = await fs.stat(src);
  if (stat.isDirectory()) {
    await fs.mkdir(dest, { recursive: true });
    const entries = await fs.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      await copyRecursive(path.join(src, entry.name), path.join(dest, entry.name));
    }
    return;
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(src, dest);
}

await fs.rm(DIST, { recursive: true, force: true });
await fs.mkdir(DIST, { recursive: true });
await copyRecursive(path.join(ROOT, 'index.html'), path.join(DIST, 'index.html'));
await copyRecursive(path.join(ROOT, 'css'), path.join(DIST, 'css'));
await copyRecursive(path.join(ROOT, 'js'), path.join(DIST, 'js'));
await fs.writeFile(path.join(DIST, '.nojekyll'), '', 'utf8');

const cities = await runWithLimit(CITIES, CONCURRENCY, fetchCity);

const payload = {
  generatedAt: new Date().toISOString(),
  source: 'open-meteo-gfs-strict',
  algorithm: 'ray-path-humidity-v1',
  thresholds: THRESHOLDS,
  notes: '严格版：分层湿度 + 太阳方位光路采样 + 地球曲率照亮判别',
  cities,
};

await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
await fs.writeFile(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
console.log(`Wrote ${OUT_PATH}`);
