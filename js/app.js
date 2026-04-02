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
const CACHE_KEY = 'sunsetwhisper.static-cache.v5';
const CACHE_TTL_MS = 3 * 60 * 60 * 1000;
const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/gfs';
const AIR_QUALITY_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const WEATHER_VARS = ['cloud_cover', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high'].join(',');
const AIR_QUALITY_VARS = 'aerosol_optical_depth';

const EVENT_ORDER = ['sunset', 'sunrise'];

let maps = { sunset: null, sunrise: null };
let mapMarkers = { sunset: {}, sunrise: {} };
let chartInstance = null;
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

function initEventMap(containerId) {
  const map = L.map(containerId, {
    center: [35.5, 103],
    zoom: 4,
    zoomControl: true,
    attributionControl: true,
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 18,
  }).addTo(map);

  return map;
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

function getEventEntry(city, eventType) {
  const day = city.forecast?.daily?.[0];
  const eventEntry = day?.[eventType] ?? null;
  if (eventEntry) return eventEntry;
  return city.forecast?.series?.find((entry) => entry.eventType === eventType) ?? null;
}

function getMapMetaText(entry) {
  if (!entry) return '暂无数据';
  const eventName = entry.eventType === 'sunrise' ? '朝霞' : '晚霞';
  const score = scoreLabel(entry.score).label;
  return `${eventName} · ${score} ${(entry.score ?? 0).toFixed(2)}`;
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

function pressureLevelColor(level, rh) {
  const humidity = rh ?? 0;
  if (humidity < 80) return 'rgba(160, 160, 160, 0.04)';
  const t = Math.min(1, Math.max(0, (humidity - 80) / 20));
  const gray = Math.round(160 + (255 - 160) * t);
  const opacity = 0.18 + t * 0.72;
  return `rgba(${gray}, ${gray}, ${gray}, ${opacity})`;
}

function renderPathDiagramForEvent(city, eventType, diagramId, metaId) {
  const root = document.getElementById(diagramId);
  const meta = document.getElementById(metaId);
  if (!root || !meta || !city) return;

  const eventEntry = getEventEntry(city, eventType);
  const detail = eventEntry?.detail ?? null;
  const profiles = detail?.windowProfiles?.length ? detail.windowProfiles : (detail?.pathProfile?.length ? [{ offsetMinutes: 0, eventTime: detail.eventTime, pathProfile: detail.pathProfile, cloudBaseKm: detail.dominantLayer?.heightKm ?? null, vertexKm: detail.vertexKm ?? null, blockedCount: detail.blockedCount ?? 0, blockedRatio: detail.blockedRatio ?? 0, score: detail.score ?? 0, sunAltitudeDeg: detail.sunAltitudeDeg ?? 0, sunAzimuthDeg: detail.sunAzimuthDeg ?? 0, localLayers: detail.localLayers ?? [], cloudBaseSource: detail.cloudBaseSource ?? 'unknown' }] : []);

  if (!eventEntry || !detail || !profiles.length) {
    meta.textContent = '暂无可用的光路剖面数据。';
    root.innerHTML = '<div class="path-empty">暂无光路数据</div>';
    return;
  }

  const eventName = eventType === 'sunrise' ? '朝霞' : '晚霞';
  const bearing = city.strictMeta?.[eventType === 'sunrise' ? 'sunriseBearing' : 'sunsetBearing'];
  const centerProfile = profiles.find((item) => item.offsetMinutes === 0) ?? profiles[Math.floor(profiles.length / 2)];
  const localLayers = [...(centerProfile?.localLayers ?? detail.localLayers ?? [])].sort((a, b) => a.heightKm - b.heightKm);
  const hasLocalCloud = localLayers.some((layer) => layer.rh >= 80);
  const blockedText = centerProfile?.blockedCount ? `遮挡点 ${centerProfile.blockedCount}/${centerProfile.pathProfile.length}` : '未触发 RH80 遮挡';
  meta.textContent = `${eventName}光路图 · 方位角 ${bearing?.toFixed(1) ?? '—'}° · 云底 ${centerProfile?.cloudBaseKm?.toFixed(1) ?? '—'} km · 顶点 ${centerProfile?.vertexKm?.toFixed(1) ?? '—'} km · ${blockedText}`;

  const width = 860;
  const height = 420;
  const padL = 18;
  const padR = 18;
  const padT = 18;
  const padB = 40;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const altitudeTicks = [12000, 10000, 8000, 6000, 4000, 2000, 0];
  const localLeft = padL + 8;
  const localRight = padL + 72;
  const curveLeft = padL + 90;
  const maxDist = 1000;
  const innerW = plotW - (curveLeft - padL) - 8;
  const xFor = (d) => curveLeft + (Math.min(Math.max(d, 0), maxDist) / maxDist) * innerW;
  const yFor = (km) => padT + plotH - Math.min(Math.max(km, 0), 12) / 12 * plotH;
  const groundY = (x) => {
    const t = (x - curveLeft) / Math.max(innerW, 1e-6);
    const sag = 18;
    return padT + plotH - 12 - sag * (1 - Math.pow(2 * t - 1, 2));
  };
  const originY = yFor(centerProfile?.cloudBaseKm ?? 0.1);
  const originX = curveLeft - 4;

  const rects = [];
  const lineEls = [];
  const markerEls = [];

  if (localLayers.length) {
    localLayers.forEach((layer, layerIdx) => {
      const topKm = layer.heightKm;
      const bottomKm = localLayers[layerIdx + 1]?.heightKm ?? 12;
      const y = yFor(bottomKm);
      const h = Math.max(3, yFor(topKm) - yFor(bottomKm));
      rects.push(`<rect x="${localLeft}" y="${y.toFixed(1)}" width="${localRight - localLeft}" height="${h.toFixed(1)}" fill="${pressureLevelColor(layer.level, layer.rh)}"></rect>`);
    });
  }

  if (hasLocalCloud) {
    centerProfile.pathProfile.forEach((point) => {
      const x = xFor(point.distanceKm);
      const cellW = 10;
      [...point.layers].sort((a, b) => a.heightKm - b.heightKm).forEach((layer, layerIdx, sortedLayers) => {
        const topKm = layer.heightKm;
        const bottomKm = sortedLayers[layerIdx + 1]?.heightKm ?? 12;
        const y = yFor(bottomKm);
        const h = Math.max(3, yFor(topKm) - yFor(bottomKm));
        rects.push(`<rect x="${(x - cellW / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${cellW.toFixed(1)}" height="${h.toFixed(1)}" fill="${pressureLevelColor(layer.level, layer.rh)}"></rect>`);
      });
    });

    profiles.forEach((variant) => {
      const profile = variant.pathProfile ?? [];
      const isCenter = variant.offsetMinutes === 0;
      const stroke = isCenter ? '#ff7a45' : (variant.offsetMinutes < 0 ? 'rgba(255, 208, 138, 0.56)' : 'rgba(255, 208, 138, 0.36)');
      const dash = isCenter ? '' : '6 5';
      const widthStroke = isCenter ? 3 : 1.6;
      lineEls.push(`<polyline points="${profile.map((point) => `${xFor(point.distanceKm).toFixed(1)},${yFor(point.curveHeightKm ?? 0.35).toFixed(1)}`).join(' ')}" fill="none" stroke="${stroke}" stroke-width="${widthStroke}" stroke-dasharray="${dash}"></polyline>`);
      profile.forEach((point) => {
        const x = xFor(point.distanceKm);
        const rayY = yFor(point.curveHeightKm ?? 0.35);
        markerEls.push(`<circle cx="${x.toFixed(1)}" cy="${rayY.toFixed(1)}" r="${point.blocked ? 4.2 : 2.0}" fill="${point.blocked ? '#ff4d4f' : '#7bd989'}" stroke="#fff" stroke-width="0.7"></circle>`);
      });
    });
  }

  const origin = `<circle class="path-origin" cx="${originX}" cy="${originY}" r="5"></circle><text x="${originX - 2}" y="${originY - 8}" class="path-axis-label">城市云底</text>`;
  const xLabels = Array.from({ length: 6 }, (_, i) => {
    const d = (maxDist * i) / 5;
    return `<text x="${xFor(d).toFixed(1)}" y="${height - 10}" text-anchor="middle" class="path-axis-label">${Math.round(d)} km</text>`;
  }).join('');
  const bandLabels = altitudeTicks.map((level) => {
    const y = yFor(level / 1000);
    const label = level === 12000 ? '12000m' : `${level}m`;
    return `<text x="12" y="${(y + 3).toFixed(1)}" class="path-band-label">${label}</text>`;
  }).join('');

  const topSummary = hasLocalCloud ? centerProfile.pathProfile.slice(0, 4).map((point) => {
    const d = point.distanceKm.toFixed(0);
    const h = point.curveHeightKm?.toFixed(2) ?? '—';
    const rh = point.curveHumidity?.toFixed(0) ?? '—';
    const flag = point.blocked ? '阻' : '通';
    return `${d}km ${h}km RH${rh} ${flag}`;
  }).join(' · ') : '本地无云，光路不显示';

  const localSummary = localLayers.slice(0, 4).map((layer) => `${Math.round(layer.heightKm * 1000)}m RH${Math.round(layer.rh)}`).join(' · ');

  root.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" class="path-svg" role="img" aria-label="${eventName}光路分层剖面">
      <rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" rx="10" fill="rgba(255,255,255,0.02)" stroke="rgba(255,255,255,0.06)"></rect>
      <text x="${localLeft}" y="${padT - 2}" class="path-axis-label">本地 RH</text>
      <path d="M ${curveLeft} ${groundY(curveLeft).toFixed(1)} Q ${(curveLeft + innerW / 2).toFixed(1)} ${(groundY(curveLeft + innerW / 2) - 14).toFixed(1)} ${curveLeft + innerW} ${groundY(curveLeft + innerW).toFixed(1)}" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="2"></path>
      ${bandLabels}
      ${rects.join('')}
      ${lineEls.join('')}
      ${markerEls.join('')}
      ${origin}
      ${xLabels}
    </svg>
    <div class="path-empty" style="margin-top:8px">${topSummary}</div>
    <div class="path-empty">${localSummary}</div>
  `;
}

function renderPathDiagram(city) {
  renderPathDiagramForEvent(city, 'sunset', 'panel-sunset-path-diagram', 'panel-sunset-path-meta');
  renderPathDiagramForEvent(city, 'sunrise', 'panel-sunrise-path-diagram', 'panel-sunrise-path-meta');
}

  renderPathDiagramForEvent(city, 'sunset', 'panel-sunset-path-diagram', 'panel-sunset-path-meta');
  renderPathDiagramForEvent(city, 'sunrise', 'panel-sunrise-path-diagram', 'panel-sunrise-path-meta');
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

function clearMarkers(mapKey) {
  const map = maps[mapKey];
  if (!map) return;
  Object.values(mapMarkers[mapKey] || {}).forEach((marker) => map.removeLayer(marker));
  mapMarkers[mapKey] = {};
}

function renderEventMap(mapKey) {
  const map = maps[mapKey];
  if (!map) return;
  clearMarkers(mapKey);

  cityStates.forEach((city) => {
    const entry = getEventEntry(city, mapKey);
    const score = entry?.score ?? 0;
    const marker = L.marker([city.lat, city.lon], {
      icon: createCityIcon(score),
      title: `${city.name} · ${mapKey === 'sunrise' ? '朝霞' : '晚霞'}`,
    });
    marker.on('click', () => selectCity(city.id));
    marker.bindTooltip(
      `<b>${city.name}</b><br>${getMapMetaText({ ...entry, eventType: mapKey })}`,
      { direction: 'top', offset: [0, -10] },
    );
    marker.addTo(map);
    mapMarkers[mapKey][city.id] = marker;
  });
}

function renderMarkers() {
  EVENT_ORDER.forEach((eventType) => {
    renderEventMap(eventType);
    const meta = document.getElementById(eventType === 'sunset' ? 'map-sunset-meta' : 'map-sunrise-meta');
    const top = [...cityStates]
      .map((city) => ({ city, entry: getEventEntry(city, eventType) }))
      .filter(({ entry }) => entry)
      .sort((a, b) => (b.entry?.score ?? 0) - (a.entry?.score ?? 0))[0];
    if (meta) {
      meta.textContent = top ? `${top.city.name} · ${top.entry.score.toFixed(2)}` : '暂无数据';
    }
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
      if (city) {
        EVENT_ORDER.forEach((eventType) => {
          const map = maps[eventType];
          if (map) map.setView([city.lat, city.lon], Math.max(map.getZoom(), 6), { animate: true });
        });
      }
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

function renderFactorBreakdown(city) {
  const root = document.getElementById('panel-factor-list');
  if (!root || !city) return;
  const factors = city.forecast.best?.detail?.factorBreakdown ?? [];
  if (!factors.length) {
    root.innerHTML = '<div class="path-empty">暂无因素分解数据</div>';
    return;
  }

  root.innerHTML = factors.map((factor) => `
    <div class="factor-row">
      <div class="factor-name">${factor.label}</div>
      <div class="factor-bar"><span style="width:${factor.percent.toFixed(1)}%"></span></div>
      <div class="factor-value">${factor.percent.toFixed(1)}%</div>
    </div>
  `).join('');
}

function renderChart(city) {
  const canvas = document.getElementById('forecast-chart');
  if (!canvas || !city) return;
  const ctx = canvas.getContext('2d');
  if (chartInstance) chartInstance.destroy();

  const series = [...(city.forecast.series ?? [])].sort((a, b) => new Date(a.time) - new Date(b.time));
  const labels = series.map((entry) => `${formatDate(entry.day)} · ${entry.eventType === 'sunrise' ? '日出' : '日落'}`);
  const sunriseData = series.map((entry) => (entry.eventType === 'sunrise' ? Number(entry.score.toFixed(2)) : null));
  const sunsetData = series.map((entry) => (entry.eventType === 'sunset' ? Number(entry.score.toFixed(2)) : null));
  const cloudData = series.map((entry) => Number((entry.detail?.curveHumidity ?? entry.cloudMid ?? 0).toFixed(0)));
  const blockedData = series.map((entry) => (entry.detail?.blocked ? 1 : 0));

  chartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: '日出',
          data: sunriseData,
          borderColor: '#f7c59f',
          backgroundColor: 'rgba(247,197,159,0.10)',
          borderWidth: 2,
          tension: 0.25,
          fill: false,
          yAxisID: 'yScore',
          pointRadius: 3,
          spanGaps: false,
        },
        {
          label: '日落',
          data: sunsetData,
          borderColor: '#ff6b35',
          backgroundColor: 'rgba(255,107,53,0.12)',
          borderWidth: 2,
          tension: 0.25,
          fill: false,
          yAxisID: 'yScore',
          pointRadius: 3,
          spanGaps: false,
        },
        {
          label: '曲线RH %',
          data: cloudData,
          borderColor: '#90caf9',
          borderWidth: 1,
          borderDash: [3, 3],
          tension: 0.1,
          yAxisID: 'yCloud',
          pointRadius: 0,
        },
        {
          label: '遮挡',
          data: blockedData,
          borderColor: '#ff4d4f',
          backgroundColor: 'rgba(255,77,79,0.16)',
          borderWidth: 1,
          tension: 0,
          yAxisID: 'yBlock',
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
          ticks: { color: '#aab4c3', maxRotation: 0, autoSkip: true },
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
          title: { display: true, text: '曲线 RH %', color: '#aab4c3', font: { size: 11 } },
          ticks: { color: '#aab4c3' },
          grid: { drawOnChartArea: false },
        },
        yBlock: {
          display: false,
          min: 0,
          max: 1,
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
  document.getElementById('panel-cloud-total').textContent = `${Math.round(best?.detail?.cloudCoverTotal ?? 0)}% / ${(best?.detail?.cloudWeight ?? 0).toFixed(2)}`;

  renderFactorBreakdown(city);
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

function focusCityOnMaps(city) {
  if (!city) return;
  EVENT_ORDER.forEach((eventType) => {
    const map = maps[eventType];
    if (map) map.setView([city.lat, city.lon], Math.max(map.getZoom(), 6), { animate: true });
  });
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
    if (city) {
      renderPanel(city);
      focusCityOnMaps(city);
    }
  } else if (ranked[0]) {
    renderPanel(ranked[0]);
    selectedCityId = ranked[0].id;
    document.getElementById('city-panel')?.classList.remove('hidden');
    focusCityOnMaps(ranked[0]);
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
  maps.sunset = initEventMap('map-sunset');
  maps.sunrise = initEventMap('map-sunrise');
  bindEvents();
  setLoading(true, '正在获取 GFS 分层数据…');
  const payload = await loadPayload();
  renderAll(payload);
  setLoading(false);
  scheduleRefresh();
}

document.addEventListener('DOMContentLoaded', main);
