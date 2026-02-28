import fs from 'fs';
import path from 'path';

/**
 * JSON-file-backed persistence for per-user favorites.
 * File stored at DATA_DIR/favorites.json.
 *
 * Structure: { username: { systemCode: { level, name } } }
 *
 * On first load, auto-migrates old flat format (no username key)
 * into a "devon" namespace.
 */

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
const FAVORITES_PATH = path.join(DATA_DIR, 'favorites.json');

export interface Favorite {
  level: string;
  name: string;
}

export type FavoritesMap = Record<string, Favorite>; // system_code → { level, name }
type UsersData = Record<string, FavoritesMap>;       // username  → FavoritesMap

let migrated = false;

function loadAll(): UsersData {
  try {
    if (fs.existsSync(FAVORITES_PATH)) {
      const raw = fs.readFileSync(FAVORITES_PATH, 'utf-8');
      const data = JSON.parse(raw);

      // Detect old flat format: values have "level" key directly
      if (!migrated && Object.keys(data).length > 0) {
        const firstVal = data[Object.keys(data)[0]];
        if (firstVal && typeof firstVal.level === 'string') {
          // Old format — migrate under "devon"
          console.log('Migrating old flat favorites → per-user format under "devon"');
          const migrated_data: UsersData = { devon: data as FavoritesMap };
          saveAll(migrated_data);
          migrated = true;
          return migrated_data;
        }
      }
      migrated = true;
      return data as UsersData;
    }
  } catch (e) {
    console.error('Error loading favorites:', e);
  }
  return {};
}

function saveAll(data: UsersData): void {
  try {
    fs.mkdirSync(path.dirname(FAVORITES_PATH), { recursive: true });
    fs.writeFileSync(FAVORITES_PATH, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Error saving favorites:', e);
    throw e;
  }
}

export function loadUserFavorites(username: string): FavoritesMap {
  const all = loadAll();
  return all[username] || {};
}

export function saveUserFavorites(username: string, favorites: FavoritesMap): void {
  const all = loadAll();
  all[username] = favorites;
  saveAll(all);
}

// Keep backward-compat exports for any other code that might use them
export function loadFavorites(): FavoritesMap {
  return loadUserFavorites('devon');
}

export function saveFavorites(favorites: FavoritesMap): void {
  saveUserFavorites('devon', favorites);
}
