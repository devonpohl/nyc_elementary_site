/**
 * map.js — MapLibre GL initialization, data layers, and interactions.
 *
 * Exposes window.SchoolMap with:
 *   init()                        — boot the map and load data
 *   flyToSchool(systemCode)       — animate to a school
 *   setFeaturePreference(sc, lvl) — color a school + its zone
 *   clearFeaturePreference(sc)    — remove color
 *   getSchoolProperties(sc)       — return properties for a system_code
 */
window.SchoolMap = (function () {
  'use strict';

  let map;
  let schoolsData = null;
  let zonesData = null;
  let popup = null;

  // Lookup tables built once after data loads
  let schoolsByCode = {};      // system_code → feature.properties
  let schoolCoords = {};       // system_code → [lng, lat]
  let schoolToZoneDbn = {};    // system_code → raw dbn string in zones file
  let selectedSchool = null;
  let selectedZoneDbn = null;

  const PREFERENCE_COLORS = {
    'top-choice': '#16a34a',
    'strong':     '#2563eb',
    'interested': '#ca8a04',
    'not-interested': '#ef4444',
  };

  /* ────────────────── Init ────────────────── */

  function init() {
    map = new maplibregl.Map({
      container: 'map',
      style: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json',
      center: [-73.95, 40.71],
      zoom: 10.5,
      minZoom: 9,
      maxZoom: 18,
    });

    map.addControl(new maplibregl.NavigationControl(), 'bottom-right');

    map.on('load', async () => {
      await loadData();
      buildLookups();
      addSources();
      addLayers();
      setupInteractions();
      setupControls();

      // Apply saved favorites after map is ready
      if (window.Favorites) {
        window.Favorites.applyToMap();
      }
    });
  }

  /* ────────────────── Data Loading ────────────────── */

  async function loadData() {
    const [zones, schools] = await Promise.all([
      fetch('/data/zones.geojson').then(r => r.json()),
      fetch('/data/schools.geojson').then(r => r.json()),
    ]);
    zonesData = zones;
    schoolsData = schools;
  }

  function buildLookups() {
    // Schools by system_code
    for (const feat of schoolsData.features) {
      const p = feat.properties;
      const sc = p.system_code;
      schoolsByCode[sc] = p;
      schoolCoords[sc] = feat.geometry.coordinates;
    }

    // Map system_codes to zone dbn strings (handles comma-separated multi-school zones)
    for (const feat of zonesData.features) {
      const rawDbn = feat.properties.dbn;
      if (!rawDbn) continue;
      const parts = rawDbn.split(',');
      for (const part of parts) {
        schoolToZoneDbn[part.trim()] = rawDbn;
      }
    }
  }

  /* ────────────────── Sources & Layers ────────────────── */

  function addSources() {
    map.addSource('zones', {
      type: 'geojson',
      data: zonesData,
      promoteId: 'dbn',
    });

    map.addSource('schools', {
      type: 'geojson',
      data: schoolsData,
      promoteId: 'system_code',
    });
  }

  function addLayers() {
    // ── Zone fills ──
    map.addLayer({
      id: 'zone-fills',
      type: 'fill',
      source: 'zones',
      paint: {
        'fill-color': [
          'match',
          ['coalesce', ['feature-state', 'preference'], 'none'],
          'top-choice', PREFERENCE_COLORS['top-choice'],
          'strong',     PREFERENCE_COLORS['strong'],
          'interested', PREFERENCE_COLORS['interested'],
          'not-interested', PREFERENCE_COLORS['not-interested'],
          '#94a3b8'
        ],
        'fill-opacity': [
          'case',
          ['boolean', ['feature-state', 'selected'], false],
          0.3,
          ['==', ['coalesce', ['feature-state', 'preference'], 'none'], 'none'],
          0.06,
          0.28
        ],
      },
    });

    // ── Zone outlines ──
    map.addLayer({
      id: 'zone-outlines',
      type: 'line',
      source: 'zones',
      paint: {
        'line-color': [
          'case',
          ['boolean', ['feature-state', 'selected'], false],
          '#0f172a',
          ['boolean', ['feature-state', 'hover'], false],
          '#1e293b',
          [
            'match',
            ['coalesce', ['feature-state', 'preference'], 'none'],
            'top-choice', PREFERENCE_COLORS['top-choice'],
            'strong',     PREFERENCE_COLORS['strong'],
            'interested', PREFERENCE_COLORS['interested'],
            'not-interested', PREFERENCE_COLORS['not-interested'],
            '#94a3b8'
          ]
        ],
        'line-width': [
          'case',
          ['boolean', ['feature-state', 'selected'], false],
          3,
          ['boolean', ['feature-state', 'hover'], false],
          2.5,
          1
        ],
        'line-opacity': 0.7,
      },
    });

    // ── School points ──
    map.addLayer({
      id: 'school-points',
      type: 'circle',
      source: 'schools',
      filter: ['==', ['get', 'status'], 'Open'],
      paint: {
        'circle-radius': [
          'interpolate', ['linear'], ['zoom'],
          10, 3.5,
          14, 7,
          17, 12,
        ],
        'circle-color': [
          'match',
          ['coalesce', ['feature-state', 'preference'], 'none'],
          'top-choice', PREFERENCE_COLORS['top-choice'],
          'strong',     PREFERENCE_COLORS['strong'],
          'interested', PREFERENCE_COLORS['interested'],
          'not-interested', PREFERENCE_COLORS['not-interested'],
          '#475569'
        ],
        'circle-stroke-width': [
          'case',
          ['boolean', ['feature-state', 'selected'], false],
          3,
          1.5
        ],
        'circle-stroke-color': [
          'case',
          ['boolean', ['feature-state', 'selected'], false],
          '#0f172a',
          '#ffffff'
        ],
        'circle-opacity': 0.9,
      },
    });

    // ── Selected school label (dedicated source, always visible) ──
    map.addSource('selected-school', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });

    map.addLayer({
      id: 'selected-school-label',
      type: 'symbol',
      source: 'selected-school',
      layout: {
        'text-field': ['get', 'location_name'],
        'text-size': 13,
        'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
        'text-offset': [0, 1.5],
        'text-anchor': 'top',
        'text-max-width': 14,
        'text-allow-overlap': true,
      },
      paint: {
        'text-color': '#0f172a',
        'text-halo-color': '#ffffff',
        'text-halo-width': 2,
      },
    });
  }

  /* ────────────────── Interactions ────────────────── */

  function setupInteractions() {
    let hoveredZoneId = null;

    // ── Zone hover ──
    map.on('mousemove', 'zone-fills', (e) => {
      if (e.features.length === 0) return;
      if (hoveredZoneId !== null) {
        map.setFeatureState({ source: 'zones', id: hoveredZoneId }, { hover: false });
      }
      hoveredZoneId = e.features[0].id;
      map.setFeatureState({ source: 'zones', id: hoveredZoneId }, { hover: true });
      map.getCanvas().style.cursor = 'pointer';
    });

    map.on('mouseleave', 'zone-fills', () => {
      if (hoveredZoneId !== null) {
        map.setFeatureState({ source: 'zones', id: hoveredZoneId }, { hover: false });
        hoveredZoneId = null;
      }
      map.getCanvas().style.cursor = '';
    });

    // ── Unified click: subway stations > school points > zones ──
    map.on('click', (e) => {
      // Check subway stations first (if layer exists and visible)
      if (map.getLayer('subway-stations-layer')) {
        const stationFeatures = map.queryRenderedFeatures(e.point, {
          layers: ['subway-stations-layer'],
        });
        if (stationFeatures.length > 0) return; // handled by subway.js click handler
      }

      // Check school points
      const schoolFeatures = map.queryRenderedFeatures(e.point, {
        layers: ['school-points'],
      });
      if (schoolFeatures.length > 0) {
        selectSchool(schoolFeatures[0].properties.system_code);
        return;
      }

      // Then check zones
      const zoneFeatures = map.queryRenderedFeatures(e.point, {
        layers: ['zone-fills'],
      });
      if (zoneFeatures.length > 0) {
        const rawDbn = zoneFeatures[0].properties.dbn;
        if (rawDbn) {
          const primaryDbn = rawDbn.split(',')[0].trim();
          if (schoolsByCode[primaryDbn]) {
            selectSchool(primaryDbn);
            return;
          }
        }
      }

      // Click on empty area → deselect
      deselectSchool();
    });

    // ── Hover cursor ──
    // Zone hover already sets/clears the cursor via its own listeners; the
    // school-points listeners only need to flip to pointer on enter. We
    // intentionally don't clear on leave — the zone-fills mouseleave handler
    // (above) handles the cleanup when leaving the underlying zone.
    map.on('mouseenter', 'school-points', () => {
      map.getCanvas().style.cursor = 'pointer';
    });
  }

  /* ────────────────── Selection ────────────────── */

  function selectSchool(systemCode) {
    // Clear previous selection (school point + zone)
    if (selectedSchool) {
      map.setFeatureState(
        { source: 'schools', id: selectedSchool },
        { selected: false }
      );
    }
    if (selectedZoneDbn) {
      map.setFeatureState(
        { source: 'zones', id: selectedZoneDbn },
        { selected: false }
      );
      selectedZoneDbn = null;
    }

    selectedSchool = systemCode;
    map.setFeatureState(
      { source: 'schools', id: systemCode },
      { selected: true }
    );

    // Show label for selected school + detail panel
    const coords = schoolCoords[systemCode];
    const props = schoolsByCode[systemCode];
    if (coords && props) {
      map.getSource('selected-school').setData({
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          geometry: { type: 'Point', coordinates: coords },
          properties: { location_name: props.location_name },
        }],
      });
    }

    // Also highlight the associated zone if one exists
    const zoneDbn = schoolToZoneDbn[systemCode];
    if (zoneDbn) {
      selectedZoneDbn = zoneDbn;
      map.setFeatureState(
        { source: 'zones', id: zoneDbn },
        { selected: true }
      );
    }

    // Show detail panel
    if (props && window.Favorites) {
      window.Favorites.showDetail(systemCode, props);
    }
  }

  function deselectSchool() {
    if (selectedSchool) {
      map.setFeatureState(
        { source: 'schools', id: selectedSchool },
        { selected: false }
      );
      selectedSchool = null;
    }
    if (selectedZoneDbn) {
      map.setFeatureState(
        { source: 'zones', id: selectedZoneDbn },
        { selected: false }
      );
      selectedZoneDbn = null;
    }
    // Clear selected label
    map.getSource('selected-school').setData({
      type: 'FeatureCollection',
      features: [],
    });
    if (window.Favorites) {
      window.Favorites.hideDetail();
    }
  }

  /* ────────────────── Layer Controls ────────────────── */

  function setupControls() {
    document.getElementById('toggle-zones').addEventListener('click', function () {
      this.classList.toggle('active');
      const vis = this.classList.contains('active') ? 'visible' : 'none';
      map.setLayoutProperty('zone-fills', 'visibility', vis);
      map.setLayoutProperty('zone-outlines', 'visibility', vis);
    });

    document.getElementById('toggle-schools').addEventListener('click', function () {
      this.classList.toggle('active');
      const vis = this.classList.contains('active') ? 'visible' : 'none';
      map.setLayoutProperty('school-points', 'visibility', vis);
      map.setLayoutProperty('selected-school-label', 'visibility', vis);
    });
  }

  /* ────────────────── Public API ────────────────── */

  function flyToSchool(systemCode) {
    const coords = schoolCoords[systemCode];
    if (!coords) return;
    map.flyTo({ center: coords, zoom: 15, duration: 1200 });
    selectSchool(systemCode);
  }

  function setFeaturePreference(systemCode, level) {
    // Color the school point
    map.setFeatureState(
      { source: 'schools', id: systemCode },
      { preference: level }
    );

    // Color the associated zone
    const zoneDbn = schoolToZoneDbn[systemCode];
    if (zoneDbn) {
      map.setFeatureState(
        { source: 'zones', id: zoneDbn },
        { preference: level }
      );
    }
  }

  function clearFeaturePreference(systemCode) {
    map.setFeatureState(
      { source: 'schools', id: systemCode },
      { preference: null }
    );

    const zoneDbn = schoolToZoneDbn[systemCode];
    if (zoneDbn) {
      map.setFeatureState(
        { source: 'zones', id: zoneDbn },
        { preference: null }
      );
    }
  }

  function getSchoolProperties(systemCode) {
    return schoolsByCode[systemCode] || null;
  }

  function getAllSchools() {
    return schoolsByCode;
  }

  function hasZone(systemCode) {
    return !!schoolToZoneDbn[systemCode];
  }

  function _getMap() {
    return map;
  }

  return {
    init,
    flyToSchool,
    setFeaturePreference,
    clearFeaturePreference,
    getSchoolProperties,
    getAllSchools,
    hasZone,
    _getMap,
  };
})();
