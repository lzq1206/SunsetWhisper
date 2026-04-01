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
const WEATHER_VARS = ['cloud_cover', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high'].join(',');
const AIR_QUALITY_VARS = 'aerosol_optical_depth';
const CONCURRENCY = 6;

globalThis.SunCalc = SunCalc;

const { CITIES } = await import('../js/cities.js');
const { buildCityForecast } = await import('../js/forecast-core.js');

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
      if (attempt < retries) await sleep(1000 * (attempt + 1));
    }
  }
  throw lastError;
}

async function fetchCity(city) {
  try {
    const weatherParams = new URLSearchParams({
      latitude: city.lat,
      longitude: city.lon,
      hourly: WEATHER_VARS,
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

    const forecast = buildCityForecast(city, weather);
    const best = forecast.best;
    return {
      id: city.id,
      name: city.name,
      lat: city.lat,
      lon: city.lon,
      province: city.province,
      region: city.region,
      forecast,
      source: 'open-meteo-gfs',
      bestScore: best?.score ?? 0,
      bestEventType: best?.detail?.eventType ?? null,
      bestEventTime: best?.detail?.eventTime ?? null,
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
  source: 'open-meteo-gfs',
  tutorial: 'https://www.sunsetbot.top/halo/posts/2026/huo-shao-yun-yu-bao-jiao-cheng-zhang-jie-yi/',
  cities,
};

await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
await fs.writeFile(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
console.log(`Wrote ${OUT_PATH}`);
