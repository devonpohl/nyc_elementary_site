import { Router, Request, Response } from 'express';
import { loadUserFavorites, saveUserFavorites } from '../db';

const router = Router({ mergeParams: true }); // access :username from parent

// GET /api/users/:username/favorites
router.get('/', (req: Request, res: Response) => {
  const username = req.params.username as string;
  const favorites = loadUserFavorites(username);
  res.json(favorites);
});

// PUT /api/users/:username/favorites/:systemCode
router.put('/:systemCode', (req: Request, res: Response) => {
  const username = req.params.username as string;
  const systemCode = req.params.systemCode as string;
  const { level, name } = req.body;

  if (!level || !name) {
    res.status(400).json({ error: 'level and name are required' });
    return;
  }

  const favorites = loadUserFavorites(username);
  favorites[systemCode] = { level, name };
  saveUserFavorites(username, favorites);

  res.json({ ok: true, systemCode, level, name });
});

// DELETE /api/users/:username/favorites/:systemCode
router.delete('/:systemCode', (req: Request, res: Response) => {
  const username = req.params.username as string;
  const systemCode = req.params.systemCode as string;
  const favorites = loadUserFavorites(username);

  if (!favorites[systemCode]) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  delete favorites[systemCode];
  saveUserFavorites(username, favorites);

  res.json({ ok: true, systemCode });
});

export default router;
