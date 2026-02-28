import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';

const router = Router();

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '';
const RAPIDAPI_HOST = 'realty-in-us.p.rapidapi.com';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../data');
const CACHE_PATH = path.join(DATA_DIR, 'housing-cache.json');
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

interface GeoJSONFeature {
  type: 'Feature';
  geometry: { type: string; coordinates: number[] };
  properties: Record<string, any>;
}

interface GeoJSONFeatureCollection {
  type: 'FeatureCollection';
  features: GeoJSONFeature[];
}

interface HousingCache {
  timestamp: number;
  forSaleCount: number;
  soldCount: number;
  geojson: GeoJSONFeatureCollection;
}

// ── GET /api/housing — return cached GeoJSON ──
router.get('/', (_req: Request, res: Response) => {
  const cache = loadCache();
  if (!cache) {
    res.status(503).json({ error: 'Housing data not yet loaded. Check /api/housing/status.' });
    return;
  }
  res.json(cache.geojson);
});

// ── GET /api/housing/status — cache info ──
router.get('/status', (_req: Request, res: Response) => {
  const configured = !!RAPIDAPI_KEY;
  const cache = loadCache();
  res.json({
    configured,
    cached: !!cache,
    lastRefresh: cache ? new Date(cache.timestamp).toISOString() : null,
    ageMinutes: cache ? Math.round((Date.now() - cache.timestamp) / 60000) : null,
    forSaleCount: cache?.forSaleCount || 0,
    soldCount: cache?.soldCount || 0,
    totalListings: cache?.geojson?.features?.length || 0,
  });
});

// ── GET /api/housing/refresh — force a refresh ──
router.get('/refresh', async (_req: Request, res: Response) => {
  if (!RAPIDAPI_KEY) {
    res.status(503).json({ error: 'RAPIDAPI_KEY not configured' });
    return;
  }
  try {
    await refreshCache();
    const cache = loadCache();
    res.json({
      ok: true,
      forSaleCount: cache?.forSaleCount || 0,
      soldCount: cache?.soldCount || 0,
      totalListings: cache?.geojson?.features?.length || 0,
    });
  } catch (e: any) {
    console.error('Housing refresh error:', e);
    res.status(502).json({ error: 'Refresh failed', detail: e.message });
  }
});

// ── Cache management ──

function loadCache(): HousingCache | null {
  try {
    if (fs.existsSync(CACHE_PATH)) {
      const raw = fs.readFileSync(CACHE_PATH, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error('Error loading housing cache:', e);
  }
  return null;
}

function saveCache(cache: HousingCache): void {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache));
}

function isCacheStale(): boolean {
  const cache = loadCache();
  if (!cache) return true;
  // Treat empty cache as stale so we retry
  if ((cache.geojson?.features?.length || 0) === 0) return true;
  return (Date.now() - cache.timestamp) > CACHE_MAX_AGE_MS;
}

// ── API fetching ──

// Optional: set HOUSING_ZIP_CODES in .env as comma-separated list to narrow results
// e.g. HOUSING_ZIP_CODES=10001,10002,10003,11201,11215
const ZIP_CODES_ENV = process.env.HOUSING_ZIP_CODES || '';

// All NYC counties (boroughs) for FIPS-based filtering
const NYC_COUNTIES = ['New York', 'Kings', 'Queens', 'Bronx', 'Richmond'];

function getZipCodes(): string[] {
  return ZIP_CODES_ENV.split(',').map(z => z.trim()).filter(Boolean);
}

async function fetchForZip(
  status: 'for_sale' | 'recently_sold',
  zip: string,
  maxPages: number,
): Promise<any[]> {
  const allResults: any[] = [];
  const limit = 200;

  for (let page = 0; page < maxPages; page++) {
    const offset = page * limit;
    console.log(`  [${zip}] ${status} page ${page + 1} (offset ${offset})...`);

    const body: any = {
      limit,
      offset,
      status: [status === 'recently_sold' ? 'sold' : status],
      postal_code: zip,
      sort: { direction: 'desc', field: 'list_date' },
      beds_min: 3,
      sqft_min: 1500,
    };

    try {
      const response = await fetch('https://realty-in-us.p.rapidapi.com/properties/v3/list', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-RapidAPI-Key': RAPIDAPI_KEY,
          'X-RapidAPI-Host': RAPIDAPI_HOST,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`  [${zip}] RapidAPI error (${response.status}):`, errText.substring(0, 500));
        break;
      }

      const data: any = await response.json();
      // Log raw response structure on first page for debugging
      if (page === 0) {
        const topKeys = Object.keys(data || {});
        console.log(`  [${zip}] Response keys: ${topKeys.join(', ')}`);
        if (data?.data) console.log(`  [${zip}] data.data keys: ${Object.keys(data.data).join(', ')}`);
      }
      const total = data?.data?.home_search?.total ?? data?.meta?.total ?? '?';
      const results = data?.data?.home_search?.results || data?.data?.results || [];

      if (page === 0) {
        console.log(`  [${zip}] API reports ${total} total ${status} listings`);
      }

      if (results.length === 0) {
        if (page === 0) console.log(`  [${zip}] No results for ${status}`);
        break;
      }

      allResults.push(...results);
      console.log(`  [${zip}] Got ${results.length} (total: ${allResults.length})`);

      if (results.length < limit) break;
      await new Promise(resolve => setTimeout(resolve, 1500));
    } catch (e) {
      console.error(`  [${zip}] Fetch error:`, e);
      break;
    }
  }

  return allResults;
}

async function fetchListings(status: 'for_sale' | 'recently_sold'): Promise<any[]> {
  const zips = getZipCodes();

  if (zips.length > 0) {
    // Query each zip individually — guarantees the field name works
    const allResults: any[] = [];
    for (const zip of zips) {
      const results = await fetchForZip(status, zip, 3); // up to 600 per zip
      allResults.push(...results);
      await new Promise(resolve => setTimeout(resolve, 1200));
    }
    console.log(`  Total ${status} across ${zips.length} zips: ${allResults.length}`);
    return allResults;
  }

  // Fallback: broad NYC query
  console.log('  No HOUSING_ZIP_CODES set, using broad NYC query');
  return fetchForZip(status, '', 5);
}

// Fallback for no-zip broad query — override body for city-based search
const _origFetchForZip = fetchForZip;
// Patch: if zip is empty string, use city-based query instead
async function fetchListingsBroad(status: 'for_sale' | 'recently_sold', maxPages: number): Promise<any[]> {
  const allResults: any[] = [];
  const limit = 200;

  for (let page = 0; page < maxPages; page++) {
    const offset = page * limit;
    console.log(`  [NYC] ${status} page ${page + 1} (offset ${offset})...`);

    try {
      const response = await fetch('https://realty-in-us.p.rapidapi.com/properties/v3/list', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-RapidAPI-Key': RAPIDAPI_KEY,
          'X-RapidAPI-Host': RAPIDAPI_HOST,
        },
        body: JSON.stringify({
          limit,
          offset,
          status: [status === 'recently_sold' ? 'sold' : status],
          city: 'New York City',
          state_code: 'NY',
          sort: { direction: 'desc', field: 'list_date' },
          beds_min: 3,
          sqft_min: 1500,
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`  [NYC] RapidAPI error (${response.status}):`, errText.substring(0, 300));
        break;
      }

      const data: any = await response.json();
      const total = data?.data?.home_search?.total ?? '?';
      const results = data?.data?.home_search?.results || [];

      if (page === 0) console.log(`  [NYC] API reports ${total} total ${status}`);
      if (results.length === 0) break;

      allResults.push(...results);
      console.log(`  [NYC] Got ${results.length} (total: ${allResults.length})`);

      if (results.length < limit) break;
      await new Promise(resolve => setTimeout(resolve, 1500));
    } catch (e) {
      console.error(`  [NYC] Fetch error:`, e);
      break;
    }
  }
  return allResults;
}

function propertyToFeature(prop: any, status: string): GeoJSONFeature | null {
  // Extract coordinates
  const lat = prop?.location?.address?.coordinate?.lat
    || prop?.location?.coordinate?.lat
    || prop?.coordinate?.lat
    || prop?.latitude;
  const lng = prop?.location?.address?.coordinate?.lon
    || prop?.location?.coordinate?.lon
    || prop?.coordinate?.lon
    || prop?.longitude;

  if (!lat || !lng) return null;

  // Extract fields with defensive fallbacks
  const desc = prop?.description || {};
  const addr = prop?.location?.address || prop?.address || {};
  const price = prop?.list_price || prop?.price || desc?.list_price;
  const soldPrice = prop?.last_sold_price || prop?.sold_price;

  const beds = desc?.beds ?? prop?.beds;
  const baths = desc?.baths ?? prop?.baths;
  const sqft = desc?.sqft ?? prop?.sqft ?? desc?.lot_sqft;
  const type = desc?.type ?? prop?.type;
  const yearBuilt = desc?.year_built ?? prop?.year_built;

  const address = [
    addr?.line,
    addr?.city,
    addr?.state_code,
    addr?.postal_code,
  ].filter(Boolean).join(', ');

  const photo = prop?.primary_photo?.href
    || prop?.photos?.[0]?.href
    || null;

  const listDate = prop?.list_date || null;
  const soldDate = prop?.last_sold_date || prop?.sold_date || null;

  return {
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [lng, lat],
    },
    properties: {
      status,
      address: address || 'Unknown',
      price: status === 'recently_sold' ? (soldPrice || price) : price,
      beds: beds ?? null,
      baths: baths ?? null,
      sqft: sqft ?? null,
      type: type || 'unknown',
      year_built: yearBuilt || null,
      photo: photo ? photo.replace(/\{[^}]*\}/g, '') : null, // strip size placeholders
      list_date: listDate,
      sold_date: soldDate,
      property_id: prop?.property_id || null,
    },
  };
}

async function refreshCache(): Promise<void> {
  console.log('Housing: Starting cache refresh...');

  // Sequential to avoid rate limiting (free tier is strict)
  const forSaleRaw = await fetchListings('for_sale');
  await new Promise(resolve => setTimeout(resolve, 2000));
  const soldRaw = await fetchListings('recently_sold');

  const features: GeoJSONFeature[] = [];

  for (const prop of forSaleRaw) {
    const feat = propertyToFeature(prop, 'for_sale');
    if (feat) features.push(feat);
  }

  let forSaleCount = features.length;

  // Filter sold homes to last 12 months
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  const oneYearAgoStr = oneYearAgo.toISOString().slice(0, 10); // YYYY-MM-DD

  for (const prop of soldRaw) {
    const feat = propertyToFeature(prop, 'recently_sold');
    if (!feat) continue;
    const soldDate = feat.properties.sold_date || feat.properties.list_date;
    if (soldDate && soldDate < oneYearAgoStr) continue; // skip older than 1 year
    features.push(feat);
  }

  let soldCount = features.length - forSaleCount;
  console.log(`Housing: Filtered sold to last 12 months — kept ${soldCount} of ${soldRaw.length} raw sold listings`);

  // Deduplicate by property_id
  const seen = new Set<string>();
  const deduped = features.filter(f => {
    const id = f.properties?.property_id;
    if (!id || seen.has(id)) return !id; // keep items without id, skip dupes
    seen.add(id);
    return true;
  });

  const cache: HousingCache = {
    timestamp: Date.now(),
    forSaleCount,
    soldCount,
    geojson: {
      type: 'FeatureCollection',
      features: deduped,
    },
  };

  saveCache(cache);
  console.log(`Housing: Cache refreshed — ${forSaleCount} for sale, ${soldCount} recently sold, ${deduped.length} total features.`);
}

// ── Auto-refresh on startup + interval ──

export function initHousingRefresh(): void {
  if (!RAPIDAPI_KEY) {
    console.log('Housing: RAPIDAPI_KEY not set, skipping auto-refresh.');
    return;
  }

  // Refresh on startup if cache is stale
  if (isCacheStale()) {
    console.log('Housing: Cache is stale, refreshing...');
    refreshCache().catch(e => console.error('Housing startup refresh failed:', e));
  } else {
    const cache = loadCache();
    console.log(`Housing: Using cached data (${cache?.geojson?.features?.length || 0} listings, ${Math.round((Date.now() - (cache?.timestamp || 0)) / 60000)} min old)`);
  }

  // Schedule daily refresh
  setInterval(() => {
    console.log('Housing: Scheduled daily refresh...');
    refreshCache().catch(e => console.error('Housing scheduled refresh failed:', e));
  }, CACHE_MAX_AGE_MS);
}

export default router;
