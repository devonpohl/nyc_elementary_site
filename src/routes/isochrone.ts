import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';

const router = Router();

const ORS_API_KEY = process.env.ORS_API_KEY || '';
const GEOAPIFY_API_KEY = process.env.GEOAPIFY_API_KEY || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../data');
const CACHE_PATH = path.join(DATA_DIR, 'isochrone-cache.json');
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ── Cache helpers ──

interface CacheEntry {
  timestamp: number;
  geojson: any;
}

interface IsoCache {
  [key: string]: CacheEntry;
}

function loadCache(): IsoCache {
  try {
    if (fs.existsSync(CACHE_PATH)) {
      return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
    }
  } catch (e) {
    console.warn('Failed to load isochrone cache:', e);
  }
  return {};
}

function saveCache(cache: IsoCache): void {
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache));
  } catch (e) {
    console.warn('Failed to save isochrone cache:', e);
  }
}

function getCacheKey(mode: string, lat: number, lng: number, minutes: string): string {
  return `${mode}:${lat.toFixed(5)},${lng.toFixed(5)}:${minutes}`;
}

function getCached(key: string): any | null {
  const cache = loadCache();
  const entry = cache[key];
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) return null;
  return entry.geojson;
}

function setCache(key: string, geojson: any): void {
  const cache = loadCache();
  cache[key] = { timestamp: Date.now(), geojson };
  saveCache(cache);
}

// ── GET /api/isochrone/status — which providers are configured ──
router.get('/status', (_req: Request, res: Response) => {
  res.json({
    driving: !!ORS_API_KEY,
    transit: !!GEOAPIFY_API_KEY,
  });
});

// ── GET /api/isochrone/driving?lat=...&lng=...&minutes=10,20,30 ──
router.get('/driving', async (req: Request, res: Response) => {
  if (!ORS_API_KEY) {
    res.status(503).json({ error: 'ORS_API_KEY not configured' });
    return;
  }

  const lat = parseFloat(req.query.lat as string);
  const lng = parseFloat(req.query.lng as string);
  const minutesStr = (req.query.minutes as string) || '10,20,30';
  const minutes = minutesStr.split(',').map((m) => parseInt(m, 10) * 60);

  if (isNaN(lat) || isNaN(lng)) {
    res.status(400).json({ error: 'lat and lng required' });
    return;
  }

  // Check cache
  const cacheKey = getCacheKey('driving', lat, lng, minutesStr);
  const cached = getCached(cacheKey);
  if (cached) {
    console.log(`Isochrone cache hit: ${cacheKey}`);
    res.json(cached);
    return;
  }

  try {
    const response = await fetch(
      'https://api.openrouteservice.org/v2/isochrones/driving-car',
      {
        method: 'POST',
        headers: {
          'Authorization': ORS_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          locations: [[lng, lat]],
          range: minutes,
          range_type: 'time',
        }),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error('ORS error:', response.status, errText);
      res.status(response.status).json({ error: 'ORS request failed', detail: errText });
      return;
    }

    const data = await response.json();
    setCache(cacheKey, data);
    console.log(`Isochrone cached: ${cacheKey}`);
    res.json(data);
  } catch (e) {
    console.error('Isochrone driving error:', e);
    res.status(502).json({ error: 'Isochrone request failed' });
  }
});

// ── GET /api/isochrone/transit?lat=...&lng=...&minutes=30,35,40,45,50,55,60 ──
router.get('/transit', async (req: Request, res: Response) => {
  if (!GEOAPIFY_API_KEY) {
    res.status(503).json({ error: 'GEOAPIFY_API_KEY not configured' });
    return;
  }

  const lat = parseFloat(req.query.lat as string);
  const lng = parseFloat(req.query.lng as string);
  const minutesStr = (req.query.minutes as string) || '30,35,40,45,50,55,60';
  const minutesList = minutesStr.split(',').map((m) => parseInt(m, 10));

  if (isNaN(lat) || isNaN(lng)) {
    res.status(400).json({ error: 'lat and lng required' });
    return;
  }

  // Check cache
  const cacheKey = getCacheKey('transit', lat, lng, minutesStr);
  const cached = getCached(cacheKey);
  if (cached) {
    console.log(`Isochrone cache hit: ${cacheKey}`);
    res.json(cached);
    return;
  }

  try {
    // Geoapify accepts comma-separated seconds in range param
    const rangeSeconds = minutesList.map((m) => m * 60).join(',');
    const url = `https://api.geoapify.com/v1/isoline?lat=${lat}&lon=${lng}&type=time&mode=transit&range=${rangeSeconds}&apiKey=${GEOAPIFY_API_KEY}`;

    const response = await fetch(url);

    if (!response.ok) {
      const errText = await response.text();
      console.error('Geoapify error:', response.status, errText);
      res.status(response.status).json({ error: 'Geoapify request failed', detail: errText });
      return;
    }

    const data = await response.json();
    setCache(cacheKey, data);
    console.log(`Isochrone cached: ${cacheKey}`);
    res.json(data);
  } catch (e) {
    console.error('Isochrone transit error:', e);
    res.status(502).json({ error: 'Isochrone request failed' });
  }
});

export default router;
