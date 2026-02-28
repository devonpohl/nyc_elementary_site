/**
 * subway.js — NYC subway lines and stations layer.
 *
 * Uses pre-built GeoJSON from MTA GTFS data:
 *   /data/subway-lines.geojson   — one feature per route (1, 2, A, C, …)
 *                                    with route_short_name + route_color
 *   /data/subway-stations.geojson — one feature per station with
 *                                    stop_name, routes (csv), route_colors (csv)
 *
 * Renders each route as its own colored line layer. Where routes share
 * track, MapLibre's line-offset shifts them into parallel stripes.
 *
 * Generate the data with: python3 scripts/build-subway-geojson.py
 *
 * Exposes window.Subway with:
 *   init()  — bind toggle event
 */
window.Subway = (function () {
  'use strict';

  let linesData = null;
  let stationsData = null;
  let loaded = false;
  let visible = false;
  let popup = null;

  // Official MTA route colors (used for station bullets + fallback)
  const MTA_COLORS = {
    '1': '#EE352E', '2': '#EE352E', '3': '#EE352E',
    '4': '#00933C', '5': '#00933C', '6': '#00933C', '6X': '#00933C',
    '7': '#B933AD', '7X': '#B933AD',
    'A': '#2850AD', 'C': '#2850AD', 'E': '#2850AD',
    'B': '#FF6319', 'D': '#FF6319', 'F': '#FF6319', 'FX': '#FF6319', 'M': '#FF6319',
    'G': '#6CBE45',
    'J': '#996633', 'Z': '#996633',
    'L': '#A7A9AC',
    'N': '#FCCC0A', 'Q': '#FCCC0A', 'R': '#FCCC0A', 'W': '#FCCC0A',
    'S': '#808183', 'SF': '#808183', 'SR': '#808183', 'H': '#808183',
    'SI': '#1D3C78', 'SIR': '#1D3C78',
    'T': '#00ADD0',
  };

  // Preferred color ordering by route group (first route letter seen → position)
  // This just determines which stripe sits left vs right when routes overlap
  const ROUTE_SORT = {
    '1': 0, '2': 0, '3': 0,
    '4': 1, '5': 1, '6': 1, '6X': 1,
    '7': 2, '7X': 2,
    'A': 3, 'C': 3, 'E': 3,
    'B': 4, 'D': 4, 'F': 4, 'FX': 4, 'M': 4,
    'G': 5,
    'J': 6, 'Z': 6,
    'L': 7,
    'N': 8, 'Q': 8, 'R': 8, 'W': 8,
    'S': 9, 'SF': 9, 'SR': 9, 'H': 9,
    'SI': 10, 'SIR': 10,
    'T': 11,
  };

  /* ────────────────── Init ────────────────── */

  function init() {
    document.getElementById('toggle-subway').addEventListener('click', toggle);
  }

  /* ────────────────── Data loading ────────────────── */

  async function loadData() {
    if (loaded) return true;
    try {
      const [linesRes, stationsRes] = await Promise.all([
        fetch('/data/subway-lines.geojson'),
        fetch('/data/subway-stations.geojson'),
      ]);
      if (!linesRes.ok || !stationsRes.ok) {
        throw new Error('Failed to fetch subway GeoJSON');
      }
      linesData = await linesRes.json();
      stationsData = await stationsRes.json();

      if (!linesData.features || linesData.features.length === 0) {
        throw new Error('subway-lines.geojson is empty — run scripts/build-subway-geojson.py');
      }

      console.log(`Subway: ${linesData.features.length} route lines, ${stationsData.features.length} stations`);
      addLayers();
      loaded = true;
      return true;
    } catch (e) {
      console.error('Failed to load subway data:', e);
      return false;
    }
  }

  /* ────────────────── Layers ────────────────── */

  function addLayers() {
    const map = SchoolMap._getMap();
    if (!map) return;

    const beforeLayer = map.getLayer('housing-for-sale') ? 'housing-for-sale' : 'school-points';

    // ── Group routes by color for stripe offsetting ──
    // Each feature is one route. Routes with the same color (e.g. 1,2,3 all red)
    // overlap and don't need offsetting between themselves — they share the same
    // physical track. Routes with DIFFERENT colors on the same corridor need offset.
    //
    // Strategy: add each route as its own source+layer. The color determines
    // the stripe. Routes of the same color stack perfectly (desired). Different
    // colors get offset by using MapLibre's sort-key + offset.

    // Sort features by route group for consistent stripe layering
    // route_short_name may now be comma-separated (e.g. "A,C,E") — use first entry
    const sortedFeatures = [...linesData.features].sort((a, b) => {
      const nameA = (a.properties.route_short_name || '').split(',')[0];
      const nameB = (b.properties.route_short_name || '').split(',')[0];
      const sa = ROUTE_SORT[nameA] ?? 99;
      const sb = ROUTE_SORT[nameB] ?? 99;
      return sa - sb;
    });

    // Group by color — same-color routes share one source for simplicity
    const byColor = {};
    for (const feat of sortedFeatures) {
      const hex = '#' + (feat.properties.route_color || '999999');
      if (!byColor[hex]) byColor[hex] = [];
      byColor[hex].push(feat);
    }

    const colorKeys = Object.keys(byColor);
    const colorCount = colorKeys.length; // not all are on every corridor, but we use per-layer offset

    // Each color group gets a fixed offset position
    colorKeys.forEach((color, idx) => {
      const sourceId = 'subway-route-' + color.replace('#', '');
      const layerId = 'subway-line-' + color.replace('#', '');

      // Flatten MultiLineString → individual LineString features (Safari compat)
      const flatFeatures = [];
      for (const feat of byColor[color]) {
        if (feat.geometry.type === 'MultiLineString') {
          for (const coords of feat.geometry.coordinates) {
            if (coords.length < 2) continue;
            flatFeatures.push({
              type: 'Feature',
              properties: feat.properties,
              geometry: { type: 'LineString', coordinates: coords },
            });
          }
        } else {
          flatFeatures.push(feat);
        }
      }

      map.addSource(sourceId, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: flatFeatures },
      });

      // Pre-compute offset at each zoom stop (avoids nested '*' expression
      // which can silently fail in Safari's WebGL/MapLibre)
      const pos = idx - (colorCount - 1) / 2;

      map.addLayer({
        id: layerId,
        type: 'line',
        source: sourceId,
        layout: {
          'line-join': 'round',
          'line-cap': 'round',
          visibility: 'none',
        },
        paint: {
          'line-color': color,
          'line-width': [
            'interpolate', ['linear'], ['zoom'],
            9,  1,
            12, 1.8,
            16, 3,
          ],
          'line-offset': [
            'interpolate', ['linear'], ['zoom'],
            9,  pos * 1.2,
            12, pos * 2,
            16, pos * 3.5,
          ],
          'line-opacity': 1,
        },
      });

      console.log(`Subway layer: ${layerId}, color: ${color}, features: ${flatFeatures.length} (deduped), offset-pos: ${pos.toFixed(1)}`);
    });

    // Store color keys for toggle
    _colorKeys = colorKeys;
    console.log('Subway: added line layers for', colorKeys.length, 'color groups:', colorKeys);

    // ── Stations source ──
    map.addSource('subway-stations', {
      type: 'geojson',
      data: stationsData,
    });

    // ── Station dots ──
    map.addLayer({
      id: 'subway-stations-layer',
      type: 'circle',
      source: 'subway-stations',
      layout: { visibility: 'none' },
      paint: {
        'circle-radius': [
          'interpolate', ['linear'], ['zoom'],
          10, 1.5,
          13, 3,
          16, 5.5,
        ],
        'circle-color': '#ffffff',
        'circle-stroke-color': '#444444',
        'circle-stroke-width': [
          'interpolate', ['linear'], ['zoom'],
          10, 0.5,
          14, 1.5,
        ],
        'circle-opacity': 0.95,
      },
    });

    // ── Station labels ──
    map.addLayer({
      id: 'subway-station-labels',
      type: 'symbol',
      source: 'subway-stations',
      minzoom: 14,
      layout: {
        'text-field': ['get', 'stop_name'],
        'text-size': [
          'interpolate', ['linear'], ['zoom'],
          14, 10,
          17, 13,
        ],
        'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
        'text-offset': [0, 1.2],
        'text-anchor': 'top',
        'text-max-width': 10,
        'text-optional': true,
        visibility: 'none',
      },
      paint: {
        'text-color': '#1e293b',
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.5,
      },
    });

    // ── Station click → popup with route bullets ──
    map.on('click', 'subway-stations-layer', (e) => {
      if (!e.features || e.features.length === 0) return;
      const props = e.features[0].properties;
      const coords = e.features[0].geometry.coordinates.slice();

      const name = props.stop_name || 'Station';
      const routeStr = props.routes || '';
      const colorStr = props.route_colors || '';
      const routeNames = routeStr.split(',').filter(Boolean);
      const routeColors = colorStr.split(',').filter(Boolean);

      // Build colored bullet circles
      let bulletsHtml = '';
      for (let i = 0; i < routeNames.length; i++) {
        const sym = routeNames[i];
        const c = '#' + (routeColors[i] || '999999');
        // Dark text on light backgrounds (yellow, gray)
        const textColor = isLightColor(c) ? '#000' : '#fff';
        bulletsHtml += `<span style="
          display:inline-flex;align-items:center;justify-content:center;
          width:20px;height:20px;border-radius:50%;
          background:${c};color:${textColor};
          font-weight:700;font-size:11px;
          margin:1px 2px;
        ">${escapeHtml(sym)}</span>`;
      }

      const html = `
        <div style="font-family:system-ui,sans-serif;font-size:13px;max-width:220px;">
          <div style="font-weight:700;font-size:14px;margin-bottom:6px;">${escapeHtml(name)}</div>
          <div style="display:flex;flex-wrap:wrap;">${bulletsHtml}</div>
        </div>
      `;

      if (popup) popup.remove();
      popup = new maplibregl.Popup({ maxWidth: '260px', closeButton: true })
        .setLngLat(coords)
        .setHTML(html)
        .addTo(map);
    });

    map.on('mouseenter', 'subway-stations-layer', () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'subway-stations-layer', () => {
      map.getCanvas().style.cursor = '';
    });
  }

  /* ────────────────── Toggle ────────────────── */

  // Track color keys for toggling (set during addLayers)
  let _colorKeys = [];

  async function toggle() {
    visible = !visible;
    const btn = document.getElementById('toggle-subway');

    if (visible) {
      btn.textContent = 'Loading...';
      const ok = await loadData();
      btn.textContent = 'Subway';
      if (!ok) {
        visible = false;
        return;
      }
      btn.classList.add('active');
      setVisibility('visible');
    } else {
      btn.classList.remove('active');
      setVisibility('none');
      if (popup) popup.remove();
    }
  }

  function setVisibility(vis) {
    const map = SchoolMap._getMap();
    if (!map) return;

    // Route line layers
    for (const color of _colorKeys) {
      const layerId = 'subway-line-' + color.replace('#', '');
      if (map.getLayer(layerId)) {
        map.setLayoutProperty(layerId, 'visibility', vis);
      }
    }

    // Station layers
    for (const id of ['subway-stations-layer', 'subway-station-labels']) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
    }
  }

  /* ────────────────── Helpers ────────────────── */

  function isLightColor(hex) {
    // Parse hex color and compute relative luminance
    const h = hex.replace('#', '');
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    // Perceived brightness
    return (r * 299 + g * 587 + b * 114) / 1000 > 160;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  return { init };
})();
