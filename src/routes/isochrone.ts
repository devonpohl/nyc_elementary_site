import { Router, Request, Response } from 'express';

const router = Router();

const ORS_API_KEY = process.env.ORS_API_KEY || '';
const TRAVELTIME_APP_ID = process.env.TRAVELTIME_APP_ID || '';
const TRAVELTIME_API_KEY = process.env.TRAVELTIME_API_KEY || '';

// ── GET /api/isochrone/status — which providers are configured ──
router.get('/status', (_req: Request, res: Response) => {
  res.json({
    driving: !!ORS_API_KEY,
    transit: !!(TRAVELTIME_APP_ID && TRAVELTIME_API_KEY),
  });
});

// Geocoding is handled client-side (direct Nominatim call from browser)

// ── GET /api/isochrone/driving?lat=...&lng=...&minutes=10,20,30 ──
router.get('/driving', async (req: Request, res: Response) => {
  if (!ORS_API_KEY) {
    res.status(503).json({ error: 'ORS_API_KEY not configured' });
    return;
  }

  const lat = parseFloat(req.query.lat as string);
  const lng = parseFloat(req.query.lng as string);
  const minutes = (req.query.minutes as string || '10,20,30')
    .split(',')
    .map((m) => parseInt(m, 10) * 60); // convert to seconds

  if (isNaN(lat) || isNaN(lng)) {
    res.status(400).json({ error: 'lat and lng required' });
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
    res.json(data);
  } catch (e) {
    console.error('Isochrone driving error:', e);
    res.status(502).json({ error: 'Isochrone request failed' });
  }
});

// ── GET /api/isochrone/transit?lat=...&lng=...&minutes=10,20,30 ──
router.get('/transit', async (req: Request, res: Response) => {
  if (!TRAVELTIME_APP_ID || !TRAVELTIME_API_KEY) {
    res.status(503).json({ error: 'TravelTime API not configured' });
    return;
  }

  const lat = parseFloat(req.query.lat as string);
  const lng = parseFloat(req.query.lng as string);
  const minutesStr = (req.query.minutes as string || '10,20,30');
  const minutesList = minutesStr.split(',').map((m) => parseInt(m, 10));

  if (isNaN(lat) || isNaN(lng)) {
    res.status(400).json({ error: 'lat and lng required' });
    return;
  }

  try {
    // TravelTime expects one request per time range; we'll use the max
    // and let the client handle the visual banding, or make parallel requests.
    // For simplicity, request the largest time and return it.
    // TravelTime's time-map endpoint returns isochrone polygons.
    const maxMinutes = Math.max(...minutesList);

    const body = {
      departure_searches: minutesList.map((mins, i) => ({
        id: `isochrone_${mins}`,
        coords: { lat, lng },
        departure_time: new Date().toISOString(),
        travel_time: mins * 60,
        transportation: { type: 'public_transport' as const },
      })),
    };

    const response = await fetch(
      'https://api.traveltimeapp.com/v4/time-map',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Application-Id': TRAVELTIME_APP_ID,
          'X-Api-Key': TRAVELTIME_API_KEY,
          'Accept': 'application/geo+json',
        },
        body: JSON.stringify(body),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error('TravelTime error:', response.status, errText);
      res.status(response.status).json({ error: 'TravelTime request failed', detail: errText });
      return;
    }

    const data = await response.json();
    res.json(data);
  } catch (e) {
    console.error('Isochrone transit error:', e);
    res.status(502).json({ error: 'Isochrone request failed' });
  }
});

export default router;
