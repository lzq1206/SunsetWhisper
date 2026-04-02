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
const SAMPLE_DISTANCES_KM = [0, 60, 120, 220, 360, 540];
const CONCURRENCY = 2;
const EARTH_RADIUS_KM = 6371;

globalThis.SunCalc = SunCalc;

const { CITIES } = await import('../js/cities.js');
const { parseForecastTime, localDayKey } = await import('../js/forecast-core.js');

let previousPayload = null;
try {
  previousPayload = JSON.parse(await fs.readFile(path.join(ROOT, 'data', 'latest.json'), 'utf8'));
} catch {
  previousPayload = null;
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, retries = 4) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': 'SunsetWhisper/1.0 (+https://github.com/lzq1206/SunsetWhisper)' },
      });
      if (!response.ok) {
        const retryAfter = Number(response.headers.get('retry-after') ?? '0');
        const waitMs = retryAfter > 0 ? retryAfter * 1000 : 1200 * (attempt + 1);
        if (response.status === 429 && attempt < retries) {
          await sleep(waitMs);
          continue;
        }
        throw new Error(`${response.status} ${response.statusText}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(1200 * (attempt + 1));
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

function timeFactor(deltaMinutes) {
  const window = 120;
  return clamp(1 - Math.abs(deltaMinutes) / window, 0, 1);
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

function layerDefaultHeightKm(level) {
  if (level >= 1000) return 0.1;
  if (level >= 925) return 0.8;
  if (level >= 850) return 1.5;
  if (level >= 700) return 3.0;
  if (level >= 600) return 4.5;
  if (level >= 500) return 6.0;
  return 8.0;
}

function estimateCloudBase(layers) {
  const present = layers.filter((layer) => layer.rh >= THRESHOLDS.cloudPresent.rh && layer.cloudCover >= THRESHOLDS.cloudPresent.cloudCover);
  if (present.length) {
    return {
      cloudBaseKm: present[0].heightKm,
      source: 'observed',
    };
  }

  const softer = layers.filter((layer) => layer.rh >= 70 && layer.cloudCover >= 5);
  if (softer.length) {
    return {
      cloudBaseKm: softer[0].heightKm,
      source: 'soft-rh70',
    };
  }

  return {
    cloudBaseKm: 1.5,
    source: 'fallback-1.5km',
  };
}

function interpolateHumidity(layers, heightKm) {
  if (!layers.length) return 0;
  const sorted = [...layers].sort((a, b) => a.heightKm - b.heightKm);
  if (heightKm <= sorted[0].heightKm) return sorted[0].rh;
  if (heightKm >= sorted[sorted.length - 1].heightKm) return sorted[sorted.length - 1].rh;

  for (let i = 0; i < sorted.length - 1; i += 1) {
    const low = sorted[i];
    const high = sorted[i + 1];
    if (low.heightKm <= heightKm && heightKm <= high.heightKm) {
      const span = Math.max(high.heightKm - low.heightKm, 1e-6);
      const t = (heightKm - low.heightKm) / span;
      return low.rh + t * (high.rh - low.rh);
    }
  }

  return sorted[sorted.length - 1].rh;
}

function makeLayerState(samplePoint, index) {
  const layers = [];
  for (const lv of PRESSURE_LEVELS) {
    const rh = samplePoint.hourly?.[`relative_humidity_${lv}hPa`]?.[index];
    const cc = samplePoint.hourly?.[`cloud_cover_${lv}hPa`]?.[index];
    const gh = samplePoint.hourly?.[`geopotential_height_${lv}hPa`]?.[index];
    const heightKm = gh != null ? gh / 1000 : layerDefaultHeightKm(lv);
    const humidity = rh ?? 0;
    const cloudCover = cc ?? 0;
    layers.push({
      level: lv,
      rh: humidity,
      cloudCover,
      heightKm,
      hasCloud: humidity >= THRESHOLDS.cloudPresent.rh && cloudCover >= THRESHOLDS.cloudPresent.cloudCover,
    });
  }
  return layers;
}

function parabolaVertexKm(cloudBaseKm) {
  return Math.sqrt(2 * EARTH_RADIUS_KM * Math.max(cloudBaseKm, 0.05));
}

function parabolaHeightKm(distanceKm, cloudBaseKm, vertexKm) {
  return cloudBaseKm + (distanceKm * (distanceKm - 2 * vertexKm)) / (2 * EARTH_RADIUS_KM);
}

function samplePointScore(samplePoint, index, distanceKm, curveHeightKm) {
  const layers = makeLayerState(samplePoint, index);
  const cloudBase = estimateCloudBase(layers);
  const curveHumidity = interpolateHumidity(layers, curveHeightKm);
  const blocked = curveHumidity >= 80;

  const blockingLayers = layers.filter((layer) => layer.rh >= THRESHOLDS.cloudBlock.rh && layer.cloudCover >= THRESHOLDS.cloudBlock.cloudCover);
  const blockStrength = blockingLayers.reduce((sum, layer) => sum + layer.cloudCover / 100, 0);
  const clearFactor = clamp((80 - curveHumidity) / 80, 0, 1);
  const layerFactor = clamp(1 - blockStrength * 0.55, 0, 1);

  const rawScore = clearFactor * layerFactor;

  return {
    score: rawScore,
    cloudBaseKm: cloudBase.cloudBaseKm,
    cloudBaseSource: cloudBase.source,
    curveHeightKm,
    curveHumidity,
    blocked,
    humidityMargin: 80 - curveHumidity,
    layers,
    cloudLow: layers.find((s) => s.level === 1000)?.cloudCover ?? 0,
    cloudMid: layers.find((s) => s.level === 700)?.cloudCover ?? 0,
    cloudHigh: layers.find((s) => s.level === 500)?.cloudCover ?? 0,
  };
}

function evaluateEventAtHour({ city, baseWeather, sampleData, index, eventType, eventTime }) {
  const hourly = baseWeather.hourly;
  const localTime = parseForecastTime(hourly.time[index]);
  const deltaMinutes = (localTime.getTime() - eventTime.getTime()) / 60000;
  const tf = timeFactor(deltaMinutes);
  if (tf <= 0) {
    return {
      score: 0,
      eventType,
      eventTime: eventTime.toISOString(),
      deltaT: deltaMinutes * 60,
      outsideWindow: true,
    };
  }

  const sunPos = SunCalc.getPosition(eventTime, city.lat, city.lon);
  const sunAltitudeDeg = sunPos.altitude * 180 / Math.PI;
  const localLayers = makeLayerState(sampleData.local, index);
  const cloudBase = estimateCloudBase(localLayers);
  const cloudBaseKm = cloudBase.cloudBaseKm;
  const vertexKm = parabolaVertexKm(cloudBaseKm);

  const pathProfile = sampleData[eventType].map((pt, pIdx) => {
    const distanceKm = SAMPLE_DISTANCES_KM[pIdx];
    const curveHeightKm = parabolaHeightKm(distanceKm, cloudBaseKm, vertexKm);
    const sample = samplePointScore(pt, index, distanceKm, curveHeightKm);
    return {
      distanceKm,
      curveHeightKm,
      vertexKm,
      ...sample,
    };
  });

  const blockedCount = pathProfile.filter((point) => point.blocked).length;
  const blockedRatio = blockedCount / Math.max(pathProfile.length, 1);
  const meanClear = pathProfile.reduce((sum, point) => sum + clamp((80 - point.curveHumidity) / 80, 0, 1), 0) / Math.max(pathProfile.length, 1);
  const bestClearPoints = [...pathProfile].sort((a, b) => b.score - a.score).slice(0, 3);
  const pathScore = bestClearPoints.reduce((sum, point) => sum + point.score, 0) / Math.max(bestClearPoints.length, 1);
  const aod = hourly.aerosol_optical_depth?.[index] ?? 0.2;
  const clarity = aodClarity(aod);
  const finalScore = clamp((0.65 * meanClear + 0.35 * pathScore) * (1 - blockedRatio * 0.95) * tf * clarity * 5.0, 0, 5);

  const dominantLayer = localLayers
    .filter((layer) => layer.rh >= THRESHOLDS.cloudBlock.rh)
    .sort((a, b) => a.heightKm - b.heightKm)[0] ?? null;

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
    lowBlock: blockedRatio * 100,
    rawScore: pathScore,
    coverage: 1 - blockedRatio,
    pathMean: meanClear,
    dominantLayer: {
      layer: dominantLayer == null ? cloudBase.source : dominantLayer.level >= 700 ? 'low-mid' : 'high',
      pressureLevel: dominantLayer?.level ?? null,
      heightKm: cloudBaseKm ?? null,
    },
    cloudBaseSource: cloudBase.source,
    sunAltitudeDeg,
    vertexKm,
    blockedCount,
    blockedRatio,
    pathProfile,
    strict: {
      algorithm: 'parabola-rh80-v2',
      samplePoints: SAMPLE_DISTANCES_KM.length,
      pathDistancesKm: SAMPLE_DISTANCES_KM,
      rhThreshold: 80,
    },
  };
}

function buildStrictForecast(city, baseWeather, sampleData) {
  const hourly = baseWeather.hourly;
  if (!hourly?.time?.length) return { series: [], daily: [], best: null };

  const hourlyTimes = hourly.time.map((t) => parseForecastTime(t));
  const uniqueDays = [];
  const seenDays = new Set();
  for (const time of hourlyTimes) {
    const day = localDayKey(time);
    if (!seenDays.has(day)) {
      seenDays.add(day);
      uniqueDays.push({ day, anchor: time });
    }
  }

  const findNearestIndex = (targetTime) => {
    let bestIndex = 0;
    let bestGap = Number.POSITIVE_INFINITY;
    for (let i = 0; i < hourlyTimes.length; i += 1) {
      const gap = Math.abs(hourlyTimes[i].getTime() - targetTime.getTime());
      if (gap < bestGap) {
        bestGap = gap;
        bestIndex = i;
      }
    }
    return bestIndex;
  };

  const series = [];

  for (const { day } of uniqueDays) {
    const eventBase = new Date(`${day}T12:00:00+08:00`);
    const sunTimes = SunCalc.getTimes(eventBase, city.lat, city.lon);

    for (const eventType of ['sunrise', 'sunset']) {
      const eventTime = sunTimes[eventType];
      if (!eventTime || Number.isNaN(eventTime.getTime())) continue;
      const index = findNearestIndex(eventTime);
      const eventDetail = evaluateEventAtHour({
        city,
        baseWeather,
        sampleData,
        index,
        eventType,
        eventTime,
      });

      series.push({
        day,
        eventType,
        time: eventTime.toISOString(),
        score: eventDetail?.score ?? 0,
        detail: eventDetail,
        cloudLow: hourly.cloud_cover_low?.[index] ?? 0,
        cloudMid: hourly.cloud_cover_mid?.[index] ?? 0,
        cloudHigh: hourly.cloud_cover_high?.[index] ?? 0,
        aod: hourly.aerosol_optical_depth?.[index] ?? 0.2,
      });
    }
  }

  const daily = uniqueDays.map(({ day }) => {
    const sunrise = series.find((item) => item.day === day && item.eventType === 'sunrise') ?? null;
    const sunset = series.find((item) => item.day === day && item.eventType === 'sunset') ?? null;
    const best = [sunrise, sunset].filter(Boolean).sort((a, b) => b.score - a.score)[0] ?? null;
    return { date: day, sunset, sunrise, best };
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

  const [local, sunriseData, sunsetData] = await Promise.all([
    fetchPressurePoint(city),
    runWithLimit(sunrisePoints, 2, fetchPressurePoint),
    runWithLimit(sunsetPoints, 2, fetchPressurePoint),
  ]);

  return {
    local,
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
    const fallback = previousPayload?.cities?.find((item) => item.id === city.id);
    if (fallback) {
      return {
        ...fallback,
        source: 'cache-fallback',
        error: String(error),
      };
    }

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

async function runBatched(items, limit, batchSize, pauseMs, worker) {
  const results = [];
  for (let start = 0; start < items.length; start += batchSize) {
    const batch = items.slice(start, start + batchSize);
    const batchResults = await runWithLimit(batch, limit, worker);
    results.push(...batchResults);
    if (start + batchSize < items.length) {
      await sleep(pauseMs);
    }
  }
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

const cities = await runBatched(CITIES, CONCURRENCY, 4, 4000, fetchCity);

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
