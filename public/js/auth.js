/**
 * auth.js — Simple username-based auth via cookie.
 *
 * Exposes window.Auth with:
 *   getUser()          — read username from cookie (synchronous)
 *   login(username)    — POST to server, sets cookie
 *   logout()           — POST to server, clears cookie, reloads
 *   checkSession()     — GET /api/auth/whoami (async)
 */
window.Auth = (function () {
  'use strict';

  const COOKIE_NAME = 'nyc_schools_user';

  /** Read username from cookie (returns null if not set). */
  function getUser() {
    const match = document.cookie.match(
      new RegExp('(?:^|;\\s*)' + COOKIE_NAME + '=([^;]*)')
    );
    return match ? decodeURIComponent(match[1]) : null;
  }

  /** Hit the whoami endpoint to confirm server-side cookie. */
  async function checkSession() {
    try {
      const res = await fetch('/api/auth/whoami');
      if (!res.ok) return null;
      const { username } = await res.json();
      return username || null;
    } catch {
      return null;
    }
  }

  /** Log in: POST username, server sets cookie. */
  async function login(username) {
    let res;
    try {
      res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });
    } catch (err) {
      console.error('Login fetch error:', err);
      throw new Error('Could not reach server');
    }
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      console.error('Login: non-JSON response:', text);
      throw new Error('Unexpected server response');
    }
    if (!res.ok) {
      throw new Error(data.error || 'Login failed');
    }
    return data.username;
  }

  /** Log out: clear cookie, reload page. */
  async function logout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch (e) {
      console.warn('Logout request failed:', e);
    }
    location.reload();
  }

  return { getUser, checkSession, login, logout };
})();
