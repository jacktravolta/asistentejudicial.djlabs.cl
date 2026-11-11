// Resolves which heart (application installation) this front talks to.
//
// The API serves several hearts and refuses to guess on purpose: an
// authenticated chat request without a heart is rejected with
// HEART_REQUIRED (HTTP 400), because guessing would charge another heart's
// wallet. The front must therefore NAME the heart on every request that
// touches a wallet, a RAG store or the brain.
//
// Resolution order:
//   1. localStorage 'heart_id' (an explicit override always wins)
//   2. GET /ui/theme, the public endpoint that reports this install's heart
//   3. the literal 'default'
//
// It never throws: a failed lookup falls back to 'default' and the app keeps
// working.

import { apiGet } from './http.js?v=1';

const DEFAULT_HEART = 'default';
const STORAGE_KEY = 'heart_id';

// Module-scoped cache: the theme lookup happens at most once per page load.
let heartPromise = null;

/**
 * Returns the heart stored in localStorage, or '' when there is none.
 * Storage failures (private mode, disabled cookies) are not fatal.
 *
 * @returns {string}
 */
export function storedHeart() {
  try {
    return (window.localStorage.getItem(STORAGE_KEY) || '').trim();
  } catch (_) {
    return '';
  }
}

/**
 * Asks the API which heart this installation serves.
 *
 * @returns {Promise<string>}
 */
async function fetchHeart() {
  try {
    const data = await apiGet('/ui/theme', {
      fallbackMessage: 'No pudimos identificar la aplicación de esta solicitud.',
    });
    const heart = data && typeof data.heart === 'string' ? data.heart.trim() : '';
    return heart || DEFAULT_HEART;
  } catch (_) {
    return DEFAULT_HEART;
  }
}

/**
 * Resolves the heart for this installation. Never throws.
 *
 * @returns {Promise<string>}
 */
export async function resolveHeart() {
  const stored = storedHeart();
  if (stored) {
    return stored;
  }

  if (!heartPromise) {
    heartPromise = fetchHeart();
  }

  const heart = await heartPromise;
  return heart || DEFAULT_HEART;
}
