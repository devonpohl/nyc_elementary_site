/**
 * housing.js — Housing listings layer with filters.
 *
 * Loads cached housing data from /api/housing and renders on map
 * with client-side filtering by price, bedrooms, and sqft.
 *
 * Exposes window.Housing with:
 *   init()  — load data, add layers, bind filter events
 */
window.Housing = (function () {
  'use strict';

  let housingData = null; // raw GeoJSON
  let visible = false;
  let popup = null;

  /* ────────────────── Init ────────────────── */

  async function init() {
    await checkStatus();
    bindEvents();
  }

  async function checkStatus() {
    try {
      const res = await fetch('/api/housing/status');
      if (!res.ok) return;
      const status = await res.json();
      const statusEl = document.getElementById('housing-status');

      if (!status.configured) {
        statusEl.textContent = 'Set RAPIDAPI_KEY to enable housing data.';
        statusEl.classList.remove('hidden');
        disableToggle();
        return;
      }

      if (!status.cached) {
        statusEl.textContent = 'Loading housing data (first fetch in progress)...';
        statusEl.classList.remove('hidden');
        // Poll until data is ready
        pollForData();
        return;
      }

      statusEl.textContent = `${status.totalListings} listings (updated ${status.ageMinutes}m ago)`;
      statusEl.classList.remove('hidden');
      enableToggle();
    } catch (e) {
      console.warn('Housing status check failed:', e);
    }
  }

  async function pollForData() {
    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/housing/status');
        const status = await res.json();
        if (status.cached && status.totalListings > 0) {
          clearInterval(interval);
          const statusEl = document.getElementById('housing-status');
          statusEl.textContent = `${status.totalListings} listings loaded`;
          enableToggle();
        }
      } catch (e) { /* keep polling */ }
    }, 5000);
  }

  function disableToggle() {
    const btn = document.getElementById('toggle-housing');
    if (btn) {
      btn.disabled = true;
      btn.title = 'RAPIDAPI_KEY not configured';
    }
  }

  function enableToggle() {
    const btn = document.getElementById('toggle-housing');
    if (btn) btn.disabled = false;
  }

  /* ────────────────── Data Loading ────────────────── */

  async function loadData() {
    if (housingData) return true;

    try {
      const res = await fetch('/api/housing');
      if (!res.ok) return false;
      housingData = await res.json();
      addSourceAndLayers();
      return true;
    } catch (e) {
      console.error('Failed to load housing data:', e);
      return false;
    }
  }

  function createHouseIcon(color) {
    const size = 28;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    // House shape
    ctx.fillStyle = color;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;

    // Roof (triangle)
    ctx.beginPath();
    ctx.moveTo(size / 2, 3);
    ctx.lineTo(size - 4, 13);
    ctx.lineTo(4, 13);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Body (rectangle)
    ctx.fillRect(6, 13, size - 12, 11);
    ctx.strokeRect(6, 13, size - 12, 11);

    // Door
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(12, 17, 4, 7);

    return ctx.getImageData(0, 0, size, size);
  }

  function addSourceAndLayers() {
    const map = SchoolMap._getMap();
    if (!map || !housingData) return;

    // Create house icons
    map.addImage('house-green', createHouseIcon('#16a34a'), { pixelRatio: 2 });
    map.addImage('house-orange', createHouseIcon('#ea580c'), { pixelRatio: 2 });

    map.addSource('housing', {
      type: 'geojson',
      data: housingData,
    });

    // For-sale markers (green house)
    map.addLayer({
      id: 'housing-for-sale',
      type: 'symbol',
      source: 'housing',
      filter: ['==', ['get', 'status'], 'for_sale'],
      layout: {
        'icon-image': 'house-green',
        'icon-size': [
          'interpolate', ['linear'], ['zoom'],
          10, 0.5,
          14, 0.85,
          17, 1.2,
        ],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
      paint: {
        'icon-opacity': 0.9,
      },
    }, 'school-points');

    // Recently sold markers (orange house)
    map.addLayer({
      id: 'housing-sold',
      type: 'symbol',
      source: 'housing',
      filter: ['==', ['get', 'status'], 'recently_sold'],
      layout: {
        'icon-image': 'house-orange',
        'icon-size': [
          'interpolate', ['linear'], ['zoom'],
          10, 0.5,
          14, 0.85,
          17, 1.2,
        ],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
      paint: {
        'icon-opacity': 0.9,
      },
    }, 'school-points');

    // Click handlers for popups
    map.on('click', 'housing-for-sale', showPopup);
    map.on('click', 'housing-sold', showPopup);

    map.on('mouseenter', 'housing-for-sale', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'housing-for-sale', () => { map.getCanvas().style.cursor = ''; });
    map.on('mouseenter', 'housing-sold', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'housing-sold', () => { map.getCanvas().style.cursor = ''; });

    applyFilters(); // apply initial filter state
  }

  /* ────────────────── Popup ────────────────── */

  function showPopup(e) {
    if (!e.features || e.features.length === 0) return;

    const props = e.features[0].properties;
    const coords = e.features[0].geometry.coordinates.slice();

    const priceStr = props.price ? '$' + Number(props.price).toLocaleString() : '—';
    const statusLabel = props.status === 'for_sale' ? 'For Sale' : 'Sold';
    const statusClass = props.status === 'for_sale' ? 'for-sale' : 'sold';
    const dateStr = props.status === 'for_sale'
      ? (props.list_date ? `Listed ${formatDate(props.list_date)}` : '')
      : (props.sold_date ? `Sold ${formatDate(props.sold_date)}` : '');

    const photoHtml = props.photo
      ? `<img class="housing-popup-photo" src="${props.photo}" alt="Property photo" onerror="this.style.display='none'">`
      : '';

    const html = `
      <div class="housing-popup">
        ${photoHtml}
        <div class="housing-popup-body">
          <div class="housing-popup-price">${priceStr}</div>
          <span class="housing-popup-status ${statusClass}">${statusLabel}</span>
          <div class="housing-popup-specs">
            ${props.beds != null ? props.beds + ' bd' : ''}
            ${props.baths != null ? ' · ' + props.baths + ' ba' : ''}
            ${props.sqft != null ? ' · ' + Number(props.sqft).toLocaleString() + ' sqft' : ''}
          </div>
          <div class="housing-popup-address">${props.address || ''}</div>
          <div class="housing-popup-meta">
            ${props.type ? capitalizeType(props.type) : ''}
            ${props.year_built ? ' · Built ' + props.year_built : ''}
          </div>
          ${dateStr ? '<div class="housing-popup-date">' + dateStr + '</div>' : ''}
        </div>
      </div>
    `;

    if (popup) popup.remove();
    popup = new maplibregl.Popup({ maxWidth: '300px', closeButton: true })
      .setLngLat(coords)
      .setHTML(html)
      .addTo(SchoolMap._getMap());
  }

  function formatDate(dateStr) {
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    } catch {
      return dateStr;
    }
  }

  function capitalizeType(type) {
    return type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  /* ────────────────── Visibility Toggle ────────────────── */

  async function toggle() {
    visible = !visible;
    const btn = document.getElementById('toggle-housing');

    if (visible) {
      const loaded = await loadData();
      if (!loaded) {
        visible = false;
        return;
      }
      btn.classList.add('active');
      setLayerVisibility('visible');
      document.getElementById('housing-filters').classList.remove('hidden');
    } else {
      btn.classList.remove('active');
      setLayerVisibility('none');
      document.getElementById('housing-filters').classList.add('hidden');
      if (popup) popup.remove();
    }
  }

  function setLayerVisibility(vis) {
    const map = SchoolMap._getMap();
    if (!map) return;
    if (map.getLayer('housing-for-sale')) map.setLayoutProperty('housing-for-sale', 'visibility', vis);
    if (map.getLayer('housing-sold')) map.setLayoutProperty('housing-sold', 'visibility', vis);
  }

  /* ────────────────── Filters ────────────────── */

  function bindEvents() {
    document.getElementById('toggle-housing').addEventListener('click', toggle);

    // Filter inputs — debounced
    const filterIds = [
      'housing-price-min', 'housing-price-max',
      'housing-sqft-min', 'housing-sqft-max',
      'housing-beds-min', 'housing-status-filter',
    ];
    let filterTimeout;
    for (const id of filterIds) {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('input', () => {
          clearTimeout(filterTimeout);
          filterTimeout = setTimeout(applyFilters, 200);
        });
        el.addEventListener('change', () => {
          clearTimeout(filterTimeout);
          applyFilters();
        });
      }
    }
  }

  function applyFilters() {
    const map = SchoolMap._getMap();
    if (!map || !housingData) return;

    const priceMin = parseNum('housing-price-min');
    const priceMax = parseNum('housing-price-max');
    const sqftMin = parseNum('housing-sqft-min');
    const sqftMax = parseNum('housing-sqft-max');
    const bedsMin = parseNum('housing-beds-min');
    const statusFilter = document.getElementById('housing-status-filter')?.value || 'both';

    // Build MapLibre filter expression
    const conditions = ['all'];

    if (priceMin !== null) conditions.push(['>=', ['to-number', ['get', 'price'], 0], priceMin]);
    if (priceMax !== null) conditions.push(['<=', ['to-number', ['get', 'price'], 0], priceMax]);
    if (sqftMin !== null) conditions.push(['>=', ['to-number', ['get', 'sqft'], 0], sqftMin]);
    if (sqftMax !== null) conditions.push(['<=', ['to-number', ['get', 'sqft'], 0], sqftMax]);
    if (bedsMin !== null) conditions.push(['>=', ['to-number', ['get', 'beds'], 0], bedsMin]);

    // Status-specific filters
    const forSaleFilter = [...conditions, ['==', ['get', 'status'], 'for_sale']];
    const soldFilter = [...conditions, ['==', ['get', 'status'], 'recently_sold']];

    if (map.getLayer('housing-for-sale')) {
      const vis = (statusFilter === 'both' || statusFilter === 'for_sale') ? 'visible' : 'none';
      map.setLayoutProperty('housing-for-sale', 'visibility', visible ? vis : 'none');
      map.setFilter('housing-for-sale', forSaleFilter);
    }

    if (map.getLayer('housing-sold')) {
      const vis = (statusFilter === 'both' || statusFilter === 'recently_sold') ? 'visible' : 'none';
      map.setLayoutProperty('housing-sold', 'visibility', visible ? vis : 'none');
      map.setFilter('housing-sold', soldFilter);
    }
  }

  function parseNum(elementId) {
    const el = document.getElementById(elementId);
    if (!el) return null;
    const val = parseFloat(el.value);
    return isNaN(val) ? null : val;
  }

  return { init };
})();
