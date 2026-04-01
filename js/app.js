/**
 * SunsetWhisper – Main Application
 *
 * Fetches GFS data via Open-Meteo, computes fire-cloud scores for all cities,
 * renders a Leaflet map, and displays city detail panels with Chart.js charts.
 *
 * Data is cached in localStorage for 6 hours to align with GFS update cycles.
 */

'use strict';

// ──────────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────────
const CACHE_TTL_MS   = 6 * 60 * 60 * 1000; // 6 hours
const CACHE_KEY      = 'sw_cache_v3';
const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/gfs';
const AIR_QUALITY_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';

// GFS hourly variables to request
const WEATHER_VARS = [
  'cloud_cover',
  'cloud_cover_low',
  'cloud_cover_mid',
  'cloud_cover_high',
].join(',');

const AIR_QUALITY_VARS = 'aerosol_optical_depth';

// ──────────────────────────────────────────────────────────────────────────────
// State
// ──────────────────────────────────────────────────────────────────────────────
let map;
let cityMarkers = {};
let selectedCityId = null;
let cityScores = {};    // { cityId: Array<scoreEntry> }
let chartInstance = null;
let refreshTimer = null;

// ──────────────────────────────────────────────────────────────────────────────
// Map initialisation
// ──────────────────────────────────────────────────────────────────────────────
function initMap() {
  map = L.map('map', {
    center: [35.5, 103],
    zoom: 4,
    zoomControl: true,
    attributionControl: true,
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution:
      '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 18,
  }).addTo(map);
}

// ──────────────────────────────────────────────────────────────────────────────
// Marker helpers
// ──────────────────────────────────────────────────────────────────────────────
function createCityIcon(score) {
  const color   = scoreToColor(score);
  const { label } = scoreLabel(score);
  const size    = score > 2 ? 38 : 32;
  const html    = `
    <div class="city-marker" style="background:${color};width:${size}px;height:${size}px">
      <span class="marker-label">${label}</span>
    </div>`;
  return L.divIcon({ html, className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
}

function renderMarkers() {
  // Remove old markers
  Object.values(cityMarkers).forEach(m => map.removeLayer(m));
  cityMarkers = {};

  const now = new Date();

  CITIES.forEach(city => {
    const series = cityScores[city.id];
    if (!series) return;

    // Find the score for the nearest upcoming event (within 3 hours)
    const upcoming = getUpcomingScore(series, now);
    const score    = upcoming ? upcoming.score : 0;

    const marker = L.marker([city.lat, city.lon], {
      icon: createCityIcon(score),
      title: city.name,
    });

    marker.on('click', () => selectCity(city.id));

    marker.bindTooltip(
      `<b>${city.name}</b><br>鲜艳度 ${score.toFixed(2)} — ${scoreLabel(score).label}`,
      { direction: 'top', offset: [0, -10] }
    );

    marker.addTo(map);
    cityMarkers[city.id] = marker;
  });
}

/**
 * Get the peak score entry closest to now (within 3-hour window).
 */
function getUpcomingScore(series, now) {
  const windowMs = 3 * 60 * 60 * 1000;
  let best = null;
  for (const entry of series) {
    const diff = entry.time - now;
    if (diff > -windowMs && diff < windowMs) {
      if (!best || entry.score > best.score) best = entry;
    }
  }
  return best;
}

// ──────────────────────────────────────────────────────────────────────────────
// Data fetching
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Load from localStorage cache if fresh, else fetch from API.
 */
async function loadAllCities() {
  const cached = loadCache();
  if (cached) {
    console.log('[SunsetWhisper] Using cached data from', new Date(cached.ts).toLocaleString());
    processAllCachedData(cached.data);
    updateDataInfo(new Date(cached.ts));
    return;
  }

  await fetchAllCities();
}

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (Date.now() - obj.ts > CACHE_TTL_MS) return null;
    return obj;
  } catch (e) {
    return null;
  }
}

function saveCache(data) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
  } catch (e) {
    console.warn('[SunsetWhisper] Cache write failed:', e);
  }
}

async function fetchAllCities() {
  showLoading(true);
  const rawData = {};

  // Fetch in small batches to avoid rate limits
  const BATCH = 8;
  for (let i = 0; i < CITIES.length; i += BATCH) {
    const batch = CITIES.slice(i, i + BATCH);
    await Promise.all(batch.map(async city => {
      try {
        rawData[city.id] = await fetchCityData(city);
      } catch (err) {
        console.warn(`[SunsetWhisper] Failed to fetch ${city.name}:`, err);
        rawData[city.id] = null;
      }
    }));
    updateProgress(Math.min(i + BATCH, CITIES.length), CITIES.length);
  }

  saveCache(rawData);
  processAllCachedData(rawData);
  updateDataInfo(new Date());
  showLoading(false);
}

async function fetchCityData(city) {
  const params = new URLSearchParams({
    latitude:  city.lat,
    longitude: city.lon,
    hourly:    WEATHER_VARS,
    timezone:  'Asia/Shanghai',
    forecast_days: 3,
  });

  const aqParams = new URLSearchParams({
    latitude:  city.lat,
    longitude: city.lon,
    hourly:    AIR_QUALITY_VARS,
    timezone:  'Asia/Shanghai',
    forecast_days: 3,
  });

  const [wxResp, aqResp] = await Promise.all([
    fetch(`${OPEN_METEO_URL}?${params}`),
    fetch(`${AIR_QUALITY_URL}?${aqParams}`).catch(() => null),
  ]);

  const wx = await wxResp.json();
  const aq = aqResp ? await aqResp.json().catch(() => null) : null;

  // Merge aerosol data into weather hourly
  if (aq?.hourly?.aerosol_optical_depth && wx.hourly) {
    wx.hourly.aerosol_optical_depth = aq.hourly.aerosol_optical_depth;
  }

  return wx;
}

function processAllCachedData(rawData) {
  cityScores = {};
  CITIES.forEach(city => {
    if (rawData[city.id]) {
      cityScores[city.id] = buildScoreTimeSeries(city, rawData[city.id]);
    }
  });
  renderMarkers();
  if (selectedCityId) renderCityPanel(selectedCityId);
  updateCityList();
}

// ──────────────────────────────────────────────────────────────────────────────
// City panel
// ──────────────────────────────────────────────────────────────────────────────
function selectCity(cityId) {
  selectedCityId = cityId;
  renderCityPanel(cityId);
  document.getElementById('city-panel').classList.remove('hidden');
}

function renderCityPanel(cityId) {
  const city   = CITIES.find(c => c.id === cityId);
  const series = cityScores[cityId];
  if (!city || !series) return;

  const now      = new Date();
  const upcoming = getUpcomingScore(series, now);
  const score    = upcoming ? upcoming.score : 0;
  const { label, css } = scoreLabel(score);

  document.getElementById('panel-city-name').textContent = city.name + ' · ' + city.province;
  document.getElementById('panel-score-value').textContent = score.toFixed(2);
  document.getElementById('panel-score-label').textContent = label;
  document.getElementById('panel-score-label').className   = 'score-badge ' + css;

  if (upcoming?.detail) {
    const d = upcoming.detail;
    document.getElementById('panel-cloud-low').textContent  = (d.cloudLow  ?? '--') + '%';
    document.getElementById('panel-cloud-mid').textContent  = (d.cloudMid  ?? '--') + '%';
    document.getElementById('panel-cloud-high').textContent = (d.cloudHigh ?? '--') + '%';
    document.getElementById('panel-aod').textContent        = (d.aod != null ? d.aod.toFixed(3) : '--');
    document.getElementById('panel-aod-label').textContent  = d.aod != null ? aodLabel(d.aod) : '';

    const sunTimes = SunCalc.getTimes(now, city.lat, city.lon);
    document.getElementById('panel-sunset').textContent  = formatLocalTime(sunTimes.sunset);
    document.getElementById('panel-sunrise').textContent = formatLocalTime(sunTimes.sunrise);
  }

  renderChart(city, series);
}

function formatLocalTime(date) {
  if (!date || isNaN(date.getTime())) return '--';
  return date.toLocaleTimeString('zh-CN', {
    hour:   '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Shanghai',
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Chart
// ──────────────────────────────────────────────────────────────────────────────
function renderChart(city, series) {
  const ctx = document.getElementById('forecast-chart').getContext('2d');
  if (chartInstance) chartInstance.destroy();

  // Show 48h window starting from 12h ago
  const now       = new Date();
  const startTime = new Date(now.getTime() - 12 * 3600 * 1000);
  const endTime   = new Date(now.getTime() + 36 * 3600 * 1000);

  const filtered = series.filter(e => e.time >= startTime && e.time <= endTime);

  const labels       = filtered.map(e => formatAxisTime(e.time));
  const ssScores     = filtered.map(e => e.sunsetScore.toFixed(2));
  const srScores     = filtered.map(e => e.sunriseScore.toFixed(2));
  const cloudLows    = filtered.map(e => e.cloudLow);
  const cloudHighs   = filtered.map(e => e.cloudHigh);

  chartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: '晚霞鲜艳度',
          data:  ssScores,
          borderColor: '#ff6b35',
          backgroundColor: 'rgba(255,107,53,0.12)',
          borderWidth: 2,
          tension: 0.3,
          fill: true,
          yAxisID: 'yScore',
          pointRadius: 2,
        },
        {
          label: '朝霞鲜艳度',
          data:  srScores,
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
          data:  cloudLows,
          borderColor: '#90caf9',
          backgroundColor: 'rgba(144,202,249,0.0)',
          borderWidth: 1,
          borderDash: [3, 3],
          tension: 0.2,
          yAxisID: 'yCloud',
          pointRadius: 0,
        },
        {
          label: '高云量 %',
          data:  cloudHighs,
          borderColor: '#ce93d8',
          backgroundColor: 'rgba(206,147,216,0.0)',
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
        legend: { labels: { color: '#ccc', font: { size: 11 } } },
        tooltip: {
          callbacks: {
            title: items => items[0].label,
          },
        },
      },
      scales: {
        x: {
          ticks: { color: '#aaa', maxTicksLimit: 12, maxRotation: 0 },
          grid:  { color: 'rgba(255,255,255,0.05)' },
        },
        yScore: {
          position: 'left',
          min: 0,
          max: 5,
          title: { display: true, text: '鲜艳度 (0–5)', color: '#aaa', font: { size: 11 } },
          ticks: { color: '#aaa' },
          grid:  { color: 'rgba(255,255,255,0.07)' },
        },
        yCloud: {
          position: 'right',
          min: 0,
          max: 100,
          title: { display: true, text: '云量 %', color: '#aaa', font: { size: 11 } },
          ticks: { color: '#aaa' },
          grid:  { drawOnChartArea: false },
        },
      },
    },
  });
}

function formatAxisTime(date) {
  return date.toLocaleString('zh-CN', {
    month:   'numeric',
    day:     'numeric',
    hour:    '2-digit',
    minute:  '2-digit',
    timeZone: 'Asia/Shanghai',
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// City list sidebar
// ──────────────────────────────────────────────────────────────────────────────
function updateCityList() {
  const list = document.getElementById('city-list');
  if (!list) return;

  const now = new Date();

  const ranked = CITIES.map(city => {
    const series   = cityScores[city.id];
    const upcoming = series ? getUpcomingScore(series, now) : null;
    return { city, score: upcoming ? upcoming.score : 0 };
  }).sort((a, b) => b.score - a.score);

  list.innerHTML = ranked.map(({ city, score }) => {
    const { label, css } = scoreLabel(score);
    return `
      <div class="city-list-item" data-id="${city.id}">
        <span class="city-list-name">${city.name}</span>
        <span class="score-badge ${css} small">${label} ${score.toFixed(1)}</span>
      </div>`;
  }).join('');

  list.querySelectorAll('.city-list-item').forEach(el => {
    el.addEventListener('click', () => {
      const cityId = el.dataset.id;
      selectCity(cityId);
      const city = CITIES.find(c => c.id === cityId);
      if (city) map.setView([city.lat, city.lon], 7, { animate: true });
    });
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// UI helpers
// ──────────────────────────────────────────────────────────────────────────────
function showLoading(show) {
  const el = document.getElementById('loading-overlay');
  if (el) el.style.display = show ? 'flex' : 'none';
}

function updateProgress(done, total) {
  const el = document.getElementById('loading-text');
  if (el) el.textContent = `正在获取数据 ${done}/${total} 个城市…`;
}

function updateDataInfo(ts) {
  const el = document.getElementById('data-info');
  if (el) {
    el.textContent = `GFS 数据时次：${ts.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} · 每6小时自动刷新`;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Auto-refresh
// ──────────────────────────────────────────────────────────────────────────────
function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    localStorage.removeItem(CACHE_KEY);
    await loadAllCities();
    scheduleRefresh();
  }, CACHE_TTL_MS);
}

// ──────────────────────────────────────────────────────────────────────────────
// Event listeners
// ──────────────────────────────────────────────────────────────────────────────
function bindEvents() {
  document.getElementById('btn-close-panel')?.addEventListener('click', () => {
    document.getElementById('city-panel').classList.add('hidden');
    selectedCityId = null;
  });

  document.getElementById('btn-refresh')?.addEventListener('click', async () => {
    localStorage.removeItem(CACHE_KEY);
    await loadAllCities();
  });

  document.getElementById('btn-toggle-list')?.addEventListener('click', () => {
    document.getElementById('city-sidebar').classList.toggle('open');
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────────────────────────────────────────
async function main() {
  initMap();
  bindEvents();
  await loadAllCities();
  scheduleRefresh();
}

document.addEventListener('DOMContentLoaded', main);
