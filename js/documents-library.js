import { apiGet } from './http.js?v=1';
import { apiUrl } from './api-base.js';

// Documents library for the sources already stored in the user's account.
// Server-provided titles and text are rendered with DOM APIs only, so they
// can never be interpreted as markup.

const KIND_LABELS = Object.freeze({
  document: 'documento',
  site: 'sitio',
  informe: 'informe',
  quotation: 'cotización',
  atscv: 'ATSCV',
});

const $id = (id) => document.getElementById(id);
let initialized = false;
let refreshVersion = 0;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined && text !== null) {
    node.textContent = String(text);
  }
  return node;
}

function friendlyError(error, fallback) {
  if (error && error.status === 401) {
    return 'Tu sesión no está disponible. Inicia sesión nuevamente para continuar.';
  }
  if (error && typeof error.message === 'string' && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

function formatDate(value) {
  if (!value) {
    return 'Fecha no disponible';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'Fecha no disponible';
  }
  return new Intl.DateTimeFormat('es-CL', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

function formatCharacters(value) {
  const count = Number(value);
  const safeCount = Number.isFinite(count) && count >= 0 ? count : 0;
  return `${new Intl.NumberFormat('es-CL').format(safeCount)} caracteres`;
}

function kindLabel(kind) {
  const key = String(kind || '').toLowerCase();
  return KIND_LABELS[key] || 'Otro tipo';
}

async function apiJson(url, method, body) {
  let response;

  try {
    response = await fetch(apiUrl(url), {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify(body),
    });
  } catch (_) {
    throw new Error('No pudimos conectar con el servidor. Revisa tu conexión e inténtalo nuevamente.');
  }

  if (response.status === 204) {
    return {};
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch (_) {
    throw new Error('No pudimos interpretar la respuesta del servidor. Inténtalo nuevamente.');
  }

  if (response.status === 401) {
    const error = new Error('Tu sesión no está disponible. Inicia sesión nuevamente para continuar.');
    error.status = 401;
    throw error;
  }

  if (!response.ok || !payload || payload.success !== true) {
    const message = payload && payload.error && payload.error.message
      ? payload.error.message
      : 'No pudimos completar la acción en este momento. Inténtalo nuevamente.';
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  return payload.data || {};
}

function showRowError(errorNode, error) {
  errorNode.textContent = friendlyError(
    error,
    'No pudimos completar esta acción. Inténtalo nuevamente en un momento.',
  );
  errorNode.classList.remove('hidden');
}

function renderLoading(container) {
  container.replaceChildren(
    element('p', 'rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500', 'Cargando tus documentos...'),
  );
}

function renderEmpty(container) {
  const box = element('div', 'rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center');
  box.append(
    element('p', 'text-sm font-medium text-slate-700', 'Todavía no tienes documentos guardados.'),
    element('p', 'mt-1 text-sm text-slate-500', 'Cuando subas un archivo, aparecerá aquí para que puedas revisarlo y decidir cómo usarlo.'),
  );
  container.replaceChildren(box);
}

function renderError(container, error) {
  const box = element('div', 'rounded-xl border border-amber-200 bg-amber-50 p-4');
  box.append(
    element(
      'p',
      'text-sm text-amber-900',
      friendlyError(error, 'No pudimos cargar tus documentos en este momento. Inténtalo nuevamente.'),
    ),
  );

  const retry = element(
    'button',
    'mt-3 rounded-lg border border-amber-300 bg-white px-4 py-2 text-sm font-medium text-amber-800 transition hover:bg-amber-50',
    'Reintentar',
  );
  retry.type = 'button';
  retry.addEventListener('click', () => {
    void refreshDocumentsLibrary();
  });
  box.append(retry);
  container.replaceChildren(box);
}

function createTextPanel() {
  const panel = element('div', 'hidden rounded-xl border border-slate-200 bg-slate-50 p-4');
  const content = element(
    'pre',
    'mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-700',
    '',
  );
  panel.append(content);
  return { panel, content };
}

function createSourceRow(source) {
  const sourceId = String(source.source_id || '');
  const title = String(source.title || 'Documento sin título');
  const row = element('article', 'rounded-2xl border border-slate-200 bg-white p-4 shadow-sm');

  const header = element('div', 'flex flex-wrap items-start justify-between gap-3');
  const info = element('div', 'min-w-0 flex-1');
  info.append(
    element('h2', 'truncate text-sm font-semibold text-slate-900', title),
    element(
      'p',
      'mt-1 text-xs text-slate-500',
      `${kindLabel(source.kind)} · ${formatDate(source.created_at)} · ${formatCharacters(source.text_len)}`,
    ),
  );

  const chatState = element(
    'span',
    source.chat_enabled
      ? 'rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700'
      : 'rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600',
    source.chat_enabled ? 'Disponible para el chat' : 'No se usa en el chat',
  );
  header.append(info, chatState);
  row.append(header);

  const actions = element('nav', 'mt-4 flex flex-wrap items-center gap-2');
  const viewButton = element(
    'button',
    'rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-400 hover:bg-slate-50',
    'Ver texto',
  );
  viewButton.type = 'button';
  viewButton.setAttribute('aria-expanded', 'false');

  const toggleButton = element(
    'button',
    'rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-sm font-medium text-brand-700 transition hover:bg-brand-50',
    source.chat_enabled ? 'No usar en el chat' : 'Usar en el chat',
  );
  toggleButton.type = 'button';
  toggleButton.setAttribute('aria-pressed', String(!!source.chat_enabled));

  const deleteButton = element(
    'button',
    'rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700 transition hover:bg-red-50',
    'Eliminar',
  );
  deleteButton.type = 'button';
  actions.append(viewButton, toggleButton, deleteButton);
  row.append(actions);

  const rowError = element(
    'p',
    'mt-3 hidden rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900',
    '',
  );
  rowError.setAttribute('role', 'alert');
  row.append(rowError);

  const text = createTextPanel();
  row.append(text.panel);

  viewButton.addEventListener('click', async () => {
    const isOpen = !text.panel.classList.contains('hidden');
    if (isOpen) {
      text.panel.classList.add('hidden');
      viewButton.setAttribute('aria-expanded', 'false');
      return;
    }

    text.panel.classList.remove('hidden');
    viewButton.setAttribute('aria-expanded', 'true');
    viewButton.disabled = true;
    text.content.textContent = 'Cargando el texto...';

    try {
      const data = await apiGet(
        `/rag/sources/text?id=${encodeURIComponent(sourceId)}`,
        { fallbackMessage: 'No pudimos cargar el texto de este documento. Inténtalo nuevamente.' },
      );
      text.content.textContent = data && typeof data.text === 'string' && data.text.trim()
        ? data.text
        : 'Este documento no tiene texto guardado.';
    } catch (error) {
      text.content.textContent = friendlyError(
        error,
        'No pudimos cargar el texto de este documento. Inténtalo nuevamente.',
      );
    } finally {
      viewButton.disabled = false;
    }
  });

  toggleButton.addEventListener('click', async () => {
    const enabled = !source.chat_enabled;
    toggleButton.disabled = true;
    rowError.classList.add('hidden');

    try {
      const data = await apiJson('/rag/sources/chat-enabled', 'POST', {
        source_id: source.source_id,
        enabled,
      });
      const nextEnabled = data && typeof data.chat_enabled === 'boolean'
        ? data.chat_enabled
        : enabled;
      source.chat_enabled = nextEnabled;
      toggleButton.textContent = nextEnabled ? 'No usar en el chat' : 'Usar en el chat';
      toggleButton.setAttribute('aria-pressed', String(nextEnabled));
      chatState.textContent = nextEnabled ? 'Disponible para el chat' : 'No se usa en el chat';
      chatState.className = nextEnabled
        ? 'rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700'
        : 'rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600';
    } catch (error) {
      showRowError(rowError, error);
    } finally {
      toggleButton.disabled = false;
    }
  });

  deleteButton.addEventListener('click', async () => {
    const confirmed = window.confirm(
      `¿Quieres eliminar "${title}" de tu biblioteca? Esta acción no se puede deshacer.`,
    );
    if (!confirmed) {
      return;
    }

    deleteButton.disabled = true;
    rowError.classList.add('hidden');

    try {
      await apiJson('/rag/sources', 'DELETE', { sourceId: source.source_id });
      await refreshDocumentsLibrary();
    } catch (error) {
      showRowError(rowError, error);
      deleteButton.disabled = false;
    }
  });

  return row;
}

function renderSources(container, sources) {
  if (!sources.length) {
    renderEmpty(container);
    return;
  }

  const list = element('ul', 'space-y-3');
  for (const source of sources) {
    const item = element('li');
    item.append(createSourceRow(source));
    list.append(item);
  }
  container.replaceChildren(list);
}

export function initDocumentsLibrary() {
  if (initialized) {
    return;
  }
  initialized = true;

  const uploadButton = $id('documents-upload-button');
  if (uploadButton) {
    uploadButton.addEventListener('click', () => {
      $id('file-input')?.click();
    });
  }

  const discardButton = $id('discard-btn');
  if (discardButton) {
    discardButton.addEventListener('click', () => {
      $id('result')?.classList.add('hidden');
      const fileInput = $id('file-input');
      if (fileInput) {
        fileInput.value = '';
      }
    });
  }

  document.addEventListener('documents:ingested', () => {
    void refreshDocumentsLibrary();
  });
  document.addEventListener('chat:documents-ingested', () => {
    void refreshDocumentsLibrary();
  });
}

export async function refreshDocumentsLibrary() {
  const container = $id('documents-list');
  if (!container) {
    return;
  }

  const version = ++refreshVersion;
  renderLoading(container);

  try {
    const data = await apiGet('/rag/sources', {
      fallbackMessage: 'No pudimos cargar tus documentos en este momento. Inténtalo nuevamente.',
    });
    if (version !== refreshVersion) {
      return;
    }
    const sources = data && Array.isArray(data.sources) ? data.sources : [];
    renderSources(container, sources);
  } catch (error) {
    if (version !== refreshVersion) {
      return;
    }
    renderError(container, error);
  }
}
