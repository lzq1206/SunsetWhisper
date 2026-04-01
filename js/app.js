import { CITIES, CITY_LOOKUP } from './cities.js';
import {
  buildCityForecast,
  scoreLabel,
  scoreToColor,
  aodLabel,
  formatTime,
  formatAxisTime,
  formatDate,
} from './forecast-core.js';

'use strict';

const STATIC_DATA_URL = './data/latest.json';
const CACHE_KEY = 'sunsetwhisper.static-cache.v2';
const CACHE_TTL_MS = 3 * 60 * 60 * 1000;
const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/gfs';
const AIR_QUALITY_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const WEATHER_VARS = ['cloud_cover', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high'].join(',');
const AIR_QUALITY_VARS = 'aerosol_optical_depth';

let map = null;
let chartInstance = null;
let cityMarkers = {};
let selectedCityId = null;
let cityStates = [];
let refreshTimer = null;

function setLoading(show, text = '正在获取 GFS 分层数据…') {
  const overlay = document.getElementById('loading-overlay');
  const label = document.getElementById('loading-text');
  if (overlay) overlay.style.display = show ? 'flex' : 'none';
  if (label) label.textContent = text;
}

function updateDataInfo(payload) {
  const info = document.getElementById('data-info');
  const hero = document.getElementById('hero-data-ts');
  const generatedAt = payload?.generatedAt ? new Date(payload.generatedAt) : new Date();
  const text = `数据时次：${generatedAt.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} · 每日自动更新`;
  if (info) info.textContent = text;
  if (hero) hero.textContent = generatedAt.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

function initMap() {
  map = L.map('map', {
    center: [35.5, 103],
    zoom: 4,
    zoomControl: true,
    attributionControl: true,
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 18,
  }).addTo(map);
}

function createCityIcon(score) {
  const { label } = scoreLabel(score);
  const color = scoreToColor(score);
  const size = score >= 3 ? 40 : 32;
  return L.divIcon({
    html: `<div class="city-marker" style="background:${color};width:${size}px;height:${size}px"><span class="marker-label">${label}</span></div>`,
    className: '',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function bestEventLabel(entry) {
  if (!entry) return '—';
  const { label } = scoreLabel(entry.score);
  const when = entry.detail?.eventType === 'sunrise' ? '朝霞' : '晚霞';
  return `${when} · ${label} ${entry.score.toFixed(2)}`;
}

function pressureLevelLabel(level) {
  if (level >= 1000) return '近地层';
  if (level >= 925) return '低层';
  if (level >= 850) return '低层';
  if (level >= 700) return '中层';
  if (level >= 600) return '中层';
  if (level >= 500) return '高层';
  return '高层';
}

function pressureLevelColor(level, cloudCover) {
  const opacity = Math.max(0.08, Math.min(0.9, (cloudCover ?? 0) / 100));
  const palette = {
    1000: `rgba(96, 165, 250, ${opacity})`,
    925: `rgba(56, 189, 248, ${opacity})`,
    850: `rgba(34, 211, 238, ${opacity})`,
    700: `rgba(251, 146, 60, ${opacity})`,
    600: `rgba(249, 115, 22, ${opacity})`,
    500: `rgba(192, 132, 252, ${opacity})`,
    400: `rgba(236, 72, 153, ${opacity})`,
  };
  return palette[level] ?? `rgba(148, 163, 184, ${opacity})`;
}

function renderPathDiagram(city) {
  const root = document.getElementById('panel-path-diagram');
  const meta = document.getElementById('panel-path-meta');
  if (!root || !meta || !city) return;

  const best = city.forecast.best;
  const detail = best?.detail;
  const profile = detail?.pathProfile ?? [];

  if (!detail || !profile.length) {
    meta.textContent = '暂无可用的光路剖面数据。';
    root.innerHTML = '<div class="path-empty">暂无光路数据</div>';
    return;
  }

  const eventName = detail.eventType === 'sunrise' ? '朝霞' : '晚霞';
  const bearing = city.strictMeta?.[detail.eventType === 'sunrise' ? 'sunriseBearing' : 'sunsetBearing'];
  meta.textContent = `${eventName}光路 · 方位角 ${bearing?.toFixed(1) ?? '—'}° · 采样 ${profile.length} 点 · 主导层 ${detail.dominantLayer?.pressureLevel ?? '—'} hPa`;

  const width = 780;
  const height = 280;
  const padL = 58;
  const padR = 18;
  const padT = 16;
  const padB = 32;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const bandLevels = [1000, 925, 850, 700, 600, 500, 400];
  const bandH = plotH / bandLevels.length;
  const maxDist = Math.max(...profile.map((p) => p.distanceKm));
  const xFor = (d) => padL + (d / maxDist) * plotW;
  const yFor = (km) => padT + plotH - Math.min(Math.max(km, 0), 10) / 10 * plotH;
  const originY = padT + plotH + 2;
  const originX = padL - 6;

  const rects = [];
  const rayPoints = [];

  profile.forEach((point, idx) => {
    const x = xFor(point.distanceKm);
    const cellW = profile.length === 1 ? plotW : plotW / (profile.length - 1) * 0.72;
    point.layers.forEach((layer, layerIdx) => {
      const y = padT + layerIdx * bandH;
      rects.push(`
        <rect x="${(x - cellW / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${cellW.toFixed(1)}" height="${bandH.toFixed(1)}" fill="${pressureLevelColor(layer.level, layer.cloudCover)}" opacity="${layer.hasCloud ? 1 : 0.18}"></rect>
      `);
    });
    const rayY = yFor(point.cloudBaseKm ?? 0.35);
    rayPoints.push(`${x.toFixed(1)},${rayY.toFixed(1)}`);
  });

  const rayLine = `<polyline class="path-ray" points="${rayPoints.join(' ')}"></polyline>`;
  const origin = `<circle class="path-origin" cx="${originX}" cy="${originY}" r="5"></circle><text x="${originX + 10}" y="${originY + 4}" class="path-axis-label">城市</text>`;
  const xLabels = profile.map((point) => `<text x="${xFor(point.distanceKm).toFixed(1)}" y="${height - 10}" text-anchor="middle" class="path-axis-label">${point.distanceKm} km</text>`).join('');
  const bandLabels = bandLevels.map((level, idx) => {
    const y = padT + idx * bandH + bandH / 2 + 3;
    return `<text x="12" y="${y.toFixed(1)}" class="path-band-label">${level}hPa</text>`;
  }).join('');

  const topSummary = profile.slice(0, 4).map((point) => {
    const d = point.distanceKm.toFixed(0);
    const dom = point.dominantLevel ? `${point.dominantLevel}hPa` : '—';
    const sc = point.score.toFixed(2);
    return `${d}km ${dom} ${sc}`;
  }).join(' · ');

  root.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" class="path-svg" role="img" aria-label="光路分层剖面">
      <rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" rx="10" fill="rgba(255,255,255,0.02)" stroke="rgba(255,255,255,0.06)"></rect>
      ${bandLabels}
      ${rects.join('')}
      ${rayLine}
      ${origin}
      ${xLabels}
    </svg>
    <div class="path-empty" style="margin-top:8px">${topSummary}</div>
  `;
}

function hydrateCityStates(payload) {
  cityStates = (payload?.cities ?? []).map((city) => {
    const base = CITY_LOOKUP[city.id] ?? city;
    const forecast = city.forecast ?? buildCityForecast(base, city.rawWeather);
    return {
      ...base,
      forecast,
      rawWeather: city.rawWeather,
      source: city.source ?? 'static',
    };
  });
}

function getCityState(cityId) {
  return cityStates.find((city) => city.id === cityId) ?? null;
}

function renderHero() {
  const today = cityStates
    .map((city) => ({ city, best: city.forecast.best }))
    .filter(({ best }) => best)
    .sort((a, b) => b.best.score - a.best.score);

  const topSunset = today.find(({ best }) => best.detail?.eventType === 'sunset') ?? today[0] ?? null;
  const topSunrise = today.find(({ best }) => best.detail?.eventType === 'sunrise') ?? today[0] ?? null;

  const sunsetCity = document.getElementById('hero-sunset-city');
  const sunsetMeta = document.getElementById('hero-sunset-meta');
  const sunriseCity = document.getElementById('hero-sunrise-city');
  const sunriseMeta = document.getElementById('hero-sunrise-meta');

  if (topSunset) {
    sunsetCity.textContent = topSunset.city.name;
    sunsetMeta.textContent = `${bestEventLabel(topSunset.best)} · ${formatTime(topSunset.best.detail?.eventTime)}`;
  }
  if (topSunrise) {
    sunriseCity.textContent = topSunrise.city.name;
    sunriseMeta.textContent = `${bestEventLabel(topSunrise.best)} · ${formatTime(topSunrise.best.detail?.eventTime)}`;
  }
}

function renderMarkers() {
  Object.values(cityMarkers).forEach((marker) => map.removeLayer(marker));
  cityMarkers = {};

  cityStates.forEach((city) => {
    const score = city.forecast.best?.score ?? 0;
    const marker = L.marker([city.lat, city.lon], {
      icon: createCityIcon(score),
      title: city.name,
    });
    marker.on('click', () => selectCity(city.id));
    marker.bindTooltip(
      `<b>${city.name}</b><br>${bestEventLabel(city.forecast.best)}`,
      { direction: 'top', offset: [0, -10] },
    );
    marker.addTo(map);
    cityMarkers[city.id] = marker;
  });
}

function renderCityList() {
  const list = document.getElementById('city-list');
  if (!list) return;

  const ranked = [...cityStates].sort((a, b) => (b.forecast.best?.score ?? 0) - (a.forecast.best?.score ?? 0));
  list.innerHTML = ranked.map((city) => {
    const best = city.forecast.best;
    const { label, css } = scoreLabel(best?.score ?? 0);
    const eventType = best?.detail?.eventType === 'sunrise' ? '朝霞' : '晚霞';
    return `
      <button class="city-list-item" data-id="${city.id}">
        <span class="city-list-name">
          <strong>${city.name}</strong>
          <span>${city.province} · ${eventType}</span>
        </span>
        <span class="score-badge ${css} small">${label} ${(best?.score ?? 0).toFixed(1)}</span>
      </button>
    `;
  }).join('');

  list.querySelectorAll('.city-list-item').forEach((el) => {
    el.addEventListener('click', () => {
      const cityId = el.dataset.id;
      selectCity(cityId);
      const city = getCityState(cityId);
      if (city) map.setView([city.lat, city.lon], Math.max(map.getZoom(), 6), { animate: true });
    });
  });
}

function renderDailyList(city) {
  const root = document.getElementById('panel-daily-list');
  if (!root || !city) return;

  root.innerHTML = city.forecast.daily.slice(0, 3).map((day) => {
    const best = day.best;
    const sunset = day.sunset;
    const sunrise = day.sunrise;
    const bestLabel = best ? `${best.detail?.eventType === 'sunrise' ? '朝霞' : '晚霞'} ${best.score.toFixed(2)}` : '—';
    const sunriseScore = sunrise?.score ?? 0;
    const sunsetScore = sunset?.score ?? 0;
    return `
      <div class="daily-card">
        <div class="daily-head">
          <strong>${formatDate(day.date)}</strong>
          <span class="score-badge ${scoreLabel(best?.score ?? 0).css} small">${bestLabel}</span>
        </div>
        <div class="daily-grid">
          <div><span>日出</span><b>${formatTime(sunrise?.detail?.eventTime)}</b><small>${sunriseScore.toFixed(2)}</small></div>
          <div><span>日落</span><b>${formatTime(sunset?.detail?.eventTime)}</b><small>${sunsetScore.toFixed(2)}</small></div>
        </div>
      </div>
    `;
  }).join('');
}

function renderChart(city) {
  const canvas = document.getElementById('forecast-chart');
  if (!canvas || !city) return;
  const ctx = canvas.getContext('2d');
  if (chartInstance) chartInstance.destroy();

  const now = new Date();
  const startTime = new Date(now.getTime() - 12 * 60 * 60 * 1000);
  const endTime = new Date(now.getTime() + 36 * 60 * 60 * 1000);
  const filtered = city.forecast.series.filter((entry) => {
    const time = new Date(entry.time);
    return time >= startTime && time <= endTime;
  });

  chartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: filtered.map((entry) => formatAxisTime(entry.time)),
      datasets: [
        {
          label: '晚霞',
          data: filtered.map((entry) => entry.sunsetScore.toFixed(2)),
          borderColor: '#ff6b35',
          backgroundColor: 'rgba(255,107,53,0.12)',
          borderWidth: 2,
          tension: 0.3,
          fill: true,
          yAxisID: 'yScore',
          pointRadius: 2,
        },
        {
          label: '朝霞',
          data: filtered.map((entry) => entry.sunriseScore.toFixed(2)),
          borderColor: '#f7c59f',
          backgroundColor: 'rgba(247,197,159,0.10)',
          borderWidth: 2,
          tension: 0.3,
          fill: true,
          yAxisID: 'yScore',
          pointRadius: 2,
        },
        {
          label: '低云量 %',
          data: filtered.map((entry) => entry.cloudLow),
          borderColor: '#90caf9',
          borderWidth: 1,
          borderDash: [3, 3],
          tension: 0.2,
          yAxisID: 'yCloud',
          pointRadius: 0,
        },
        {
          label: '高云量 %',
          data: filtered.map((entry) => entry.cloudHigh),
          borderColor: '#ce93d8',
          borderWidth: 1,
          borderDash: [3, 3],
          tension: 0.2,
          yAxisID: 'yCloud',
          pointRadius: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#c8d1dc', font: { size: 11 } } },
        tooltip: { callbacks: { title: (items) => items[0].label } },
      },
      scales: {
        x: {
          ticks: { color: '#aab4c3', maxTicksLimit: 12, maxRotation: 0 },
          grid: { color: 'rgba(255,255,255,0.05)' },
        },
        yScore: {
          position: 'left',
          min: 0,
          max: 5,
          title: { display: true, text: '鲜艳度 (0–5)', color: '#aab4c3', font: { size: 11 } },
          ticks: { color: '#aab4c3' },
          grid: { color: 'rgba(255,255,255,0.07)' },
        },
        yCloud: {
          position: 'right',
          min: 0,
          max: 100,
          title: { display: true, text: '云量 %', color: '#aab4c3', font: { size: 11 } },
          ticks: { color: '#aab4c3' },
          grid: { drawOnChartArea: false },
        },
      },
    },
  });
}

function renderPanel(city) {
  if (!city) return;
  const best = city.forecast.best;
  const { label, css } = scoreLabel(best?.score ?? 0);

  document.getElementById('panel-city-name').textContent = city.name;
  document.getElementById('panel-city-subtitle').textContent = `${city.province} · ${city.region} · ${best?.detail?.eventType === 'sunrise' ? '朝霞优先' : '晚霞优先'}`;
  document.getElementById('panel-score-value').textContent = `${(best?.score ?? 0).toFixed(2)}`;
  const scoreLabelEl = document.getElementById('panel-score-label');
  scoreLabelEl.textContent = label;
  scoreLabelEl.className = `score-badge ${css}`;

  const eventTime = best?.detail?.eventTime;
  document.getElementById('panel-sunset').textContent = formatTime(city.forecast.daily[0]?.sunset?.detail?.eventTime);
  document.getElementById('panel-sunrise').textContent = formatTime(city.forecast.daily[0]?.sunrise?.detail?.eventTime);

  const dominant = best?.detail?.dominantLayer;
  const dominantText = dominant?.layer === 'low' ? '低云为主' : dominant?.layer === 'mid' ? '中云为主' : dominant?.layer === 'high' ? '高云为主' : '混合云';
  document.getElementById('panel-dominant-layer').textContent = `${dominantText} / ${dominant?.heightKm?.toFixed(1) ?? '—'} km`;
  const pathTitle = document.getElementById('panel-path-title');
  if (pathTitle) pathTitle.textContent = `${best?.detail?.eventType === 'sunrise' ? '朝霞' : '晚霞'}光路分层剖面`;
  document.getElementById('panel-aod').textContent = best?.detail?.aod != null ? best.detail.aod.toFixed(3) : '—';
  document.getElementById('panel-aod-label').textContent = aodLabel(best?.detail?.aod ?? 0);
  document.getElementById('panel-cloud-low').textContent = `${Math.round(best?.detail?.cloudLow ?? 0)}%`;
  document.getElementById('panel-cloud-mid').textContent = `${Math.round(best?.detail?.cloudMid ?? 0)}%`;
  document.getElementById('panel-cloud-high').textContent = `${Math.round(best?.detail?.cloudHigh ?? 0)}%`;

  renderPathDiagram(city);
  renderChart(city);
  renderDailyList(city);
}

function selectCity(cityId) {
  selectedCityId = cityId;
  const city = getCityState(cityId);
  if (!city) return;
  renderPanel(city);
  document.getElementById('city-panel')?.classList.remove('hidden');
}

function renderAll(payload) {
  hydrateCityStates(payload);
  renderHero();
  renderMarkers();
  renderCityList();
  updateDataInfo(payload);

  const ranked = [...cityStates].sort((a, b) => (b.forecast.best?.score ?? 0) - (a.forecast.best?.score ?? 0));
  const firstSunset = ranked.find((city) => city.forecast.best?.detail?.eventType === 'sunset') ?? ranked[0];
  const firstSunrise = ranked.find((city) => city.forecast.best?.detail?.eventType === 'sunrise') ?? ranked[0];

  if (firstSunset) {
    document.getElementById('hero-sunset-city').textContent = firstSunset.name;
    document.getElementById('hero-sunset-meta').textContent = `${bestEventLabel(firstSunset.forecast.best)} · ${firstSunset.province}`;
  }
  if (firstSunrise) {
    document.getElementById('hero-sunrise-city').textContent = firstSunrise.name;
    document.getElementById('hero-sunrise-meta').textContent = `${bestEventLabel(firstSunrise.forecast.best)} · ${firstSunrise.province}`;
  }

  if (selectedCityId) {
    const city = getCityState(selectedCityId);
    if (city) renderPanel(city);
  } else if (ranked[0]) {
    renderPanel(ranked[0]);
    selectedCityId = ranked[0].id;
    document.getElementById('city-panel')?.classList.remove('hidden');
  }
}

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.ts || Date.now() - parsed.ts > CACHE_TTL_MS) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

function saveCache(data) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
  } catch {
    // ignore
  }
}

async function loadStaticPayload() {
  const cached = loadCache();
  if (cached) return cached;

  const response = await fetch(`${STATIC_DATA_URL}?v=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`static payload ${response.status}`);
  const payload = await response.json();
  saveCache(payload);
  return payload;
}

async function fetchCityForecast(city) {
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

  const [weatherResponse, aqResponse] = await Promise.all([
    fetch(`${OPEN_METEO_URL}?${weatherParams}`),
    fetch(`${AIR_QUALITY_URL}?${aqParams}`).catch(() => null),
  ]);

  if (!weatherResponse.ok) throw new Error(`weather ${weatherResponse.status}`);
  const weather = await weatherResponse.json();
  const aq = aqResponse ? await aqResponse.json().catch(() => null) : null;

  if (aq?.hourly?.aerosol_optical_depth && weather?.hourly) {
    weather.hourly.aerosol_optical_depth = aq.hourly.aerosol_optical_depth;
  }

  const forecast = buildCityForecast(city, weather);
  return {
    ...city,
    forecast,
    rawWeather: weather,
    source: 'live',
  };
}

async function fetchLivePayload() {
  const tasks = CITIES.map((city) => fetchCityForecast(city).catch((error) => ({
    ...city,
    forecast: { series: [], daily: [], best: null },
    error: String(error),
    source: 'error',
  })));
  const cities = await Promise.all(tasks);
  return {
    generatedAt: new Date().toISOString(),
    source: 'live-open-meteo',
    cities,
  };
}

async function loadPayload() {
  try {
    return await loadStaticPayload();
  } catch (error) {
    console.warn('[SunsetWhisper] static payload unavailable, falling back to live API', error);
    return fetchLivePayload();
  }
}

function bindEvents() {
  document.getElementById('btn-close-panel')?.addEventListener('click', () => {
    document.getElementById('city-panel')?.classList.add('hidden');
    selectedCityId = null;
  });

  document.getElementById('btn-refresh')?.addEventListener('click', async () => {
    localStorage.removeItem(CACHE_KEY);
    setLoading(true, '正在重新拉取数据…');
    const payload = await loadPayload();
    renderAll(payload);
    setLoading(false);
  });

  document.getElementById('btn-toggle-list')?.addEventListener('click', () => {
    document.getElementById('city-sidebar')?.classList.toggle('open');
  });
}

function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    localStorage.removeItem(CACHE_KEY);
    const payload = await loadPayload();
    renderAll(payload);
    scheduleRefresh();
  }, CACHE_TTL_MS);
}

async function main() {
  initMap();
  bindEvents();
  setLoading(true, '正在获取 GFS 分层数据…');
  const payload = await loadPayload();
  renderAll(payload);
  setLoading(false);
  scheduleRefresh();
}

document.addEventListener('DOMContentLoaded', main);
