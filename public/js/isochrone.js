/**
 * isochrone.js — Travel time isochrone rendering.
 *
 * 20–60 min bands in 10-min increments.
 *
 * Exposes window.Isochrone with:
 *   init()  — check provider status, bind events
 */
window.Isochrone = (function () {
  'use strict';

  // Fixed bands: 20, 30, 40, 50, 60 minutes
  const BANDS = [20, 30, 40, 50, 60];

  // Color ramps: index 0 = innermost/smallest (darkest), last = outermost/largest (lightest)
  const COLORS = {
    driving: ['#1e3a5f', '#2563eb', '#60a5fa', '#93c5fd', '#dbeafe'],
    transit: ['#bbf7d0', '#facc15', '#f97316', '#dc2626', '#7c2d12'],
  };

  let providerStatus = { driving: false, transit: false };
  let originMarker = null;
  let currentOrigin = null; // { lat, lng, label }
  let activeMode = null;
  let lastSearchedQuery = ''; // tracks the address most recently submitted
  let selectedBands = new Set(); // minute values currently shown on the map

  /* ────────────────── Init ────────────────── */

  async function init() {
    await checkProviders();
    bindEvents();
    updateUI();
  }

  async function checkProviders() {
    try {
      const res = await fetch('/api/isochrone/status');
      if (res.ok) providerStatus = await res.json();
    } catch (e) {
      console.warn('Could not check isochrone providers:', e);
    }
  }

  function updateUI() {
    const statusEl = document.getElementById('iso-status');

    if (!providerStatus.driving && !providerStatus.transit) {
      statusEl.textContent = 'Set ORS_API_KEY (driving) or GEOAPIFY_API_KEY (transit) to enable.';
      statusEl.classList.remove('hidden');
    } else {
      statusEl.classList.add('hidden');
    }

    // Mode buttons stay disabled until an address is resolved
    updateModeButtonsAvailability();

    // Hide traffic selector until driving mode is active
    document.getElementById('iso-traffic').style.display = 'none';
  }

  function updateModeButtonsAvailability() {
    const drivingBtn = document.getElementById('iso-driving-btn');
    const transitBtn = document.getElementById('iso-transit-btn');
    const hasOrigin = !!currentOrigin;

    drivingBtn.disabled = !hasOrigin || !providerStatus.driving;
    transitBtn.disabled = !hasOrigin || !providerStatus.transit;

    if (!providerStatus.driving) {
      drivingBtn.title = 'Set ORS_API_KEY to enable';
    } else if (!hasOrigin) {
      drivingBtn.title = 'Enter an address first';
    } else {
      drivingBtn.title = '';
    }

    if (!providerStatus.transit) {
      transitBtn.title = 'Set GEOAPIFY_API_KEY to enable';
    } else if (!hasOrigin) {
      transitBtn.title = 'Enter an address first';
    } else {
      transitBtn.title = '';
    }
  }

  /* ────────────────── Events ────────────────── */

  function bindEvents() {
    const addressInput = document.getElementById('iso-address-input');
    const addressHint = document.getElementById('iso-address-hint');

    // Show "Press Enter to search" hint when the input has unsubmitted text
    addressInput.addEventListener('input', () => {
      const val = addressInput.value.trim();
      const unsearched = val.length > 0 && val !== lastSearchedQuery;
      addressHint.classList.toggle('hidden', !unsearched);
    });

    // Address search
    document.getElementById('iso-address-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const query = addressInput.value.trim();
      lastSearchedQuery = query;
      addressHint.classList.add('hidden');
      await geocodeAndSetOrigin(query);
    });

    // Mode buttons
    document.getElementById('iso-driving-btn').addEventListener('click', () => fetchIsochrone('driving'));
    document.getElementById('iso-transit-btn').addEventListener('click', () => fetchIsochrone('transit'));

    // Clear button
    document.getElementById('iso-clear-btn').addEventListener('click', () => clearIsochrones());

    // Re-fetch on traffic level change
    document.getElementById('iso-traffic-select').addEventListener('change', () => {
      if (activeMode === 'driving' && currentOrigin) {
        fetchIsochrone('driving');
      }
    });
  }

  /* ────────────────── Geocoding ────────────────── */

  async function geocodeAndSetOrigin(query) {
    if (!query) return;

    const statusEl = document.getElementById('iso-status');
    statusEl.textContent = 'Searching...';
    statusEl.classList.remove('hidden');

    try {
      // Call Nominatim directly from browser (same pattern as reunion site)
      const hasContext = /new york|nyc|brooklyn|manhattan|queens|bronx|staten/i.test(query);
      const fullQuery = hasContext ? query : `${query}, New York, NY`;
      const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(fullQuery)}&limit=5&countrycodes=us&viewbox=-74.3,40.45,-73.6,40.95`;

      const res = await fetch(url, {
        headers: { 'User-Agent': 'NYCSchoolsExplorer/1.0' },
      });
      const results = await res.json();

      if (!results || results.length === 0) {
        statusEl.textContent = 'No results found. Try a more specific address.';
        return;
      }

      const best = results[0];
      currentOrigin = {
        lat: parseFloat(best.lat),
        lng: parseFloat(best.lon),
        label: best.display_name,
      };

      placeOriginMarker(currentOrigin);
      statusEl.textContent = best.display_name.split(',').slice(0, 3).join(',');

      // Enable mode buttons now that we have a resolved origin
      updateModeButtonsAvailability();
    } catch (e) {
      statusEl.textContent = 'Geocoding failed. Try again.';
      console.error('Geocode error:', e);
    }
  }

  function placeOriginMarker(origin) {
    const map = SchoolMap._getMap();
    if (!map) return;

    if (originMarker) originMarker.remove();

    const el = document.createElement('div');
    el.className = 'origin-marker';
    el.innerHTML = '<div class="origin-marker-dot"></div><div class="origin-marker-pulse"></div>';

    originMarker = new maplibregl.Marker({ element: el })
      .setLngLat([origin.lng, origin.lat])
      .addTo(map);

    map.flyTo({ center: [origin.lng, origin.lat], zoom: 12, duration: 1000 });
  }

  /* ────────────────── Isochrone Fetching ────────────────── */

  function getTrafficFactor() {
    const sel = document.getElementById('iso-traffic-select');
    return sel ? parseFloat(sel.value) : 1.0;
  }

  async function fetchIsochrone(mode) {
    if (!currentOrigin) {
      const statusEl = document.getElementById('iso-status');
      statusEl.textContent = 'Enter an address first.';
      statusEl.classList.remove('hidden');
      return;
    }

    const statusEl = document.getElementById('iso-status');
    const factor = mode === 'driving' ? getTrafficFactor() : 1.0;
    const trafficLabel = factor < 1.0 ? ` (${document.getElementById('iso-traffic-select').selectedOptions[0].text} traffic)` : '';
    statusEl.textContent = `Loading ${mode} isochrone (30–60 min${trafficLabel})...`;
    statusEl.classList.remove('hidden');

    // Highlight active button, show/hide traffic selector
    document.getElementById('iso-driving-btn').classList.toggle('active', mode === 'driving');
    document.getElementById('iso-transit-btn').classList.toggle('active', mode === 'transit');
    document.getElementById('iso-traffic').style.display = mode === 'driving' ? '' : 'none';
    activeMode = mode;

    try {
      // For driving: scale bands by congestion factor.
      // e.g. "30 min in heavy traffic" → query ORS for 15 min free-flow
      const queryBands = BANDS.map(b => Math.round(b * factor));
      const minutesParam = queryBands.join(',');
      const url = `/api/isochrone/${mode}?lat=${currentOrigin.lat}&lng=${currentOrigin.lng}&minutes=${minutesParam}`;
      const res = await fetch(url);

      if (!res.ok) {
        const err = await res.json();
        statusEl.textContent = err.error || 'Request failed.';
        return;
      }

      const geojson = await res.json();

      // Re-label features with the display bands (original unscaled values)
      // so legends and tooltips show "30 min", "35 min", etc.
      if (factor < 1.0 && geojson.features) {
        geojson.features.forEach((f) => {
          if (f.properties.value !== undefined) {
            // ORS returns value in seconds — map back to display band
            const queryMin = Math.round(f.properties.value / 60);
            const idx = queryBands.indexOf(queryMin);
            if (idx !== -1) {
              f.properties.value = BANDS[idx] * 60; // relabel to display time
            }
          }
        });
      }

      renderIsochrone(geojson, mode);
      statusEl.textContent = currentOrigin.label.split(',').slice(0, 3).join(',') + trafficLabel;
    } catch (e) {
      statusEl.textContent = 'Isochrone request failed.';
      console.error('Isochrone error:', e);
    }
  }

  /* ────────────────── Rendering ────────────────── */

  function renderIsochrone(geojson, mode) {
    const map = SchoolMap._getMap();
    if (!map) return;

    clearIsochroneLayers(map);

    const colors = COLORS[mode] || COLORS.driving;
    const features = geojson.features || [];

    // Sort features by time DESCENDING so largest polygon draws first (bottom)
    features.sort((a, b) => getFeatureTime(b) - getFeatureTime(a));

    // Rebuild the geojson with sorted features and a band_index property
    const processedFeatures = features.map((f, i) => ({
      ...f,
      properties: {
        ...f.properties,
        band_index: i,
        band_minutes: Math.round(getFeatureTime(f) / 60),
      },
    }));

    const processedGeojson = {
      type: 'FeatureCollection',
      features: processedFeatures,
    };

    map.addSource('isochrone', {
      type: 'geojson',
      data: processedGeojson,
    });

    // Build color stops: band_index 0 = outermost (lightest), last = innermost (darkest)
    const colorStops = ['match', ['get', 'band_index']];
    processedFeatures.forEach((f, i) => {
      // Map: outermost (i=0) gets lightest color, innermost gets darkest
      const colorIdx = colors.length - 1 - Math.min(i, colors.length - 1);
      colorStops.push(i);
      colorStops.push(colors[colorIdx]);
    });
    colorStops.push(colors[Math.floor(colors.length / 2)]); // fallback

    // Opacity: outermost lighter, innermost darker
    const opacityStops = ['match', ['get', 'band_index']];
    processedFeatures.forEach((f, i) => {
      const opacity = 0.12 + (i / Math.max(processedFeatures.length - 1, 1)) * 0.22;
      opacityStops.push(i);
      opacityStops.push(opacity);
    });
    opacityStops.push(0.2); // fallback

    map.addLayer({
      id: 'isochrone-fill',
      type: 'fill',
      source: 'isochrone',
      paint: {
        'fill-color': colorStops,
        'fill-opacity': opacityStops,
      },
    }, 'zone-fills'); // Insert below zone layers

    map.addLayer({
      id: 'isochrone-outline',
      type: 'line',
      source: 'isochrone',
      paint: {
        'line-color': colorStops,
        'line-width': 1,
        'line-opacity': 0.5,
      },
    }, 'zone-fills');

    renderLegend(mode, processedFeatures, colors);
  }

  function getFeatureTime(feature) {
    // ORS: feature.properties.value (seconds)
    if (feature.properties.value !== undefined) return feature.properties.value;
    // Geoapify: feature.properties.range (seconds)
    if (feature.properties.range !== undefined) return feature.properties.range;
    return 0;
  }

  function renderLegend(mode, features, colors) {
    const container = document.getElementById('iso-legend');
    // Show bands from smallest (innermost) to largest (outermost)
    const reversed = [...features].reverse();
    const allMinutes = reversed.map(f => f.properties.band_minutes);

    // Default: select only the 30-minute band (or the closest one if 30 isn't present)
    const defaultMins = allMinutes.includes(30)
      ? 30
      : allMinutes[Math.floor(allMinutes.length / 2)];
    selectedBands = new Set([defaultMins]);

    let pillsHtml = '';
    reversed.forEach((f) => {
      const mins = f.properties.band_minutes;
      const bandIdx = f.properties.band_index;
      const colorIdx = colors.length - 1 - Math.min(bandIdx, colors.length - 1);
      const cls = selectedBands.has(mins) ? 'selected' : 'deselected';
      pillsHtml += `<span class="iso-legend-item ${cls}" data-mins="${mins}" role="button" tabindex="0" title="Click to toggle ${mins}-minute band">
        <span class="iso-legend-swatch" style="background:${colors[colorIdx]}"></span>
        ${mins}m
      </span>`;
    });

    container.innerHTML = `
      <div class="iso-legend-prompt">Click to show / hide bands on the map</div>
      <div class="iso-legend-pills">${pillsHtml}</div>
    `;
    container.classList.remove('hidden');

    container.querySelectorAll('.iso-legend-item').forEach((el) => {
      el.addEventListener('click', () => toggleBand(el));
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggleBand(el);
        }
      });
    });

    // Apply the default filter so the map matches the pill selection on first render
    applyBandFilter();
  }

  function toggleBand(el) {
    const mins = parseInt(el.dataset.mins, 10);
    if (selectedBands.has(mins)) {
      selectedBands.delete(mins);
      el.classList.remove('selected');
      el.classList.add('deselected');
    } else {
      selectedBands.add(mins);
      el.classList.add('selected');
      el.classList.remove('deselected');
    }
    applyBandFilter();
  }

  function applyBandFilter() {
    const map = SchoolMap._getMap();
    if (!map) return;

    const selectedArr = [...selectedBands];
    // No bands selected → hide everything via a never-matching filter
    const filter = selectedArr.length === 0
      ? ['==', ['get', 'band_minutes'], -1]
      : ['match', ['get', 'band_minutes'], selectedArr, true, false];

    if (map.getLayer('isochrone-fill')) map.setFilter('isochrone-fill', filter);
    if (map.getLayer('isochrone-outline')) map.setFilter('isochrone-outline', filter);
  }

  /* ────────────────── Clearing ────────────────── */

  function clearIsochrones() {
    const map = SchoolMap._getMap();
    if (!map) return;
    clearIsochroneLayers(map);

    if (originMarker) {
      originMarker.remove();
      originMarker = null;
    }
    currentOrigin = null;
    activeMode = null;

    document.getElementById('iso-address-input').value = '';
    document.getElementById('iso-address-hint').classList.add('hidden');
    lastSearchedQuery = '';
    document.getElementById('iso-status').classList.add('hidden');
    document.getElementById('iso-legend').classList.add('hidden');
    document.getElementById('iso-legend').innerHTML = '';
    document.getElementById('iso-driving-btn').classList.remove('active');
    document.getElementById('iso-transit-btn').classList.remove('active');
    document.getElementById('iso-traffic').style.display = 'none';

    // Roll mode buttons back to disabled since we no longer have an origin
    updateModeButtonsAvailability();
  }

  function clearIsochroneLayers(map) {
    if (map.getLayer('isochrone-fill')) map.removeLayer('isochrone-fill');
    if (map.getLayer('isochrone-outline')) map.removeLayer('isochrone-outline');
    if (map.getSource('isochrone')) map.removeSource('isochrone');
  }

  return { init };
})();
