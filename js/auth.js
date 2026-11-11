import { apiUrl } from './api-base.js';
// Auth client helpers.
//
// Tokens live exclusively in httpOnly cookies set by the server; nothing
// sensitive is stored in localStorage. This module only talks to the API.
//
// The login form wiring lives in initAuth() so the SPA can bind events
// once at startup. All views are always in the DOM.

/**
 * Asks the server for a magic link. The server always answers with the same
 * neutral message, so we show a kind confirmation either way.
 *
 * @param {{ email: string, name?: string }} params
 * @returns {Promise<{ message: string }>} The server's neutral confirmation.
 */
export async function requestMagicLink({ email, name }) {
  let response;

  try {
    response = await fetch(apiUrl('/auth/magic-link'), {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ email, name }),
    });
  } catch (networkError) {
    throw new Error('No pudimos conectar con el servidor. Revisa tu conexión e inténtalo nuevamente.');
  }

  let payload;

  try {
    payload = await response.json();
  } catch (parseError) {
    throw new Error('No pudimos interpretar la respuesta del servidor. Inténtalo nuevamente.');
  }

  if (!payload || payload.success !== true) {
    const message = payload && payload.error && payload.error.message
      ? payload.error.message
      : 'No pudimos enviar el enlace en este momento. Inténtalo nuevamente.';

    const error = new Error(message);
    error.code = payload && payload.error ? payload.error.code : undefined;
    throw error;
  }

  return payload.data;
}

/**
 * Loads the current session (user + balance) from the httpOnly cookies.
 *
 * @returns {Promise<{ user: object, balance: number }>}
 */
export async function fetchMe() {
  const response = await fetch(apiUrl('/auth/me'), {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });

  const payload = await response.json();

  if (!payload || payload.success !== true) {
    const error = new Error(
      payload && payload.error && payload.error.message
        ? payload.error.message
        : 'No pudimos cargar tu sesión. Inicia sesión nuevamente.'
    );
    error.status = response.status;
    throw error;
  }

  return payload.data;
}

/**
 * Handles the magic-link verification response from /auth/verify.
 * Sets cookies (already done server-side) and returns the raw payload.
 *
 * @param {Response} response
 * @returns {Promise<object>}
 */
export async function verifyMagicLink(response) {
  const payload = await response.json();

  if (!payload || payload.success !== true) {
    const message = payload && payload.error && payload.error.message
      ? payload.error.message
      : 'No pudimos verificar el enlace. Inténtalo nuevamente.';

    const error = new Error(message);
    error.code = payload && payload.error ? payload.error.code : undefined;
    throw error;
  }

  return payload;
}

/**
 * Register a new account with email and password.
 *
 * @param {{ name: string, email: string, password: string, ref?: string, heart?: string }} params
 * @returns {Promise<{ user: object, balance: number }>}
 */
export async function register({ name, email, password, ref, heart }) {
  let response;

  const body = { name, email, password, terms_accepted: true };
  // reseller-system: only a well-formed code travels; anything else is
  // dropped here and the server re-validates anyway.
  if (typeof ref === 'string' && /^[A-Z2-9]{8}$/.test(ref)) {
    body.ref = ref;
  }
  // Heart-scoped signup: only a well-formed heart id travels; the server
  // re-validates and falls back to the default heart silently.
  if (typeof heart === 'string' && /^[a-z0-9_]{0,64}$/.test(heart) && heart !== '') {
    body.heart = heart;
  }

  try {
    response = await fetch(apiUrl('/auth/register'), {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (networkError) {
    throw new Error('No pudimos conectar con el servidor. Revisa tu conexión e inténtalo nuevamente.');
  }

  let payload;

  try {
    payload = await response.json();
  } catch (parseError) {
    throw new Error('No pudimos interpretar la respuesta del servidor. Inténtalo nuevamente.');
  }

  if (!payload || payload.success !== true) {
    const message = payload && payload.error && payload.error.message
      ? payload.error.message
      : 'No pudimos crear tu cuenta en este momento. Inténtalo nuevamente.';
    const error = new Error(message);
    error.code = payload && payload.error ? payload.error.code : undefined;
    throw error;
  }

  return payload.data;
}

/**
 * Login with email and password.
 *
 * @param {{ email: string, password: string }} params
 * @returns {Promise<{ user: object, balance: number }>}
 */
export async function login({ email, password }) {
  let response;

  try {
    response = await fetch(apiUrl('/auth/login'), {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ email, password }),
    });
  } catch (networkError) {
    throw new Error('No pudimos conectar con el servidor. Revisa tu conexión e inténtalo nuevamente.');
  }

  let payload;

  try {
    payload = await response.json();
  } catch (parseError) {
    throw new Error('No pudimos interpretar la respuesta del servidor. Inténtalo nuevamente.');
  }

  if (!payload || payload.success !== true) {
    const message = payload && payload.error && payload.error.message
      ? payload.error.message
      : 'No pudimos iniciar sesión en este momento. Inténtalo nuevamente.';
    const error = new Error(message);
    error.code = payload && payload.error ? payload.error.code : undefined;
    throw error;
  }

  return payload.data;
}

/**
 * Wires the auth form. Called once at app startup.
 *
 * @param {{ onLoginSuccess?: (data: { user: object, balance: number }) => void }} options
 */
export function initAuth(options = {}) {
  const form = document.getElementById('request-section');
  const notice = document.getElementById('notice');
  const errorBox = document.getElementById('auth-error');

  if (!form || !notice || !errorBox) {
    return;
  }

  const sendButton = document.getElementById('send-link');

  const showNotice = (message) => {
    notice.textContent = message;
    notice.classList.remove('hidden');
    errorBox.classList.add('hidden');
  };

  const showError = (message) => {
    errorBox.textContent = message;
    errorBox.classList.remove('hidden');
    notice.classList.add('hidden');
  };

  // A magic-link verify that failed lands here with a kind message.
  if (window.__LOGIN_ERROR__) {
    showError(window.__LOGIN_ERROR__);
    delete window.__LOGIN_ERROR__;
  }

  sendButton.addEventListener('click', async () => {
    const email = document.getElementById('email').value.trim();
    const name = document.getElementById('name').value.trim();

    sendButton.disabled = true;
    sendButton.textContent = 'Enviando…';

    try {
      const data = await requestMagicLink({ email, name });
      showNotice(data.message || 'Si el correo es válido, te enviamos un enlace.');
      form.classList.add('hidden');
    } catch (err) {
      showError(err.message);
    } finally {
      sendButton.disabled = false;
      sendButton.textContent = 'Enviarme el enlace';
    }
  });

  // Back button
  const backBtn = document.getElementById('auth-back');
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      // Go back to landing or show a welcome message
      showNotice('');
      form.classList.remove('hidden');
    });
  }
}

export function destroyAuth() {
  // All listeners are bound to the DOM which persists.
}
