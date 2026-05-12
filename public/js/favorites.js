/**
 * favorites.js — Preference management, sidebar rendering, search.
 *
 * Persists to server via /api/users/:username/favorites with localStorage as offline cache.
 *
 * Exposes window.Favorites with:
 *   init()                        — load from server, bind events, render
 *   applyToMap()                  — push all saved prefs to map feature-state
 *   showDetail(systemCode, props) — populate detail panel
 *   hideDetail()                  — close detail panel
 */
window.Favorites = (function () {
  'use strict';

  const STORAGE_PREFIX = 'nyc-schools-favorites-';

  function storageKey() {
    const user = Auth.getUser();
    return user ? STORAGE_PREFIX + user : STORAGE_PREFIX + '__anon';
  }

  const PREFERENCE_LEVELS = {
    'top-choice': { label: 'Top Choice', color: '#16a34a', icon: '★', order: 0 },
    'strong':     { label: 'Strong Interest', color: '#2563eb', icon: '●', order: 1 },
    'interested': { label: 'Interested', color: '#ca8a04', icon: '◆', order: 2 },
    'not-interested': { label: 'Not Interested', color: '#ef4444', icon: '○', order: 3 },
  };

  // favorites = { systemCode: { level: 'top-choice', name: 'P.S. 001 ...' }, ... }
  let favorites = {};
  let currentDetail = null; // system_code of school shown in detail panel
  let testScores = null;    // loaded from /data/test-scores.json

  /* ────────────────── Init ────────────────── */

  async function init() {
    loadFromLocalStorage(); // immediate cache for fast render
    bindEvents();
    renderFavorites();

    // Then sync from server (authoritative source)
    await loadFromServer();
    renderFavorites();

    // Load test scores (fire-and-forget)
    loadTestScores();
  }

  function loadFromLocalStorage() {
    try {
      const raw = localStorage.getItem(storageKey());
      if (raw) favorites = JSON.parse(raw);
    } catch (e) {
      favorites = {};
    }
  }

  function saveToLocalStorage() {
    localStorage.setItem(storageKey(), JSON.stringify(favorites));
  }

  function userApiBase() {
    const user = Auth.getUser();
    if (!user) return null;
    return `/api/users/${encodeURIComponent(user)}/favorites`;
  }

  async function loadFromServer() {
    try {
      const base = userApiBase();
      if (!base) return;
      const res = await fetch(base);
      if (!res.ok) return;

      const serverFavs = await res.json();

      // Server is authoritative — replace local state entirely
      favorites = serverFavs;
      saveToLocalStorage();
    } catch (e) {
      console.warn('Could not load favorites from server, using local cache:', e);
    }
  }

  async function serverPut(systemCode, level, name) {
    const base = userApiBase();
    if (!base) return;
    try {
      await fetch(`${base}/${encodeURIComponent(systemCode)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level, name }),
      });
    } catch (e) {
      console.warn('Could not save favorite to server:', e);
    }
  }

  async function serverDelete(systemCode) {
    const base = userApiBase();
    if (!base) return;
    try {
      await fetch(`${base}/${encodeURIComponent(systemCode)}`, {
        method: 'DELETE',
      });
    } catch (e) {
      console.warn('Could not delete favorite from server:', e);
    }
  }

  /* ────────────────── Events ────────────────── */

  function bindEvents() {
    // Preference selector change
    document.getElementById('preference-select').addEventListener('change', function () {
      if (!currentDetail) return;
      const level = this.value;
      if (level) {
        setPreference(currentDetail, level);
      } else {
        removePreference(currentDetail);
      }
    });

    // Detail close button
    document.getElementById('detail-close').addEventListener('click', () => {
      hideDetail();
    });

    // Sidebar toggle
    document.getElementById('sidebar-toggle').addEventListener('click', () => {
      const sidebar = document.getElementById('sidebar');
      const toggle = document.getElementById('sidebar-toggle');
      sidebar.classList.toggle('collapsed');
      toggle.title = sidebar.classList.contains('collapsed') ? 'Expand sidebar' : 'Collapse sidebar';
    });

    // Search input
    const searchInput = document.getElementById('search-input');
    let searchTimeout;
    searchInput.addEventListener('input', function () {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => performSearch(this.value), 150);
    });

    // Clear search on escape
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        searchInput.value = '';
        document.getElementById('search-results').innerHTML = '';
      }
    });
  }

  /* ────────────────── Preferences ────────────────── */

  function setPreference(systemCode, level) {
    const props = SchoolMap.getSchoolProperties(systemCode);
    const name = props ? props.location_name : systemCode;

    favorites[systemCode] = { level, name };
    saveToLocalStorage();
    renderFavorites();
    SchoolMap.setFeaturePreference(systemCode, level);

    // Fire-and-forget server sync
    serverPut(systemCode, level, name);
  }

  function removePreference(systemCode) {
    delete favorites[systemCode];
    saveToLocalStorage();
    renderFavorites();
    SchoolMap.clearFeaturePreference(systemCode);

    // Reset selector if this school is currently shown
    if (currentDetail === systemCode) {
      document.getElementById('preference-select').value = '';
    }

    // Fire-and-forget server sync
    serverDelete(systemCode);
  }

  function applyToMap() {
    for (const [sc, fav] of Object.entries(favorites)) {
      SchoolMap.setFeaturePreference(sc, fav.level);
    }
  }

  /* ────────────────── Detail Panel ────────────────── */

  function showDetail(systemCode, props) {
    currentDetail = systemCode;
    const panel = document.getElementById('detail-panel');
    panel.classList.remove('hidden');

    document.getElementById('detail-name').textContent = props.location_name || systemCode;
    document.getElementById('detail-address').textContent = props.address || '—';
    document.getElementById('detail-district').textContent =
      `District ${props.district || '?'}, ${boroughName(props.borough)}`;
    document.getElementById('detail-grades').textContent = formatGrades(props.grades);
    document.getElementById('detail-principal').textContent = props.principal || '—';
    document.getElementById('detail-phone').textContent = props.phone || '—';
    document.getElementById('detail-nta').textContent = props.NTA_name || '—';
    document.getElementById('detail-status').textContent = props.status || '—';

    // Set preference selector
    const fav = favorites[systemCode];
    document.getElementById('preference-select').value = fav ? fav.level : '';

    // Render test scores
    renderScores(systemCode);
  }

  function hideDetail() {
    currentDetail = null;
    document.getElementById('detail-panel').classList.add('hidden');
  }

  /* ────────────────── Favorites Rendering ────────────────── */

  function renderFavorites() {
    const container = document.getElementById('favorites-list');

    const entries = Object.entries(favorites);
    if (entries.length === 0) {
      container.innerHTML =
        '<p class="empty-state">No favorites yet. Click a school and set a preference level.</p>';
      return;
    }

    // Group by level
    const groups = {};
    for (const [sc, fav] of entries) {
      if (!groups[fav.level]) groups[fav.level] = [];
      groups[fav.level].push({ systemCode: sc, name: fav.name });
    }

    // Sort groups by defined order
    const sortedLevels = Object.keys(PREFERENCE_LEVELS).filter((l) => groups[l]);

    let html = '';
    for (const level of sortedLevels) {
      const config = PREFERENCE_LEVELS[level];
      html += `<div class="favorites-group">`;
      html += `<div class="favorites-group-label">
        <span class="pref-dot" style="background:${config.color}"></span>
        ${config.label}
      </div>`;
      for (const item of groups[level].sort((a, b) => a.name.localeCompare(b.name))) {
        html += `<div class="fav-item" data-sc="${item.systemCode}">
          <span class="fav-item-name">${escapeHtml(item.name)}</span>
          <button class="fav-item-remove" data-sc="${item.systemCode}" title="Remove">&times;</button>
        </div>`;
      }
      html += `</div>`;
    }

    container.innerHTML = html;

    // Bind click events
    container.querySelectorAll('.fav-item').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (e.target.classList.contains('fav-item-remove')) return;
        SchoolMap.flyToSchool(el.dataset.sc);
      });
    });

    container.querySelectorAll('.fav-item-remove').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        removePreference(btn.dataset.sc);
      });
    });
  }

  /* ────────────────── Search ────────────────── */

  function performSearch(query) {
    const container = document.getElementById('search-results');
    const trimmed = query.trim().toLowerCase();

    if (trimmed.length < 2) {
      container.innerHTML = '';
      return;
    }

    const allSchools = SchoolMap.getAllSchools();
    const results = [];

    for (const [sc, props] of Object.entries(allSchools)) {
      if (props.status !== 'Open') continue;
      const haystack = `${props.location_name} ${props.address} ${props.NTA_name}`.toLowerCase();
      if (haystack.includes(trimmed)) {
        results.push({ systemCode: sc, props });
      }
      if (results.length >= 20) break;
    }

    if (results.length === 0) {
      container.innerHTML = '<p class="empty-state">No matching schools.</p>';
      return;
    }

    let html = '';
    for (const r of results) {
      const hasZone = SchoolMap.hasZone(r.systemCode) ? '' : ' (no zone)';
      html += `<div class="search-result-item" data-sc="${r.systemCode}">
        <div class="school-name">${escapeHtml(r.props.location_name)}</div>
        <div class="school-meta">${escapeHtml(r.props.address)} · D${r.props.district}${hasZone}</div>
      </div>`;
    }
    container.innerHTML = html;

    container.querySelectorAll('.search-result-item').forEach((el) => {
      el.addEventListener('click', () => {
        SchoolMap.flyToSchool(el.dataset.sc);
        document.getElementById('search-input').value = '';
        container.innerHTML = '';
      });
    });
  }

  /* ────────────────── Test Scores ────────────────── */

  async function loadTestScores() {
    try {
      const res = await fetch('/data/test-scores.json');
      if (!res.ok) return;
      testScores = await res.json();
      console.log(`Loaded test scores for ${Object.keys(testScores).length} schools`);
      // Re-render if detail panel is open
      if (currentDetail) {
        renderScores(currentDetail);
      }
    } catch (e) {
      console.warn('Could not load test scores:', e);
    }
  }

  function renderScores(systemCode) {
    const container = document.getElementById('detail-scores');
    if (!container) return;

    const schoolScores = testScores ? testScores[systemCode] : null;
    if (!schoolScores) {
      container.classList.add('hidden');
      return;
    }

    // Find most recent year with data
    const years = Object.keys(schoolScores).sort().reverse();
    if (years.length === 0) {
      container.classList.add('hidden');
      return;
    }

    const latestYear = years[0];
    const latestData = schoolScores[latestYear];
    container.classList.remove('hidden');

    // Render ELA
    renderSubjectScores('ela', latestData.ELA, schoolScores, years, 'ELA');
    // Render Math
    renderSubjectScores('math', latestData.Math, schoolScores, years, 'Math');

    // Meta line
    const tested = latestData.ELA?.All?.tested || latestData.Math?.All?.tested || '?';
    document.getElementById('scores-meta').textContent =
      `${latestYear} · ${tested} students tested · NYS Grades 3–8 Assessments`;
  }

  function renderSubjectScores(prefix, subjectData, allYears, yearList, subjectKey) {
    const pctEl = document.getElementById(`scores-${prefix}-pct`);
    const gradesEl = document.getElementById(`scores-${prefix}-grades`);
    const trendEl = document.getElementById(`scores-${prefix}-trend`);

    if (!subjectData || !subjectData.All) {
      pctEl.textContent = 'N/A';
      pctEl.className = 'scores-headline';
      gradesEl.innerHTML = '';
      trendEl.innerHTML = '';
      return;
    }

    const pct = subjectData.All.pct_proficient;
    pctEl.textContent = Math.round(pct) + '%';
    pctEl.className = 'scores-headline ' + scoreColorClass(pct, 'score-');

    // Per-grade bars
    const grades = ['3', '4', '5', '6', '7', '8'].filter(g => subjectData[g]);
    let gradesHtml = '';
    for (const g of grades) {
      const gPct = subjectData[g].pct_proficient;
      const barColor = scoreColorClass(gPct, 'bar-');
      gradesHtml += `
        <div class="scores-grade-row">
          <span class="scores-grade-label">Gr ${g}</span>
          <div class="scores-grade-bar-track">
            <div class="scores-grade-bar ${barColor}" style="width:${Math.min(gPct, 100)}%"></div>
          </div>
          <span class="scores-grade-value">${Math.round(gPct)}%</span>
        </div>`;
    }
    gradesEl.innerHTML = gradesHtml;

    // 3-year trend
    if (yearList.length >= 2) {
      // pct is already the latest year's value (extracted above)
      const latestPct = pct;
      const prevPct = allYears[yearList[1]]?.[subjectKey]?.All?.pct_proficient;
      if (latestPct != null && prevPct != null) {
        const delta = latestPct - prevPct;
        const absDelta = Math.abs(delta).toFixed(1);
        let arrowClass, arrowChar;
        if (delta > 1) {
          arrowClass = 'up'; arrowChar = '▲';
        } else if (delta < -1) {
          arrowClass = 'down'; arrowChar = '▼';
        } else {
          arrowClass = 'flat'; arrowChar = '▬';
        }

        // Build mini sparkline text
        const trendYears = yearList.slice(0, 3).reverse();
        const trendPcts = trendYears.map(y =>
          allYears[y]?.[subjectKey]?.All?.pct_proficient
        ).filter(v => v != null);
        const sparkText = trendPcts.map(v => Math.round(v) + '%').join(' → ');

        trendEl.innerHTML = `
          <span class="trend-arrow ${arrowClass}">${arrowChar}</span>
          <span>${delta > 0 ? '+' : ''}${absDelta}pp</span>
          <span style="margin-left:4px;font-size:10px;color:#94a3b8">${sparkText}</span>`;
      } else {
        trendEl.innerHTML = '';
      }
    } else {
      trendEl.innerHTML = '';
    }
  }

  function scoreColorClass(pct, prefix) {
    if (pct >= 60) return prefix + 'green';
    if (pct >= 40) return prefix + 'yellow';
    return prefix + 'red';
  }

  /* ────────────────── Helpers ────────────────── */

  function boroughName(code) {
    const map = { K: 'Brooklyn', M: 'Manhattan', Q: 'Queens', R: 'Staten Island', X: 'Bronx' };
    return map[code] || code;
  }

  function formatGrades(gradesStr) {
    if (!gradesStr) return '—';
    return gradesStr
      .split(',')
      .map((g) => {
        g = g.trim();
        if (g === 'PK') return 'Pre-K';
        if (g === '0K') return 'K';
        if (g.match(/^0\d$/)) return g.replace(/^0/, '');
        return g;
      })
      .join(', ');
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  return {
    init,
    applyToMap,
    showDetail,
    hideDetail,
  };
})();
