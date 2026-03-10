import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';

const router = Router();
const IS_PROD = process.env.NODE_ENV === 'production';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../data');
const LOGIN_LOG_PATH = path.join(DATA_DIR, 'logins.json');

function normalizeUsername(u: string): string {
  return u.toLowerCase().trim().replace(/[^a-z0-9_-]/g, '');
}

function parseCookies(header: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  header.split(';').forEach((c) => {
    const [name, ...val] = c.trim().split('=');
    if (name) cookies[name] = decodeURIComponent(val.join('='));
  });
  return cookies;
}

// POST /api/auth/login — set username cookie
router.post('/login', (req: Request, res: Response) => {
  const { username } = req.body;

  if (!username || typeof username !== 'string') {
    res.status(400).json({ error: 'username required' });
    return;
  }

  const normalized = normalizeUsername(username);
  if (normalized.length < 1 || normalized.length > 50) {
    res.status(400).json({ error: 'username must be 1-50 alphanumeric characters' });
    return;
  }

  const expires = new Date();
  expires.setFullYear(expires.getFullYear() + 1);

  // Not HttpOnly — client JS needs to read it for API URL construction
  const securePart = IS_PROD ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `nyc_schools_user=${encodeURIComponent(normalized)}; Path=/; Expires=${expires.toUTCString()}; SameSite=Lax${securePart}`
  );

  // Log the login
  try {
    let logins: Record<string, string[]> = {};
    if (fs.existsSync(LOGIN_LOG_PATH)) {
      logins = JSON.parse(fs.readFileSync(LOGIN_LOG_PATH, 'utf-8'));
    }
    if (!logins[normalized]) logins[normalized] = [];
    logins[normalized].push(new Date().toISOString());
    fs.writeFileSync(LOGIN_LOG_PATH, JSON.stringify(logins, null, 2));
  } catch (e) {
    console.error('Failed to log login:', e);
  }

  res.json({ ok: true, username: normalized });
});

// POST /api/auth/logout — clear cookie
router.post('/logout', (_req: Request, res: Response) => {
  res.setHeader(
    'Set-Cookie',
    `nyc_schools_user=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax${IS_PROD ? '; Secure' : ''}`
  );
  res.json({ ok: true });
});

// GET /api/auth/whoami — return current username
router.get('/whoami', (req: Request, res: Response) => {
  const cookies = parseCookies(req.headers.cookie || '');
  const username = cookies['nyc_schools_user'];

  if (!username) {
    res.json({ username: null });
    return;
  }

  res.json({ username: normalizeUsername(username) });
});

export default router;
