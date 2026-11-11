import { apiUrl } from './api-base.js';
import { resolveHeart } from './heart.js?v=1';
// SPA orchestrator for Asistente Judicial.
//
// The landing page is STATIC HTML (#view-landing) — it renders even with
// JavaScript disabled. This script only adds behavior on top:
//   - login/register forms (wired to /auth/login, /auth/register)
//   - auth + dashboard views, cloned on demand from templates
//
// All module access uses dynamic import() inside try/catch so a failing
// module can never blank the page again.

const $id = (id) => document.getElementById(id);

let currentUser = null;
let authMod = null;
let avatarMod = null;
let chatMounted = false;
let chatWidget = null;

async function getAuth() {
  if (!authMod) {
    authMod = await import('./auth.js?v=2');
  }
  return authMod;
}

// Identity circles (photo/initials) load like every other module: dynamic
// import with a fallback, so a failing file can never blank the page.
async function getAvatar() {
  if (!avatarMod) {
    avatarMod = await import('./avatar.js');
  }
  return avatarMod;
}

// Notification/chat sounds follow the same load pattern as every module.
let soundsMod = null;

async function getSounds() {
  if (!soundsMod) {
    soundsMod = await import('./sounds.js?v=2');
  }
  return soundsMod;
}

// Collapsible cards remember their open state per data-open-key (same
// contract as the ley-datos panel's global embed box). The `toggle` event
// does NOT bubble, so persistence lives here on document in capture phase
// and covers every current or future card; mountView restores the state
// of cards cloned from templates.
document.addEventListener('toggle', (e) => {
  const card = e.target;
  if (!card || !card.matches || !card.matches('details[data-open-key]')) {
    return;
  }
  const chevron = card.querySelector('[data-chevron]');
  if (chevron) {
    chevron.style.transform = card.open ? 'rotate(180deg)' : '';
  }
  try {
    localStorage.setItem(card.getAttribute('data-open-key'), card.open ? '1' : '0');
  } catch (_) { /* storage blocked: not critical */ }
}, true);

// ----- Password reveal (eye icon) + advisory strength meter -----
// Each password field carries an inline eye icon button: aria-pressed
// mirrors the revealed state, type="button" so it can never submit,
// keyboard reachable natively. The strength meter is ADVISORY ONLY —
// real limits stay server-side (bcrypt) — and its copy is zero-blame:
// guide, never scold. Listeners are delegated on document (same pattern
// as the collapse cards above) so any present or future input works.
document.addEventListener('click', (event) => {
  const button = event.target && event.target.closest
    ? event.target.closest('button[data-password-eye]')
    : null;
  if (!button || !document.contains(button)) return;
  const input = button.parentElement.querySelector('input');
  if (!input) return;
  const willShow = input.type !== 'text';
  input.type = willShow ? 'text' : 'password';
  button.setAttribute('aria-pressed', willShow ? 'true' : 'false');
  button.setAttribute('aria-label', willShow ? 'Ocultar contraseña' : 'Mostrar contraseña');
  button.setAttribute('title', willShow ? 'Ocultar contraseña' : 'Mostrar contraseña');
  const iconEye = button.querySelector('[data-eye-icon]');
  const iconEyeOff = button.querySelector('[data-eye-off-icon]');
  if (iconEye) iconEye.classList.toggle('hidden', willShow);
  if (iconEyeOff) iconEyeOff.classList.toggle('hidden', !willShow);
});

// One local heuristic, three levels (mirrored in the ley-datos panel):
//   débil  = 8+ chars carrying a letter
//   media  = 10+ chars with upper + lower + digit
//   segura = 12+ chars also carrying a symbol
const PASSWORD_STRENGTH_FILL = { debil: 'bg-rose-400', media: 'bg-amber-400', segura: 'bg-emerald-500' };
const PASSWORD_STRENGTH_COPY = {
  corta: 'Fortaleza de la contraseña: por empezar. 8+ caracteres, mezcla mayúsculas, minúsculas y números: entre más larga, más segura.',
  debil: 'Fortaleza de la contraseña: débil. Puedes reforzarla agregando mayúsculas, números o algunos caracteres más.',
  media: 'Fortaleza de la contraseña: media. Con 12 o más caracteres y un símbolo queda aún más segura.',
  segura: 'Fortaleza de la contraseña: segura. Bien: entre más larga, más difícil de adivinar.'
};
const PASSWORD_STRENGTH_FILLED = { corta: 0, debil: 1, media: 2, segura: 3 };

function passwordStrength(value) {
  const hasLower = /[a-záéíóúüñ]/.test(value);
  const hasUpper = /[A-ZÁÉÍÓÚÜÑ]/.test(value);
  const hasDigit = /[0-9]/.test(value);
  const hasSymbol = /[^A-Za-z0-9áéíóúüñÁÉÍÓÚÜÑ]/.test(value);
  if (value.length >= 12 && hasUpper && hasLower && hasDigit && hasSymbol) return 'segura';
  if (value.length >= 10 && hasUpper && hasLower && hasDigit) return 'media';
  if (value.length >= 8 && (hasLower || hasUpper)) return 'debil';
  return 'corta';
}

function paintPasswordStrength(value, meter) {
  const level = passwordStrength(value);
  const filled = PASSWORD_STRENGTH_FILLED[level] || 0;
  meter.querySelectorAll('[data-strength-seg]').forEach((segment, index) => {
    const activeColor = index < filled ? PASSWORD_STRENGTH_FILL[level] : null;
    // Reset every level color so moving débil → media → segura never
    // leaves a stale fill behind, then paint the current one.
    Object.keys(PASSWORD_STRENGTH_FILL).forEach((levelName) => {
      segment.classList.toggle(PASSWORD_STRENGTH_FILL[levelName], activeColor === PASSWORD_STRENGTH_FILL[levelName]);
    });
    segment.classList.toggle('bg-slate-200', !activeColor);
  });
  const text = meter.querySelector('[data-strength-text]');
  if (text) text.textContent = PASSWORD_STRENGTH_COPY[level];
  meter.classList.toggle('hidden', value.length === 0);
}

document.addEventListener('input', (event) => {
  const target = event.target;
  if (!target || !target.matches || !target.matches('input[data-strength-for]')) return;
  const meter = document.getElementById(target.dataset.strengthFor || target.getAttribute('data-strength-for'));
  if (meter) paintPasswordStrength(target.value || '', meter);
});

// ----- View mounting -----

function mountView(tplId, viewId, parent) {
  let el = $id(viewId);
  if (el) {
    return el;
  }
  const tpl = $id(tplId);
  if (!tpl || !tpl.content) {
    return null;
  }
  const frag = tpl.content.cloneNode(true);
  const nodes = Array.from(frag.children);
  if (!nodes.length) {
    return null;
  }
  // Templates hold several top-level siblings (header + sections). Wrap them
  // so the view id addresses the whole view, not only its first element.
  const wrap = document.createElement('div');
  wrap.id = viewId;
  for (const node of nodes) {
    wrap.appendChild(node);
  }
  // Collapsible cards inside the template restore the remembered state
  // (setting .open fires `toggle`, which also fixes the chevron).
  wrap.querySelectorAll('details[data-open-key]').forEach((card) => {
    let open = false;
    try {
      open = localStorage.getItem(card.getAttribute('data-open-key')) === '1';
    } catch (_) { /* no history: start closed */ }
    card.open = open;
  });
  const host = parent || $id('contenido');
  if (!host) {
    return null;
  }
  host.appendChild(wrap);
  return wrap;
}

function showLanding() {
  const landing = $id('view-landing');
  if (landing) {
    landing.classList.remove('hidden');
  }
  const auth = $id('view-auth');
  if (auth) {
    auth.classList.add('hidden');
  }
  const dash = $id('view-dashboard');
  if (dash) {
    dash.classList.add('hidden');
  }
  // Session-aware landing: logged-in users get "Entrar al panel" instead
  // of the marketing login CTAs (desktop header and mobile drawer).
  refreshLandingAuthState();
  // The landing always lives at the site root: the panels are addressed by
  // HASH (the front is served as static files, with no server rewrite).
  if (window.history && window.history.replaceState) {
    const current = window.location.hash.replace(/^#/, '') || '/';
    if (current !== '/') {
      window.history.replaceState(null, '', '#/');
    }
  }
  window.scrollTo(0, 0);
}

/**
 * Applies the session state to the public landing (CTAs, login section).
 * Split from showLanding() so a registration that happens IN the landing
 * (the public checkout modal) can refresh the header without navigating.
 */
function refreshLandingAuthState() {
  const back = $id('back-to-panel');
  if (back) {
    back.hidden = !currentUser;
  }
  const mobileBack = $id('mobile-back-li');
  if (mobileBack) {
    mobileBack.hidden = !currentUser;
  }
  const mobileAuth = $id('mobile-auth-actions');
  if (mobileAuth) {
    mobileAuth.hidden = !!currentUser;
  }
  const loginCta = $id('landing-login-cta');
  const registerCta = $id('landing-register-cta');
  if (loginCta) {
    loginCta.hidden = !!currentUser;
  }
  if (registerCta) {
    registerCta.hidden = !!currentUser;
  }
  // The landing login/register form only makes sense signed out.
  const loginSection = $id('login-section');
  if (loginSection) {
    loginSection.hidden = !!currentUser;
  }
}

/**
 * Public payments front (/recargas): the packs are visible to anyone.
 * A visitor without a session lands on the landing with the checkout in
 * view; with a session, their own wallet takes over.
 */
function showPublicCheckout() {
  showLanding();

  if (window.history && window.history.replaceState) {
    window.history.replaceState(null, '', '#/recargas');
  }

  const section = $id('recargas');
  if (section && typeof section.scrollIntoView === 'function') {
    section.scrollIntoView({ behavior: 'auto', block: 'start' });
  }
}

function showAuth() {
  const landing = $id('view-landing');
  if (landing) {
    landing.classList.add('hidden');
  }
  const dash = $id('view-dashboard');
  if (dash) {
    dash.classList.add('hidden');
  }
  const auth = mountView('tpl-login', 'view-auth');
  if (auth) {
    auth.classList.remove('hidden');
    const back = $id('auth-back');
    if (back) {
      back.addEventListener('click', showLanding);
    }
  } else {
    showLanding();
  }
}

function showDashboard(session) {
  const landing = $id('view-landing');
  if (landing) {
    landing.classList.add('hidden');
  }
  const auth = $id('view-auth');
  if (auth) {
    auth.classList.add('hidden');
  }
  const dash = mountView('tpl-app', 'view-dashboard');
  if (!dash) {
    showLanding();
    return;
  }
  dash.classList.remove('hidden');
  populateUserUI(session);
  if (!dash.dataset.wired) {
    dash.dataset.wired = '1';
    wireDashboard();
    lazyInitModules();
  }
  // Bell badge: refresh once per session start (and after actions); the
  // notifications module itself owns the panel lifecycle.
  import('./notifications.js?v=7').then((m) => {
    if (m.refreshUnreadBadge) {
      m.refreshUnreadBadge();
    }
  }).catch(() => {});
  showPanel(session && session.user && session.user.role === 'admin' ? 'admin' : 'chat');
  window.scrollTo(0, 0);
}

// ----- Dashboard helpers -----

function setText(id, value) {
  const el = $id(id);
  if (el) {
    el.textContent = value;
  }
}

function updateBalanceDisplays(balance) {
  if (typeof balance !== 'number') {
    return;
  }
  setText('mobile-balance', balance + (balance === 1 ? ' crédito' : ' créditos'));
}

function populateSettings() {
  if (!currentUser) {
    return;
  }

  const nameInput = $id('profile-name');
  if (nameInput) {
    nameInput.value = currentUser.name || '';
  }

  const emailInput = $id('profile-email');
  if (emailInput) {
    emailInput.value = currentUser.email || '';
  }

  // Optional contact phone: NotWsp feeds from here (users.phone).
  const phoneInput = $id('profile-phone');
  if (phoneInput) {
    phoneInput.value = currentUser.phone || '';
  }

  setText('profile-role', currentUser.role === 'admin' ? 'Administrador' : 'Usuario');

  // Notification switches: current per-channel opt-out state.
  profileRequest('/profile/notifications')
    .then((data) => {
      const prefs = data && data.data && data.data.prefs ? data.data.prefs : {};
      const mailToggle = $id('notify-mail-toggle');
      const wspToggle = $id('notify-wsp-toggle');
      if (mailToggle) {
        mailToggle.checked = prefs.NotMail !== false;
      }
      if (wspToggle) {
        wspToggle.checked = prefs.NotWsp !== false;
      }
    })
    .catch(() => {});

  const avatarHost = $id('profile-avatar');
  if (avatarHost) {
    getAvatar()
      .then(({ avatarNode }) => avatarHost.replaceChildren(avatarNode(currentUser, 'lg')))
      .catch(() => {});
  }

  const removeBtn = $id('profile-avatar-remove');
  if (removeBtn) {
    removeBtn.classList.toggle('hidden', !currentUser.avatar);
  }

  // Sounds toggle: reflect the stored opt-in (default OFF when unset).
  const soundsToggle = $id('settings-sounds-toggle');
  if (soundsToggle) {
    getSounds()
      .then(({ soundsEnabled }) => {
        soundsToggle.checked = soundsEnabled();
      })
      .catch(() => {});
  }
}

// ----- Mi perfil: nombre + foto (panel settings) -----

async function profileRequest(path, options = {}) {
  const response = await fetch(apiUrl(path), { credentials: 'include', ...options });
  let data = null;

  try {
    data = await response.json();
  } catch {
    // Non-JSON answer (e.g. an HTML error page): fall through to the default.
  }

  if (!response.ok) {
    const message =
      data && data.error && data.error.message
        ? data.error.message
        : data && data.message
          ? data.message
          : '';
    throw new Error(message || 'No pudimos completar la acción. Inténtalo nuevamente en un momento, por favor.');
  }

  return data;
}

function profileNotice(kind, message) {
  const ok = $id('profile-ok');
  const error = $id('profile-error');

  if (!ok || !error) {
    return;
  }

  ok.classList.toggle('hidden', kind !== 'ok');
  error.classList.toggle('hidden', kind !== 'err');
  (kind === 'ok' ? ok : error).textContent = message;
}

function initProfilePanel() {
  if (initProfilePanel.wired) {
    return;
  }

  const form = $id('profile-form');
  const fileInput = $id('profile-avatar-input');

  if (!form || !fileInput) {
    return;
  }

  initProfilePanel.wired = true;

  $id('profile-avatar-pick')?.addEventListener('click', () => fileInput.click());

  // Notification switches (NotMail / NotWsp): persist on change with an
  // optimistic toggle; a failure rolls the switch back and says it kindly.
  const wireNotifyToggle = (toggleId, channel) => {
    const toggle = $id(toggleId);

    if (!toggle) {
      return;
    }

    toggle.addEventListener('change', async () => {
      const next = toggle.checked;
      toggle.disabled = true;

      // Activar WhatsApp exige un número REGISTRADO en WhatsApp (gateway
      // OpenWA, contacts/check): verificar ANTES de guardar la preferencia.
      // Apagar no requiere verificación (opt-out siempre disponible).
      if (channel === 'NotWsp' && next) {
        let check = null;
        try {
          const response = await profileRequest('/profile/verify-wsp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: (currentUser && currentUser.phone) || '' }),
          });
          check = response && response.data ? response.data : { valid: false, verified: 0 };
        } catch (error) {
          check = { valid: false, verified: 0 };
        }
        if (!check.valid) {
          toggle.checked = false;
          toggle.disabled = false;
          profileNotice('err', check.verified === 0
            ? 'No pudimos verificar tu teléfono con WhatsApp ahora (el servicio no respondió). Inténtalo en un momento, por favor.'
            : 'Tu teléfono no corresponde a una cuenta válida de WhatsApp. Revísalo en tu perfil (ej: +56 9 1234 5678).');
          return;
        }
      }

      try {
        await profileRequest('/profile/notifications', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [channel]: next }),
        });
        profileNotice('ok', 'Preferencia guardada.');
      } catch (error) {
        toggle.checked = !next;
        profileNotice('err', error.message || 'No pudimos guardar tu preferencia ahora. Inténtalo de nuevo en un momento.');
      } finally {
        toggle.disabled = false;
      }
    });
  };

  wireNotifyToggle('notify-mail-toggle', 'NotMail');
  wireNotifyToggle('notify-wsp-toggle', 'NotWsp');

  // Sounds toggle: persist immediately on change (no form save needed).
  $id('settings-sounds-toggle')?.addEventListener('change', (event) => {
    const enabled = Boolean(event.target.checked);
    getSounds()
      .then(({ setSoundsEnabled }) => setSoundsEnabled(enabled))
      .catch(() => {});
  });

  // Danger zone: permanent account deletion. The modal asks for the literal
  // word BORRAR (matching the backend contract) and hands the typed value to
  // POST /account/delete. On success the session itself is gone (server
  // already cleared the auth cookies), so we reuse the logout reset
  // (doLogout) to drop client state and land on the public home view; this
  // is a session reset after the account ceased to exist, not SPA navigation.
  $id('profile-delete-account')?.addEventListener('click', async () => {
    try {
      const modal = await import('./delete-account-modal.js?v=1');

      modal.showDeleteAccountModal({
        onConfirm: async (confirmValue, reason) => {
          try {
            await profileRequest('/account/delete', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                confirm: confirmValue,
                // Optional; empty/absent means "skipped" (backend stores NULL).
                ...(reason !== '' ? { reason } : {}),
              }),
            });
          } catch (error) {
            profileNotice('err', error.message);
            throw error;
          }

          await doLogout();
        },
      });
    } catch (error) {
      profileNotice('err', 'No pudimos abrir la ventana de confirmación. Inténtalo nuevamente, por favor.');
    }
  });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = ''; // allow choosing the same file again after a retry
    if (!file) return;

    if (file.size > 2 * 1024 * 1024) {
      profileNotice('err', 'La foto pesa más de 2 MB. Elige una más liviana: con una de hasta 2 MB queda nítida.');
      return;
    }

    profileNotice('ok', 'Subiendo tu foto…');

    const body = new FormData();
    body.append('avatar', file);

    try {
      const data = await profileRequest('/profile/avatar', { method: 'POST', body });
      currentUser = { ...currentUser, avatar: data && data.data ? data.data.avatar : null };
      populateSettings();
      profileNotice('ok', 'Foto actualizada. La verás en tus conversaciones.');
    } catch (error) {
      profileNotice('err', error.message);
    }
  });

  $id('profile-avatar-remove')?.addEventListener('click', async () => {
    try {
      await profileRequest('/profile/avatar', { method: 'DELETE' });
      currentUser = { ...currentUser, avatar: null };
      populateSettings();
      profileNotice('ok', 'Foto quitada. Ahora mostramos tus iniciales.');
    } catch (error) {
      profileNotice('err', error.message);
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const saveButton = $id('profile-save');
    const name = ($id('profile-name') ? $id('profile-name').value : '').trim();

    if (name.length < 2) {
      profileNotice('err', 'Tu nombre puede tener entre 2 y 100 caracteres: escribe el que quieras mostrar.');
      return;
    }

    saveButton.disabled = true;
    saveButton.textContent = 'Guardando…';

    try {
      const phoneInput = $id('profile-phone');
      const data = await profileRequest('/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        // Phone rides along whenever the field exists: the value (or the
        // empty string = explicit clear) is the user's current choice.
        body: JSON.stringify(phoneInput ? { name, phone: phoneInput.value.trim() } : { name }),
      });
      currentUser = {
        ...currentUser,
        name: data && data.data && data.data.user ? data.data.user.name : name,
        phone: data && data.data && data.data.user ? data.data.user.phone : (phoneInput ? phoneInput.value.trim() : currentUser.phone),
      };
      populateSettings();
      profileNotice('ok', 'Perfil guardado.');
    } catch (error) {
      profileNotice('err', error.message);
    } finally {
      saveButton.disabled = false;
      saveButton.textContent = 'Guardar cambios';
    }
  });
}

function populateUserUI(session) {
  const user = session && session.user ? session.user : null;
  currentUser = user;

  const isAdmin = !!user && user.role === 'admin';
  for (const id of ['nav-admin', 'nav-admin-mobile']) {
    const el = $id(id);
    if (el) {
      el.classList.toggle('hidden', !isAdmin);
    }
  }

  const balance = session && typeof session.balance === 'number' ? session.balance : null;
  if (balance !== null) {
    updateBalanceDisplays(balance);
  } else {
    setText('mobile-balance', '—');
  }

  populateSettings();
}

// Panels whose content lives in a separate <template> (wallet, admin) are
// mounted into #panels on first use; init()/refresh() must run AFTER this.
function ensurePanelMount(name) {
  if ($id('panel-' + name)) {
    return;
  }
  mountView('tpl-' + name, 'panel-' + name, $id('panels'));
  const el = $id('panel-' + name);
  if (el) {
    el.classList.add('hidden');
  }
}

// "Entrar al panel" lands each role on its own default panel.
function enterPanel(user) {
  showPanel(user && user.role === 'admin' ? 'admin' : 'chat');
}

function showPanel(name) {
  // "Inicio" (home) leaves the panel area and shows the public landing.
  if (name === 'home') {
    showLanding();
    return;
  }

  ensurePanelMount(name);

  for (const panel of ['documents', 'chat', 'conversations', 'wallet', 'settings', 'notifications', 'admin']) {
    const el = $id('panel-' + panel);
    if (el) {
      el.classList.toggle('hidden', panel !== name);
    }
  }

  document.querySelectorAll('.nav-item[data-panel]').forEach((button) => {
    const active = button.dataset.panel === name;
    button.classList.toggle('bg-brand-600', active);
    button.classList.toggle('text-white', active);
    button.classList.toggle('shadow-sm', active);
    button.classList.toggle('text-slate-600', !active);
    button.classList.toggle('hover:bg-brand-50', !active);
    button.classList.toggle('hover:text-brand-700', !active);
  });

  if (name === 'chat') {
    ensureChat();
  }
  if (name === 'documents') {
    import('./documents-library.js?v=3').then((m) => {
      if (m.initDocumentsLibrary) {
        m.initDocumentsLibrary();
      }
      if (m.refreshDocumentsLibrary) {
        m.refreshDocumentsLibrary();
      }
    }).catch((error) => {
      console.error('[App] Failed to load documents library:', error);
    });
  }
  if (name === 'conversations') {
    import('./conversations-library.js?v=1').then((m) => {
      if (m.initConversationsLibrary) {
        m.initConversationsLibrary();
      }
      if (m.refreshConversationsLibrary) {
        m.refreshConversationsLibrary();
      }
    }).catch((error) => {
      console.error('[App] Failed to load conversations library:', error);
    });
  }
  if (name === 'wallet') {
    import('./wallet.js?v=4').then((m) => {
      // init() wires the panel buttons; it only works once the template
      // is mounted, so it runs here (on first show), not at startup.
      if (m.initWallet) {
        m.initWallet();
      }
      if (m.refreshWallet) {
        m.refreshWallet();
      }
    }).catch(() => {});
  }
  if (name === 'notifications') {
    import('./notifications.js?v=7').then((m) => {
      if (m.initNotifications) {
        m.initNotifications();
      }
      if (m.refreshNotifications) {
        m.refreshNotifications();
      }
    }).catch(() => {});
  }
  if (name === 'admin') {
    import('./admin.js?v=7').then((m) => {
      if (m.initAdmin) {
        m.initAdmin();
      }
      if (m.refreshAdmin) {
        m.refreshAdmin();
      }
    }).catch(() => {});
  }
  if (name === 'settings') {
    populateSettings();
    initProfilePanel();
  }

  // Keep the URL in sync so the #/admin and #/wallet deep links stay
  // shareable. The panels are HASH routes: the front is served as static
  // files and a path-based route (/wallet) would 404 on a host without a
  // server rewrite — and the sibling stubs (wallet.html, chat.html, …)
  // already redirect to index.html#/wallet and friends.
  const pathFor = {
    documents: '#/documentos',
    chat: '#/chat',
    conversations: '#/conversaciones',
    wallet: '#/wallet',
    admin: '#/admin',
  };
  if (pathFor[name] && window.history && window.history.replaceState) {
    const current = window.location.hash.replace(/^#/, '') || '/';
    const target = pathFor[name].replace(/^#/, '');
    if (current !== target) {
      window.history.replaceState(null, '', pathFor[name]);
    }
  }

  closeMobileNav();
}

function ensureChat() {
  if (chatMounted) {
    return;
  }
  const container = $id('chat-consultas');
  if (!container) {
    return;
  }

  // Set the guard before the dynamic import resolves. mountChat() appends to
  // the host, so two overlapping calls could otherwise mount two widgets.
  chatMounted = true;

  // The API refuses to guess the heart: without it the chat is rejected with
  // HEART_REQUIRED. Resolve it here so the widget sends it on the question,
  // the quote/charge and its own attachment ingest.
  Promise.all([import('./chat-widget.js?v=9'), resolveHeart()])
    .then(([m, heart]) => {
      container.replaceChildren();
      chatWidget = m.mountChat(container, {
        title: 'Asistente legal',
        placeholder: 'Escribe tu pregunta aquí…',
        welcomeMessage:
          'Hola, soy tu asistente. Adjunta un documento con el clip o pregúntame lo que necesites sobre tus documentos, los créditos o la privacidad.',
        onBalanceChange: updateBalanceDisplays,
        // Identity circle for the visitor's own messages (photo or initials).
        getUser: () => currentUser,
        onAttach: () => {
          // Paperclip: same client-side extraction pipeline (OCR/PDF/DOCX).
          $id('file-input')?.click();
        },
        extraBody: { heart },
      });

      // Expose chatWidget globally for document integration
      window.chatWidget = chatWidget;

      // Drag & drop a file anywhere over the chat runs the same pipeline.
      ['dragenter', 'dragover'].forEach((eventName) => {
        container.addEventListener(eventName, (event) => {
          event.preventDefault();
          container.classList.add('ring-2', 'ring-blue-300');
        });
      });
      ['dragleave', 'drop'].forEach((eventName) => {
        container.addEventListener(eventName, (event) => {
          event.preventDefault();
          container.classList.remove('ring-2', 'ring-blue-300');
        });
      });
      container.addEventListener('drop', (event) => {
        const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
        const fileInput = $id('file-input');
        if (!file || !fileInput || typeof DataTransfer === 'undefined') {
          return;
        }
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        fileInput.files = dataTransfer.files;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      });

      lazyInitModules();
    })
    .catch((error) => {
      chatMounted = false;
      console.error('[App] Failed to mount chat widget:', error);
      const notice = document.createElement('p');
      notice.className = 'rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900';
      notice.textContent = 'No pudimos cargar el chat en este momento. Puedes volver a intentarlo al cambiar de sección.';
      container.replaceChildren(notice);
    });
}

async function lazyInitModules() {
  try {
    const docs = await import('./documents.js?v=6');
    if (docs.initDocuments) {
      docs.initDocuments();
    }
  } catch (e) {
    console.error('[App] Failed to init documents module:', e);
  }
  // Wallet and admin are initialized on FIRST SHOW (see showPanel): their
  // templates are not mounted at startup, so eager init() would cache a
  // null element map and never wire their controls.
}

// ----- Mobile navigation -----

/* The hamburger and the panel it controls are static markup in the landing
   header: #menu-toggle opens #mobile-menu (a dropdown under the bar, not a
   side drawer). The listeners are attached at boot() — wireDashboard() only
   runs once the user is logged in, so wiring them there left the menu dead
   on the public landing. */
function openMobileNav() {
  const nav = $id('mobile-menu');
  const toggle = $id('menu-toggle');
  if (nav) {
    nav.classList.remove('hidden');
  }
  if (toggle) {
    toggle.setAttribute('aria-expanded', 'true');
  }
  const openIcon = $id('icon-open');
  const closeIcon = $id('icon-close');
  if (openIcon) {
    openIcon.classList.add('hidden');
  }
  if (closeIcon) {
    closeIcon.classList.remove('hidden');
  }
}

function closeMobileNav() {
  const nav = $id('mobile-menu');
  const toggle = $id('menu-toggle');
  if (nav) {
    nav.classList.add('hidden');
  }
  if (toggle) {
    toggle.setAttribute('aria-expanded', 'false');
  }
  const openIcon = $id('icon-open');
  const closeIcon = $id('icon-close');
  if (openIcon) {
    openIcon.classList.remove('hidden');
  }
  if (closeIcon) {
    closeIcon.classList.add('hidden');
  }
}

function wireMobileNav() {
  const toggle = $id('menu-toggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      const nav = $id('mobile-menu');
      if (nav && nav.classList.contains('hidden')) {
        openMobileNav();
      } else {
        closeMobileNav();
      }
    });
  }
  // Following a link closes the panel; otherwise it stays open on screen.
  document.querySelectorAll('#mobile-menu a[href]').forEach((link) => {
    link.addEventListener('click', closeMobileNav);
  });
}

function wireDashboard() {
  document.querySelectorAll('.nav-item[data-panel]').forEach((button) => {
    button.addEventListener('click', () => showPanel(button.dataset.panel));
  });

  for (const id of ['logout-btn', 'logout-btn-mobile', 'logout-btn-settings']) {
    const el = $id(id);
    if (el) {
      el.addEventListener('click', doLogout);
    }
  }

  // The mobile menu belongs to the static header: it is wired once at boot()
  // (wireMobileNav), not here — wiring it twice would toggle it twice.

  // The legal pages are static files next to index.html, so they are
  // addressed relative to the SITE ROOT (the front may live on a sub-path).
  // This module lives in /js/, hence the '../' hop.
  const legalLinks = [
    ['#/terminos', new URL('../terminos.html', import.meta.url).href],
    ['#/privacidad', new URL('../privacidad.html', import.meta.url).href],
  ];
  for (const pair of legalLinks) {
    document.querySelectorAll('a[href="' + pair[0] + '"]').forEach((link) => {
      link.addEventListener('click', (event) => {
        event.preventDefault();
        window.location.assign(pair[1]);
      });
    });
  }
}

// ----- Logout -----

async function doLogout() {
  try {
    await fetch(apiUrl('/auth/logout'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'include',
      body: '{}',
    });
  } catch (e) { /* clear client state regardless */ }

  currentUser = null;
  chatMounted = false;
  if (chatWidget && typeof chatWidget.destroy === 'function') {
    chatWidget.destroy();
  }
  chatWidget = null;
  window.chatWidget = null;
  const container = $id('chat-consultas');
  if (container) {
    container.replaceChildren();
  }
  showLanding();
}

// ----- Login / Register forms (STATIC in #view-landing) -----

function showError(boxId, message) {
  const box = $id(boxId);
  if (box) {
    box.textContent = message;
    box.classList.remove('hidden');
  }
}

function hideError(boxId) {
  const box = $id(boxId);
  if (box) {
    box.classList.add('hidden');
  }
}

function setTabActive(activeTab, inactiveTab, activeForm, inactiveForm) {
  if (!activeTab || !inactiveTab || !activeForm || !inactiveForm) {
    return;
  }
  activeForm.classList.remove('hidden');
  inactiveForm.classList.add('hidden');
  activeTab.setAttribute('aria-selected', 'true');
  inactiveTab.setAttribute('aria-selected', 'false');
  activeTab.classList.add('bg-white', 'text-brand-700', 'shadow-sm');
  activeTab.classList.remove('text-slate-500');
  inactiveTab.classList.remove('bg-white', 'text-brand-700', 'shadow-sm');
  inactiveTab.classList.add('text-slate-500');
}

/**
 * Referral code from the signup link (?ref=CODE, reseller-system).
 * Uppercased before validating ^[A-Z2-9]{8}$ (a lowercase link still works);
 * anything else is ignored silently — signup never depends on the code.
 */
function referralCodeFromUrl() {
  try {
    const raw = (new URLSearchParams(window.location.search)).get('ref') || '';
    const ref = raw.trim().toUpperCase();
    return /^[A-Z2-9]{8}$/.test(ref) ? ref : '';
  } catch (_) {
    return '';
  }
}

/**
 * Heart id from the signup link (?heart=, heart-scoped signup). Lowercased
 * before validating ^[a-z0-9_]{0,64}$; anything else is ignored silently —
 * the signup never depends on the heart.
 */
function referralHeartFromUrl() {
  try {
    const raw = (new URLSearchParams(window.location.search)).get('heart') || '';
    const heart = raw.trim().toLowerCase();
    return /^[a-z0-9_]{0,64}$/.test(heart) && heart !== '' ? heart : '';
  } catch (_) {
    return '';
  }
}

/**
 * Persist the signup referral code so it survives navigation (the visitor
 * can look around the landing before registering without losing who
 * referred them). The invite's heart (?heart=) is remembered the same way
 * so the welcome bonus still lands in the invited heart. Storage failures
 * are non-fatal — signup never depends on either value.
 */
function rememberReferralCode() {
  const code = referralCodeFromUrl();
  if (code) {
    try { localStorage.setItem('ref_code', code); } catch (_) { /* almacenamiento bloqueado: no crítico */ }
  }
  const heart = referralHeartFromUrl();
  if (heart) {
    try { localStorage.setItem('ref_heart', heart); } catch (_) { /* almacenamiento bloqueado: no crítico */ }
  }
  return code;
}

/**
 * Code for the signup payload: the URL wins (fresh link), then the
 * remembered one from an earlier landing visit.
 */
function referralCode() {
  const fromUrl = referralCodeFromUrl();
  if (fromUrl) return fromUrl;
  try {
    const stored = (localStorage.getItem('ref_code') || '').trim().toUpperCase();
    return /^[A-Z2-9]{8}$/.test(stored) ? stored : '';
  } catch (_) {
    return '';
  }
}

/**
 * Heart for the signup payload: the URL wins (fresh link), then the
 * remembered one from an earlier landing visit. Empty string = none.
 */
function referralHeart() {
  const fromUrl = referralHeartFromUrl();
  if (fromUrl) return fromUrl;
  try {
    const stored = (localStorage.getItem('ref_heart') || '').trim().toLowerCase();
    return /^[a-z0-9_]{0,64}$/.test(stored) && stored !== '' ? stored : '';
  } catch (_) {
    return '';
  }
}

function wireLandingForms() {
  const tabLogin = $id('tab-login');
  const tabRegister = $id('tab-register');
  const loginForm = $id('login-form');
  const registerForm = $id('register-form');

  if (tabLogin && tabRegister) {
    tabLogin.addEventListener('click', () =>
      setTabActive(tabLogin, tabRegister, loginForm, registerForm));
    tabRegister.addEventListener('click', () =>
      setTabActive(tabRegister, tabLogin, registerForm, loginForm));
  }

  if (loginForm) {
    loginForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      hideError('login-error');
      const emailEl = $id('login-email');
      const passEl = $id('login-password');
      const email = emailEl && emailEl.value ? emailEl.value.trim() : '';
      const password = passEl && passEl.value ? passEl.value : '';
      try {
        const auth = await getAuth();
        const data = await auth.login({ email: email, password: password });
        showDashboard(data);
      } catch (err) {
        showError('login-error', err && err.message ? err.message : 'No pudimos iniciar sesión. Intenta de nuevo.');
      }
    });
  }

  if (registerForm) {
    registerForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      hideError('register-error');
      const nameEl = $id('reg-name');
      const emailEl = $id('reg-email');
      const passEl = $id('reg-password');
      const name = nameEl && nameEl.value ? nameEl.value.trim() : '';
      const email = emailEl && emailEl.value ? emailEl.value.trim() : '';
      const password = passEl && passEl.value ? passEl.value : '';
      // reseller-system: si llegó por el enlace de una persona vendedora,
      // el código viaja con el registro (validado de nuevo en el servidor).
      // URL primero; si navegó por la landing antes, usa el recordado.
      const ref = referralCode();
      // Heart-scoped signup: el corazón de la invitación (&heart= del
      // enlace) viaja igual — decide dónde cae el bono de bienvenida.
      const heart = referralHeart();
      const registerParams = { name, email, password };
      if (ref) registerParams.ref = ref;
      if (heart) registerParams.heart = heart;
      try {
        const auth = await getAuth();
        const data = await auth.register(registerParams);
        // El código y el corazón cumplieron su propósito: se limpian para
        // no pegarse a un registro futuro en el mismo navegador.
        try { localStorage.removeItem('ref_code'); } catch (_) { /* almacenamiento bloqueado: no crítico */ }
        try { localStorage.removeItem('ref_heart'); } catch (_) { /* almacenamiento bloqueado: no crítico */ }

        // Anuncia el registro para que otra superficie pueda tomarlo: el
        // checkout público de pagos (packs visibles sin cuenta) usa este
        // evento para desbloquear el botón de pago SIN sacar a la persona de
        // esta página. Si nadie lo consume, el flujo normal es abrir el
        // panel.
        const registered = new CustomEvent('aj:registered', { detail: data, cancelable: true });
        document.dispatchEvent(registered);

        if (registered.defaultPrevented) {
          // La superficie pública tomó el control: la sesión ya está abierta
          // (el servidor dejó las cookies) y los créditos de bienvenida ya
          // están acreditados. Solo refrescamos el estado visible.
          currentUser = data.user;
          populateUserUI(data);
          refreshLandingAuthState();
          return;
        }

        showDashboard(data);
      } catch (err) {
        showError('register-error', err && err.message ? err.message : 'No pudimos crear tu cuenta. Intenta de nuevo.');
      }
    });
  }
}

/**
 * Contact form of the landing: POST to the API and show the outcome inline.
 *
 * Without a handler the browser submitted the form natively, which reloaded
 * the page and lost the state of the send. The API is always reached by its
 * public domain (apiUrl -> window.__API_BASE__), never by an internal IP.
 *
 * Ported from the ley-datos landing, which speaks the same POST /contact
 * contract: honeypot "website" empty, plus name/email/message.
 */
function wireContactForm() {
  const form = $id('contact-form');
  if (!form) {
    return;
  }

  const statusEl = $id('contact-status');
  const submit = $id('contact-submit');
  const submitLabel = $id('contact-submit-label');
  const OK_CLASSES = ['border-emerald-200', 'bg-emerald-50/60', 'text-emerald-900'];
  const FAIL_CLASSES = ['border-rose-200', 'bg-rose-50', 'text-rose-800'];
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const GENERIC_ERROR = 'No pudimos enviarlo ahora; puedes reintentar en un momento.';

  function setFieldError(input, message) {
    const box = input ? $id(input.id + '-error') : null;
    if (!box) {
      return;
    }
    box.textContent = message;
    box.classList.remove('hidden');
  }

  function clearFieldErrors() {
    form.querySelectorAll('[id$="-error"]').forEach((box) => {
      box.textContent = '';
      box.classList.add('hidden');
    });
  }

  function showStatus(message, ok) {
    if (!statusEl) {
      return;
    }
    statusEl.classList.remove('hidden', ...OK_CLASSES, ...FAIL_CLASSES);
    statusEl.classList.add(...(ok ? OK_CLASSES : FAIL_CLASSES));
    statusEl.textContent = message;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFieldErrors();

    const nameInput = form.querySelector('[name="name"]');
    const emailInput = form.querySelector('[name="email"]');
    const messageInput = form.querySelector('[name="message"]');
    const honeypot = (form.querySelector('[name="website"]')?.value || '').trim();
    const name = (nameInput?.value || '').trim();
    const email = (emailInput?.value || '').trim();
    const message = (messageInput?.value || '').trim();

    if (name === '') {
      setFieldError(nameInput, 'Escribe tu nombre para saber cómo responderte.');
      nameInput?.focus();
      return;
    }

    if (!EMAIL_RE.test(email)) {
      setFieldError(emailInput, 'Escribe tu correo para que podamos responderte (ejemplo: nombre@correo.cl).');
      emailInput?.focus();
      return;
    }

    if (message === '') {
      setFieldError(messageInput, 'Cuéntanos brevemente en qué te podemos ayudar.');
      messageInput?.focus();
      return;
    }

    // Honeypot filled: a bot is in the field. Pretend success and keep the
    // request — and the table — clean, like the backend does.
    if (honeypot !== '') {
      form.reset();
      showStatus('Gracias. Recibimos tu mensaje; te escribiremos en breve.', true);
      return;
    }

    if (submit) {
      submit.disabled = true;
    }
    const originalText = submitLabel ? submitLabel.textContent : '';
    if (submitLabel) {
      submitLabel.textContent = 'Enviando…';
    }

    try {
      const response = await fetch(apiUrl('/contact'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, email: email, message: message, website: '' }),
      });
      const data = await response.json().catch(() => ({}));

      if (response.ok && data && data.success) {
        form.reset();
        showStatus('Gracias. Recibimos tu mensaje; te escribiremos a ' + email + ' en breve.', true);
      } else {
        showStatus(GENERIC_ERROR, false);
      }
    } catch (_) {
      showStatus(GENERIC_ERROR, false);
    } finally {
      if (submit) {
        submit.disabled = false;
      }
      if (submitLabel) {
        submitLabel.textContent = originalText;
      }
    }
  });
}

// ----- Boot -----

async function boot() {
  // Forms are static in the landing markup — wire them unconditionally.
  wireLandingForms();
  wireContactForm();
  wireMobileNav();

  // "Entrar al panel" on the session-aware landing (desktop + mobile).
  for (const id of ['back-to-panel', 'back-to-panel-m']) {
    const back = $id(id);
    if (back) {
      back.addEventListener('click', async () => {
        try {
          const auth = await getAuth();
          const session = await auth.fetchMe();
          showDashboard(session);
          enterPanel(session && session.user);
        } catch (e) {
          showAuth();
        }
      });
    }
  }

  // Marketing CTAs pointing at the login section route to the panel
  // instead of scrolling when a session already exists.
  document.addEventListener('click', (event) => {
    const anchor = event.target.closest('a[href="#login-section"]');
    if (anchor && currentUser) {
      event.preventDefault();
      enterPanel(currentUser);
    }
  });

  const magic = window.__MAGIC_LINK__;

  if (magic && magic.verified === false) {
    if (magic.message) {
      window.__LOGIN_ERROR__ = magic.message;
    }
    showAuth();
    return;
  }

  try {
    const auth = await getAuth();
    const session = await auth.fetchMe();
    // Capture the deep-link target BEFORE showDashboard(): showPanel()
    // rewrites the URL (replaceState) as it syncs the active panel.
    const path = window.location.hash.replace(/^#/, '') || '/';
    showDashboard(session);
    if (path === '/admin') {
      if (session && session.user && session.user.role === 'admin') {
        showPanel('admin');
      }
    } else if (path === '/chat') {
      showPanel('chat');
    } else if (path === '/documentos') {
      showPanel('documents');
    } else if (path === '/conversaciones') {
      showPanel('conversations');
    } else if (path === '/wallet') {
      showPanel('wallet');
    } else if (path === '/recargas') {
      // Con sesión, la recarga vive en su propia billetera (packs,
      // comprobante y movimientos).
      showPanel('wallet');
    }
  } catch (e) {
    // No active session: the landing page is already visible (static HTML).
    const path = window.location.hash.replace(/^#/, '') || '/';

    if (path === '/recargas') {
      // Front público de pagos: los packs se ven y se eligen sin cuenta;
      // el pago pide el registro en un modal.
      showPublicCheckout();
    } else {
      showLanding();
    }
    // reseller-system: quien abre un enlace de invitación (?ref=CODE) cae
    // directo en el formulario de registro, con el código recordado para que
    // sobreviva la navegación por la landing antes de registrarse.
    const ref = rememberReferralCode();
    if (ref) {
      setTabActive($id('tab-register'), $id('tab-login'), $id('register-form'), $id('login-form'));
      const section = $id('login-section');
      if (section && typeof section.scrollIntoView === 'function') {
        section.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
  }
}

document.addEventListener('show-auth', showLanding);

// Other modules (the conversations library) need to take the person to a
// panel without importing this file: the nav buttons call showPanel()
// directly and the app has no hashchange listener, so the request travels
// as a CustomEvent instead.
document.addEventListener('panel:navigate', (event) => {
  const target = event && event.detail ? String(event.detail.panel || '') : '';
  if (target) {
    showPanel(target);
  }
});

boot();
