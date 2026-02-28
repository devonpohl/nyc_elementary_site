/**
 * subway.js — NYC subway lines and stations layer.
 *
 * Fetches GeoJSON from NYC ArcGIS REST API (client-side, no proxy needed).
 * Falls back to local /data/ files if available.
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

  // ArcGIS REST endpoints (public, no auth)
  const LINES_URL = 'https://services6.arcgis.com/yG5s3afENB5iO9fj/arcgis/rest/services/Subway_view/FeatureServer/0/query';
  const STATIONS_URL = 'https://services6.arcgis.com/yG5s3afENB5iO9fj/arcgis/rest/services/SubwayStation_view/FeatureServer/0/query';

  // Official MTA line colors keyed by route symbol
  const MTA_COLORS = {
    '1': '#EE352E', '2': '#EE352E', '3': '#EE352E',
    '4': '#00933C', '5': '#00933C', '6': '#00933C',
    '7': '#B933AD',
    'A': '#2850AD', 'C': '#2850AD', 'E': '#2850AD',
    'B': '#FF6319', 'D': '#FF6319', 'F': '#FF6319', 'M': '#FF6319',
    'G': '#6CBE45',
    'J': '#996633', 'Z': '#996633',
    'L': '#A7A9AC',
    'N': '#FCCC0A', 'Q': '#FCCC0A', 'R': '#FCCC0A', 'W': '#FCCC0A',
    'S': '#808183',
    'SI': '#1D3C78', 'SIR': '#1D3C78',
    'T': '#00ADD0',
  };

  /* ────────────────── Init ────────────────── */

  function init() {
    document.getElementById('toggle-subway').addEventListener('click', toggle);
  }

  /* ────────────────── Data ────────────────── */

  async function fetchAllFromArcGIS(baseUrl) {
    // ArcGIS REST API has a per-request record limit (often 1000-2000).
    // Paginate with resultOffset until we get all features.
    const allFeatures = [];
    const pageSize = 2000;
    let offset = 0;

    while (true) {
      const params = new URLSearchParams({
        where: '1=1',
        outFields: '*',
        f: 'geojson',
        resultRecordCount: String(pageSize),
        resultOffset: String(offset),
      });
      const url = baseUrl + '?' + params.toString();
      const res = await fetch(url);
      if (!res.ok) throw new Error(`ArcGIS request failed: ${res.status}`);
      const data = await res.json();

      const features = data.features || [];
      allFeatures.push(...features);
      console.log(`Subway: page at offset ${offset} returned ${features.length} features`);

      // If we got fewer than pageSize, we've exhausted the dataset
      if (features.length < pageSize) break;
      offset += pageSize;
    }

    return { type: 'FeatureCollection', features: allFeatures };
  }

  async function fetchGeoJSON(arcgisUrl, localPath) {
    // Try local file first (fast, no CORS)
    try {
      const localRes = await fetch(localPath);
      if (localRes.ok) {
        const data = await localRes.json();
        if (data.type === 'FeatureCollection' && Array.isArray(data.features) && data.features.length > 0) {
          console.log(`Subway: Loaded ${data.features.length} features from ${localPath}`);
          return data;
        }
      }
    } catch (e) { /* fall through */ }

    // Fetch from ArcGIS REST API with pagination
    console.log('Subway: Fetching from ArcGIS REST API...');
    const data = await fetchAllFromArcGIS(arcgisUrl);

    if (data.features.length === 0) {
      throw new Error('ArcGIS returned empty result');
    }

    console.log(`Subway: Total ${data.features.length} features from ArcGIS`);
    return data;
  }

  async function loadData() {
    if (loaded) return true;
    try {
      const [lines, stations] = await Promise.all([
        fetchGeoJSON(LINES_URL, '/data/subway-lines.geojson'),
        fetchGeoJSON(STATIONS_URL, '/data/subway-stations.geojson'),
      ]);
      linesData = lines;
      stationsData = stations;
      addSourceAndLayers();
      loaded = true;
      return true;
    } catch (e) {
      console.error('Failed to load subway data:', e);
      return false;
    }
  }

  /* ────────────────── Layers ────────────────── */

  function getRouteColor(routeStr) {
    // The ROUTE field may contain multi-line values like "A-C-E" or "1-2-3"
    // Extract first single character to match color
    if (!routeStr) return '#999999';
    const first = routeStr.split('-')[0].split(' ')[0].trim();
    return MTA_COLORS[first] || '#999999';
  }

  function buildColorExpression() {
    // Try rt_symbol first (single letter), then first char of ROUTE field
    // The ArcGIS data uses ROUTE like "A-C-E", "1-2-3", "G", "L", etc.
    const expr = ['match', ['coalesce', ['get', 'rt_symbol'], '']];

    for (const [symbol, color] of Object.entries(MTA_COLORS)) {
      expr.push(symbol, color);
    }
    expr.push('#999999');
    return expr;
  }

  function buildRouteColorExpression() {
    // For ArcGIS data where the field is ROUTE (e.g. "A-C-E", "1-2-3", "G")
    // Use a case expression that checks if ROUTE starts with each letter
    const cases = ['case'];

    // Group by color to reduce expression size
    const colorToSymbols = {};
    for (const [symbol, color] of Object.entries(MTA_COLORS)) {
      if (!colorToSymbols[color]) colorToSymbols[color] = [];
      colorToSymbols[color].push(symbol);
    }

    for (const [color, symbols] of Object.entries(colorToSymbols)) {
      // Check if the ROUTE field starts with any of these symbols
      const conditions = symbols.map(s =>
        ['==', ['slice', ['coalesce', ['get', 'ROUTE'], ['get', 'rt_symbol'], ''], 0, s.length], s]
      );
      if (conditions.length === 1) {
        cases.push(conditions[0], color);
      } else {
        cases.push(['any', ...conditions], color);
      }
    }

    cases.push('#999999'); // fallback
    return cases;
  }

  function addSourceAndLayers() {
    const map = SchoolMap._getMap();
    if (!map) return;

    map.addSource('subway-lines', {
      type: 'geojson',
      data: linesData,
    });

    map.addSource('subway-stations', {
      type: 'geojson',
      data: stationsData,
    });

    // Insert below housing or school-points
    const beforeLayer = map.getLayer('housing-for-sale') ? 'housing-for-sale' : 'school-points';

    // ── Subway lines ──
    map.addLayer({
      id: 'subway-lines-layer',
      type: 'line',
      source: 'subway-lines',
      layout: {
        'line-join': 'round',
        'line-cap': 'round',
        visibility: 'none',
      },
      paint: {
        'line-color': buildRouteColorExpression(),
        'line-width': [
          'interpolate', ['linear'], ['zoom'],
          9, 1,
          12, 2.5,
          16, 4,
        ],
        'line-opacity': 0.75,
      },
    }, beforeLayer);

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
          16, 6,
        ],
        'circle-color': '#ffffff',
        'circle-stroke-color': '#333333',
        'circle-stroke-width': [
          'interpolate', ['linear'], ['zoom'],
          10, 0.5,
          14, 1.5,
        ],
        'circle-opacity': 0.9,
      },
    }, beforeLayer);

    // ── Station labels at higher zoom ──
    map.addLayer({
      id: 'subway-station-labels',
      type: 'symbol',
      source: 'subway-stations',
      minzoom: 14,
      layout: {
        'text-field': ['coalesce', ['get', 'name'], ['get', 'Name'], ['get', 'NAME'], ['get', 'stop_name']],
        'text-size': [
          'interpolate', ['linear'], ['zoom'],
          14, 10,
          17, 13,
        ],
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
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
    }, beforeLayer);

    // ── Click handler ──
    map.on('click', 'subway-stations-layer', (e) => {
      if (!e.features || e.features.length === 0) return;
      const props = e.features[0].properties;
      const coords = e.features[0].geometry.coordinates.slice();

      const stationName = props.name || props.Name || props.NAME || props.stop_name || 'Station';
      const lines = props.line || props.Line || props.LINE || props.routes || '';

      const html = `
        <div style="font-family: var(--font); font-size: 13px;">
          <div style="font-weight: 700; font-size: 14px; margin-bottom: 4px;">${escapeHtml(stationName)}</div>
          ${lines ? '<div style="color: #64748b;">Lines: ' + escapeHtml(lines) + '</div>' : ''}
        </div>
      `;

      if (popup) popup.remove();
      popup = new maplibregl.Popup({ maxWidth: '240px', closeButton: true })
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
    for (const id of ['subway-lines-layer', 'subway-stations-layer', 'subway-station-labels']) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
    }
  }

  /* ────────────────── Helpers ────────────────── */

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  return { init };
})();
