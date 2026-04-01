/**
 * Fire Cloud (朝霞/晚霞) Quantitative Forecast Algorithm
 *
 * Based on the geometric model from Section 1.2 of:
 * https://www.sunsetbot.top/halo/posts/2026/huo-shao-yun-yu-bao-jiao-cheng-zhang-jie-yi/
 *
 * Key Algorithm:
 * 1. Maximum illumination distance: d_max = sqrt(2 * R * h)
 *    where R = Earth radius (6371 km), h = cloud base height (km)
 * 2. Sunset linear velocity: v_s = R * ω * cos(lat)
 *    where ω = 2π/86400 rad/s
 * 3. Fire cloud duration at any observer position: T_dur = d_max / v_s (seconds)
 * 4. Fire cloud window: [t_sunset - T_dur, t_sunset] (before sunset)
 *    (The "火烧云三角" — fire cloud triangle from Section 1.2.2)
 * 5. Score adjusted by cloud cover fraction, AOD, and multi-layer blocking
 */

'use strict';

const EARTH_RADIUS_KM = 6371;
const EARTH_OMEGA = 2 * Math.PI / 86400; // rad/s

/** Typical cloud base heights for each GFS layer (km) */
const CLOUD_LAYER_HEIGHTS = {
  low:  1.5,  // Low clouds  (surface – 3 km)
  mid:  4.5,  // Mid clouds  (3 – 7 km)
  high: 9.0,  // High clouds (7 – 12 km)
};

/**
 * Maximum fire-cloud illumination distance from cloud edge.
 * Formula: d_max = sqrt(2 * R * h)  [Section 1.2.1]
 * @param {number} h - Cloud base height in km
 * @returns {number} Maximum illumination distance in km
 */
function maxIlluminationDistance(h) {
  return Math.sqrt(2 * EARTH_RADIUS_KM * h);
}

/**
 * Sunset/sunrise terminator linear velocity at the surface.
 * v_s = R * ω * cos(lat)  [Section 1.2.2]
 * @param {number} latDeg - Latitude in degrees
 * @returns {number} Velocity in km/s
 */
function sunsetVelocity(latDeg) {
  return EARTH_RADIUS_KM * EARTH_OMEGA * Math.cos(latDeg * Math.PI / 180);
}

/**
 * Fire-cloud window duration (same for every observer position).
 * T_dur = d_max / v_s
 * @param {number} h - Cloud base height in km
 * @param {number} latDeg - Latitude in degrees
 * @returns {number} Duration in seconds
 */
function firecloudDuration(h, latDeg) {
  return maxIlluminationDistance(h) / sunsetVelocity(latDeg);
}

/**
 * Score contribution from a single cloud layer.
 *
 * The fire-cloud triangle (Section 1.2.2) shows that for a flat-bottomed
 * stratiform cloud, the illumination window at any observer position is
 * T_dur = d_max / v_s seconds, ending AT local sunset for evening glow,
 * or starting AT local sunrise for morning glow.
 *
 * In practice the illuminated cloud edge may be 50–300 km from the observer,
 * so the effective window is widened to 3 × T_dur to cover realistic cases.
 *
 * Sign convention:
 *   dt = -deltaT_s for isEvening (dt > 0 means BEFORE sunset)
 *   dt =  deltaT_s for !isEvening (dt > 0 means AFTER sunrise)
 *
 * @param {number} coverPct    - Cloud cover percentage 0–100
 * @param {number} heightKm    - Cloud base height in km
 * @param {number} deltaT_s    - Seconds relative to sunset/sunrise
 *                               (negative = before sunset/after sunrise; positive = after sunset/before sunrise)
 * @param {number} latDeg      - Observer latitude in degrees
 * @param {boolean} isEvening  - true for sunset glow, false for sunrise glow
 * @returns {number} Raw layer score (0 – 1)
 */
function layerScore(coverPct, heightKm, deltaT_s, latDeg, isEvening) {
  if (coverPct < 3) return 0;

  // T_dur from geometric model; multiply by 3 to cover realistic scenarios
  // where cloud edge is far from observer (the "fire cloud triangle" allows
  // this extended window when x_obs ≫ 0).
  const T_core = firecloudDuration(heightKm, latDeg); // seconds (geometric model)
  const T_eff  = T_core * 3;                          // practical window

  // Flip sign so dt > 0 always means "within the fire-cloud window"
  // Evening: window is before sunset (deltaT < 0)  → dt = -deltaT
  // Morning: window is after  sunrise (deltaT > 0)  → dt =  deltaT
  const dt = isEvening ? -deltaT_s : deltaT_s;

  let timeFactor;
  if (dt < -T_eff * 0.20) {
    // After event with long tail (well past sunset / sunrise)
    timeFactor = 0;
  } else if (dt < 0) {
    // Short post-event tail (sun just below horizon, clouds still lit)
    timeFactor = Math.max(0, 1 + dt / (T_eff * 0.20));
  } else if (dt < T_eff * 0.40) {
    // Plateau: strongest illumination in the 40% of window closest to event
    timeFactor = 1.0;
  } else if (dt < T_eff) {
    // Gradual ramp-up from start of window
    timeFactor = 1.0 - 0.5 * (dt - T_eff * 0.40) / (T_eff * 0.60);
  } else {
    timeFactor = 0;
  }

  // Coverage factor: optimal at 20–80%; penalise near-0% (no clouds) and
  // near-100% (solid overcast blocks direct illumination gap at cloud edge).
  const cf = coverPct / 100;
  let coverFactor;
  if (cf < 0.05) {
    coverFactor = cf / 0.05;
  } else if (cf < 0.20) {
    coverFactor = 0.5 + 0.5 * (cf - 0.05) / 0.15;
  } else if (cf <= 0.80) {
    coverFactor = 1.0;
  } else {
    coverFactor = Math.max(0, (1 - cf) / 0.20);
  }

  // Height factor: larger illumination zone for higher clouds → richer display
  const d_max = maxIlluminationDistance(heightKm);
  const heightFactor = Math.min(d_max / 340, 1.0); // normalise to ~9 km cloud

  return timeFactor * coverFactor * (0.4 + heightFactor * 0.6);
}

/**
 * Convert a plain AOD value to a vividness multiplier.
 * High aerosol → more Rayleigh/Mie scattering → colours shift but also fade.
 * The relationship is non-linear: moderate AOD (~0.3–0.5) can ENHANCE redness,
 * while very high AOD (≥1.0) begins to grey out the sky.
 * Approximation: factor = exp(−k · max(0, aod − 0.25)) with k ≈ 1.8
 * @param {number} aod - Aerosol optical depth (dimensionless)
 * @returns {number} Multiplier in (0, 1]
 */
function aodFactor(aod) {
  const thresh = 0.25; // below this, moderate AOD may help
  const penalty = Math.max(0, aod - thresh);
  return Math.exp(-1.8 * penalty);
}

/**
 * Infer approximate cloud base height from GFS cloud-cover levels.
 * Used for display and additional context; scoring uses fixed CLOUD_LAYER_HEIGHTS.
 * @param {number} lowCover  0-100
 * @param {number} midCover  0-100
 * @param {number} highCover 0-100
 * @returns {number} Estimated dominant cloud base height in km (or null)
 */
function estimateCloudBase(lowCover, midCover, highCover) {
  if (lowCover >= 20) return CLOUD_LAYER_HEIGHTS.low;
  if (midCover >= 20) return CLOUD_LAYER_HEIGHTS.mid;
  if (highCover >= 20) return CLOUD_LAYER_HEIGHTS.high;
  return null;
}

/**
 * Main scoring function.
 *
 * Calculates the fire-cloud (火烧云) vividness score (0–5 scale) for a
 * specific location and time, given GFS weather data for that hour.
 *
 * @param {number} lat            - Latitude in degrees (north positive)
 * @param {number} lon            - Longitude in degrees (east positive)
 * @param {Object} hourlyEntry    - One hour of Open-Meteo data:
 *   { cloud_cover, cloud_cover_low, cloud_cover_mid, cloud_cover_high,
 *     aerosol_optical_depth }
 * @param {Date}   time           - The forecast datetime (UTC)
 * @param {'sunset'|'sunrise'} eventType
 * @returns {Object|null} Scoring breakdown, or null if outside time window
 */
function calculateFireCloudScore(lat, lon, hourlyEntry, time, eventType) {
  if (typeof SunCalc === 'undefined') {
    console.error('SunCalc not loaded');
    return null;
  }

  const sunTimes  = SunCalc.getTimes(time, lat, lon);
  const eventTime = eventType === 'sunset' ? sunTimes.sunset : sunTimes.sunrise;

  if (!eventTime || isNaN(eventTime.getTime())) return null;

  // Seconds relative to the solar event (negative = before event)
  const deltaT = (time.getTime() - eventTime.getTime()) / 1000;

  // Only score within ±90 min of the event
  const MAX_WINDOW = 90 * 60;
  if (Math.abs(deltaT) > MAX_WINDOW) {
    return { score: 0, deltaT, eventTime, outsideWindow: true };
  }

  const isEvening = (eventType === 'sunset');
  const cloudLow  = hourlyEntry.cloud_cover_low  ?? 0;
  const cloudMid  = hourlyEntry.cloud_cover_mid  ?? 0;
  const cloudHigh = hourlyEntry.cloud_cover_high ?? 0;
  const aod       = hourlyEntry.aerosol_optical_depth ?? 0.2;

  // Per-layer raw scores
  const sHigh = layerScore(cloudHigh, CLOUD_LAYER_HEIGHTS.high, deltaT, lat, isEvening);
  const sMid  = layerScore(cloudMid,  CLOUD_LAYER_HEIGHTS.mid,  deltaT, lat, isEvening);
  const sLow  = layerScore(cloudLow,  CLOUD_LAYER_HEIGHTS.low,  deltaT, lat, isEvening);

  // Low-cloud blocking factor: dense low cloud obscures mid/high illumination
  // A completely overcast low layer (100%) reduces higher-layer contribution by ~70%
  const lowBlock = Math.max(0.3, 1 - Math.pow(cloudLow / 100, 1.5) * 0.7);

  // Weighted combination: high clouds most vivid, low clouds less so
  const rawScore = sHigh * 2.5 * lowBlock
                 + sMid  * 1.8 * lowBlock
                 + sLow  * 1.0;

  // AOD correction
  const aodMult = aodFactor(aod);

  // Final score on 0–5 scale.
  // rawScore peaks near 4.3 (all three layers perfect, no low-cloud blocking).
  // Scale = 1.1 so that theoretical max ≈ 4.7 maps to ≈ 5.0 after cap.
  const score = Math.min(rawScore * aodMult * 1.1, 5);

  return {
    score,
    eventType,
    eventTime,
    deltaT,
    cloudLow,
    cloudMid,
    cloudHigh,
    aod,
    aodMult,
    lowBlock,
    rawScore,
    sHigh,
    sMid,
    sLow,
  };
}

/**
 * Build a 48-hour score time series for one city using fetched weather data.
 *
 * @param {Object} city         - { lat, lon, name, ... }
 * @param {Object} weatherData  - Open-Meteo hourly JSON response
 * @returns {Array} Array of { time, sunsetScore, sunriseScore, score, ... }
 */
function buildScoreTimeSeries(city, weatherData) {
  const hourly = weatherData.hourly;
  if (!hourly || !hourly.time) return [];

  const results = [];

  for (let i = 0; i < hourly.time.length; i++) {
    const time = new Date(hourly.time[i]);
    const entry = {
      cloud_cover:       hourly.cloud_cover?.[i]       ?? 0,
      cloud_cover_low:   hourly.cloud_cover_low?.[i]   ?? 0,
      cloud_cover_mid:   hourly.cloud_cover_mid?.[i]   ?? 0,
      cloud_cover_high:  hourly.cloud_cover_high?.[i]  ?? 0,
      aerosol_optical_depth: hourly.aerosol_optical_depth?.[i] ?? 0.2,
    };

    const ssResult = calculateFireCloudScore(city.lat, city.lon, entry, time, 'sunset');
    const srResult = calculateFireCloudScore(city.lat, city.lon, entry, time, 'sunrise');

    const ssScore = ssResult ? ssResult.score : 0;
    const srScore = srResult ? srResult.score : 0;
    const score = Math.max(ssScore, srScore);

    results.push({
      time,
      score,
      sunsetScore:  ssScore,
      sunriseScore: srScore,
      detail: score === ssScore ? ssResult : srResult,
      cloudLow:  entry.cloud_cover_low,
      cloudMid:  entry.cloud_cover_mid,
      cloudHigh: entry.cloud_cover_high,
      aod:       entry.aerosol_optical_depth,
    });
  }

  return results;
}

/**
 * Score label and class for UI display.
 * @param {number} score 0-5
 * @returns {{ label: string, css: string }}
 */
function scoreLabel(score) {
  if (score < 0.3)  return { label: '不烧',  css: 'score-none'   };
  if (score < 1.0)  return { label: '微烧',  css: 'score-micro'  };
  if (score < 2.0)  return { label: '小烧',  css: 'score-small'  };
  if (score < 3.0)  return { label: '中烧',  css: 'score-medium' };
  if (score < 4.0)  return { label: '大烧',  css: 'score-large'  };
  return              { label: '超烧',  css: 'score-super'  };
}

/**
 * Score to hex colour for map markers.
 * @param {number} score 0-5
 * @returns {string} CSS hex colour
 */
function scoreToColor(score) {
  if (score < 0.3)  return '#4a9eff'; // blue – no glow
  if (score < 1.0)  return '#78d97e'; // green – micro
  if (score < 2.0)  return '#f5e642'; // yellow – small
  if (score < 3.0)  return '#ff9020'; // orange – medium
  if (score < 4.0)  return '#ff4d1a'; // red – large
  return              '#cc0066';       // purple-red – super
}

/**
 * AOD description string.
 * @param {number} aod
 * @returns {string}
 */
function aodLabel(aod) {
  if (aod < 0.1)  return '清洁 (<0.1)';
  if (aod < 0.3)  return '轻污 (0.1–0.3)';
  if (aod < 0.6)  return '中污 (0.3–0.6)';
  if (aod < 1.0)  return '大污 (0.6–1.0)';
  return            '重污 (≥1.0)';
}
