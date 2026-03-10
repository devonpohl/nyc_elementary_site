import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs';
import authRouter from './routes/auth';
import favoritesRouter from './routes/favorites';
import isochroneRouter from './routes/isochrone';
import housingRouter, { initHousingRefresh } from './routes/housing';

// Ensure DATA_DIR exists on startup (critical for Railway volume on first deploy)
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
fs.mkdirSync(DATA_DIR, { recursive: true });
console.log(`Data directory: ${DATA_DIR}`);

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(express.json());

// Serve static frontend
app.use(express.static(path.join(__dirname, '../public')));

// Serve static data files (GeoJSON, test-scores, etc.) — NOT user data
// These live in the repo's data/ directory, never on the volume
const STATIC_DATA_DIR = path.join(__dirname, '../data');
app.get('/data/schools.geojson', (_req, res) => res.sendFile(path.join(STATIC_DATA_DIR, 'schools.geojson')));
app.get('/data/zones.geojson', (_req, res) => res.sendFile(path.join(STATIC_DATA_DIR, 'zones.geojson')));
app.get('/data/test-scores.json', (_req, res) => res.sendFile(path.join(STATIC_DATA_DIR, 'test-scores.json')));
app.get('/data/subway-lines.geojson', (_req, res) => res.sendFile(path.join(STATIC_DATA_DIR, 'subway-lines.geojson')));
app.get('/data/subway-stations.geojson', (_req, res) => res.sendFile(path.join(STATIC_DATA_DIR, 'subway-stations.geojson')));

// API routes
app.use('/api/auth', authRouter);
app.use('/api/users/:username/favorites', favoritesRouter);
app.use('/api/isochrone', isochroneRouter);
app.use('/api/housing', housingRouter);

// Admin: list users, favorite counts, and login history
app.get('/api/admin/users', (_req, res) => {
  try {
    const favPath = path.join(DATA_DIR, 'favorites.json');
    const loginPath = path.join(DATA_DIR, 'logins.json');

    const favData: Record<string, any> = fs.existsSync(favPath)
      ? JSON.parse(fs.readFileSync(favPath, 'utf-8'))
      : {};
    const loginData: Record<string, string[]> = fs.existsSync(loginPath)
      ? JSON.parse(fs.readFileSync(loginPath, 'utf-8'))
      : {};

    // Merge all known usernames
    const allUsers = new Set([...Object.keys(favData), ...Object.keys(loginData)]);
    const users = [...allUsers].map((username) => ({
      username,
      favorites: favData[username] ? Object.keys(favData[username]).length : 0,
      logins: loginData[username] ? loginData[username].length : 0,
      last_login: loginData[username]?.slice(-1)[0] || null,
    }));

    users.sort((a, b) => (b.last_login || '').localeCompare(a.last_login || ''));
    res.json({ users, total: users.length });
  } catch (e) {
    res.status(500).json({ error: 'Failed to read users' });
  }
});

// SPA fallback
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  console.log(`NYC Schools Explorer running on port ${PORT}`);
  initHousingRefresh();
});
