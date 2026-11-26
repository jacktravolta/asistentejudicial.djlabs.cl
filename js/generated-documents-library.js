// Generated documents library: the documents the user has generated with the
// assistant (kind='generated'). Listing and downloading them is FREE.
//
// The API owns these documents: it returns only the rows that belong to the
// authenticated user and heart. Listing is a JSON GET. Downloading streams the
// file itself (no JSON), so the download uses plain `fetch` with credentials.
//
// Server-provided filenames are rendered with DOM APIs only (textContent),
// so they can never be interpreted as markup.

import { apiGet } from './http.js?v=1';
import { apiUrl } from './api-base.js';
import { resolveHeart } from './heart.js?v=1';
import {
  actionButton,
  el,
  formatDate,
  friendlyError,
  renderError,
  renderList,
  renderLoading,
} from './panel-section.js?v=1';

const LOADING_MESSAGE = 'Cargando tus documentos generados...';
const LOAD_ERROR_MESSAGE = 'No pudimos cargar tus documentos generados en este momento. Inténtalo nuevamente.';
const DOWNLOAD_ERROR_MESSAGE = 'No pudimos descargar el archivo en este momento. Inténtalo nuevamente.';
const DOWNLOAD_SUCCESS_MESSAGE = 'Descarga iniciada. El archivo se guardó en tu carpeta de descargas.';
const EMPTY_TITLE = 'Todavía no tienes documentos generados.';
const EMPTY_HINT = 'Los documentos que generes con el asistente aparecerán aquí, listos para descargar cuando quieras.';

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB'];

const $id = (id) => document.getElementById(id);

let initialized = false;
let refreshVersion = 0;

/**
 * Formats a byte size for the panel, in Spanish (Chile).
 *
 * @param {unknown} value
 * @returns {string}
 */
function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '0 B';
  }
  if (bytes === 0) {
    return '0 B';
  }
  const index = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = (bytes / Math.pow(1024, index)).toFixed(1);
  return `${size} ${SIZE_UNITS[index]}`;
}

/**
 * Shows a short confirmation next to the list so the person knows the
 * download started.
 *
 * @param {string} message
 */
function showStatus(message) {
  const node = $id('generated-documents-status');
  if (!node) {
    return;
  }
  node.textContent = message;
  node.classList.remove('hidden');
  setTimeout(() => {
    node.classList.add('hidden');
  }, 3000);
}

/**
 * Downloads one generated document as a binary file.
 *
 * The download route returns the file itself (not JSON), so we fetch the
 * blob, build an object URL, click a hidden <a download> anchor and revoke
 * the URL once the browser has started the download.
 *
 * @param {string} id
 * @param {string} filename
 * @param {string} heart
 * @returns {Promise<void>}
 */
async function downloadDocument(id, filename, heart) {
  const url = apiUrl(`/documents/${encodeURIComponent(String(id))}/download?heart=${encodeURIComponent(heart)}`);

  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/octet-stream, */*',
      },
      credentials: 'include',
    });
  } catch (_) {
    throw new Error('No pudimos conectar con el servidor. Revisa tu conexión e inténtalo nuevamente.');
  }

  if (!response.ok) {
    let message = DOWNLOAD_ERROR_MESSAGE;
    try {
      const payload = await response.json();
      const apiError = payload && payload.error;
      const apiMessage =
        typeof apiError === 'string'
          ? apiError
          : apiError && typeof apiError.message === 'string'
            ? apiError.message
            : null;
      if (apiMessage && apiMessage.trim()) {
        message = apiMessage;
      }
    } catch (_) {
      // Non-JSON error body: keep the fallback.
    }
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = String(filename || 'documento');
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);

  // Revoke once the browser has started the download. The click() above
  // triggers the download synchronously; a tiny delay keeps the blob alive
  // long enough for the browser to read it.
  setTimeout(() => {
    URL.revokeObjectURL(objectUrl);
  }, 100);
}

function createDocumentRow(documento) {
  const id = String(documento.id || '');
  const filename = String(documento.filename || 'Documento sin nombre');
  const mime = String(documento.mime || '');
  const size = formatBytes(documento.bytes_size);
  const createdAt = formatDate(documento.created_at);

  const row = el('article', 'rounded-2xl border border-slate-200 bg-white p-4 shadow-sm');

  const info = el('div', 'min-w-0 flex-1');
  info.append(
    el('h2', 'truncate text-sm font-semibold text-slate-900', filename),
    el('p', 'mt-1 text-xs text-slate-500', `${mime} · ${size} · ${createdAt}`),
  );

  const rowError = el(
    'p',
    'mt-3 hidden rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900',
    '',
  );
  rowError.setAttribute('role', 'alert');

  const downloadButton = actionButton(
    'Descargar',
    'rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-400 hover:bg-slate-50',
    async () => {
      downloadButton.disabled = true;
      rowError.classList.add('hidden');

      try {
        const heart = await resolveHeart();
        await downloadDocument(id, filename, heart);
        showStatus(DOWNLOAD_SUCCESS_MESSAGE);
      } catch (error) {
        showRowError(rowError, error);
      } finally {
        downloadButton.disabled = false;
      }
    },
  );

  const actions = el('nav', 'mt-4 flex flex-wrap items-center gap-2');
  actions.append(downloadButton);
  row.append(info, actions, rowError);

  return row;
}

/**
 * Shows an inline error inside a row, without taking the whole list down.
 *
 * @param {HTMLElement} errorNode
 * @param {unknown} error
 */
function showRowError(errorNode, error) {
  errorNode.textContent = friendlyError(error, DOWNLOAD_ERROR_MESSAGE);
  errorNode.classList.remove('hidden');
}

function renderDocuments(container, documentos) {
  renderList(container, documentos, {
    renderItem: (documento) => createDocumentRow(documento),
    emptyTitle: EMPTY_TITLE,
    emptyHint: EMPTY_HINT,
  });
}

/**
 * Loads the generated documents and paints them on screen.
 *
 * @returns {Promise<void>}
 */
export async function refreshGeneratedDocumentsLibrary() {
  const container = $id('generated-documents-list');
  if (!container) {
    return;
  }

  const version = ++refreshVersion;
  renderLoading(container, LOADING_MESSAGE);

  try {
    const heart = await resolveHeart();
    const data = await apiGet(`/documents?heart=${encodeURIComponent(heart)}&limit=20`, {
      fallbackMessage: LOAD_ERROR_MESSAGE,
    });
    if (version !== refreshVersion) {
      return;
    }
    const documentos = data && Array.isArray(data.documentos) ? data.documentos : [];
    renderDocuments(container, documentos);
  } catch (error) {
    if (version !== refreshVersion) {
      return;
    }
    renderError(container, error, LOAD_ERROR_MESSAGE, () => {
      void refreshGeneratedDocumentsLibrary();
    });
  }
}

/**
 * Wires the "Cargar documentos generados" button. Runs once.
 */
export function initGeneratedDocumentsLibrary() {
  if (initialized) {
    return;
  }
  initialized = true;

  const refreshButton = $id('generated-documents-refresh');
  if (refreshButton) {
    refreshButton.addEventListener('click', () => {
      void refreshGeneratedDocumentsLibrary();
    });
  }
}
