import { apiUrl } from './api-base.js';
// Password recovery wiring for the landing login form.
//
// "Olvidé mi contraseña": the account may be magic-link only, so the recovery
// path is the SAME magic link the server already knows how to send. We ask for
// it with the typed email and explain, kindly, that the link logs them in and
// Perfil lets them set a new password.
//
// This lives in its own module instead of an inline <script> because the
// landing CSP is script-src 'self' (no 'unsafe-inline'): an inline handler
// would be blocked and the link would silently do nothing.

function showError(box, message) {
  if (!box) return;
  box.textContent = message;
  box.classList.remove('hidden');
}

function clearError(box) {
  if (!box) return;
  box.textContent = '';
  box.classList.add('hidden');
}

export function initLoginRecovery() {
  const recoverLink = document.getElementById('login-recover');
  const loginForm = document.getElementById('login-form');
  const recoveryForm = document.getElementById('recovery-form');
  const recoveryPanel = document.getElementById('recovery-panel');
  const linkPanel = document.getElementById('login-recovery');
  const errorBox = document.getElementById('login-error');

  if (!recoverLink || !loginForm || !recoveryForm || !recoveryPanel || !linkPanel) return;

  const emailInput = recoveryForm.querySelector('#recovery-email, input[name="email"], input[type="email"]');

  // Open the recovery form and set the login form aside.
  //
  // Visibility is toggled with Tailwind's `hidden` CLASS, never with the
  // `hidden` IDL property: the property maps to the UA stylesheet
  // ([hidden] { display: none }), which loses to Tailwind's author rules
  // (.flex { display: flex }). Using the property left the login form
  // visible and the recovery panel stuck behind its own `hidden` class.
  recoverLink.addEventListener('click', (event) => {
    event.preventDefault();
    clearError(errorBox);
    loginForm.classList.add('hidden');
    recoveryPanel.classList.remove('hidden');
    linkPanel.classList.add('hidden');
    if (emailInput) emailInput.focus();
  });

  recoveryForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearError(errorBox);

    if (!emailInput) return;
    const email = (emailInput.value || '').trim();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showError(errorBox, 'Escribe tu correo para enviarte el enlace de acceso (ejemplo: nombre@correo.cl).');
      emailInput.focus();
      return;
    }

    const button = recoveryForm.querySelector('button');
    const originalText = button ? button.textContent : '';
    if (button) {
      button.disabled = true;
      button.textContent = 'Enviando enlace…';
    }

    try {
      const response = await fetch(apiUrl('/auth/magic-link'), {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ email }),
      });

      let payload = null;
      try {
        payload = await response.json();
      } catch (parseError) {
        payload = null;
      }

      if (!response.ok || !payload || payload.success !== true) {
        const message = payload && payload.error && payload.error.message
          ? payload.error.message
          : 'No pudimos enviar el enlace en este momento. Inténtalo nuevamente.';
        showError(errorBox, message);
        if (button) {
          button.disabled = false;
          button.textContent = originalText;
        }
        return;
      }

      // Neutral confirmation: the server answers the same way for known and
      // unknown emails, so we never leak whether an account exists.
      loginForm.classList.add('hidden');
      recoveryPanel.classList.add('hidden');
      linkPanel.classList.add('hidden');
      const note = document.querySelector('[data-recovery-note]');
      if (note) note.classList.remove('hidden');
    } catch (networkError) {
      showError(errorBox, 'No pudimos conectar con el servidor. Revisa tu conexión e inténtalo nuevamente.');
      if (button) {
        button.disabled = false;
        button.textContent = originalText;
      }
    }
  });
}

initLoginRecovery();
