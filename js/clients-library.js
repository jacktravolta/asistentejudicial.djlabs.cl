import { apiDelete, apiGet, apiPatch, apiPost } from './http.js?v=2';
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

// Clients library: the person's own client book.
//
// The API owns the records: it stores the contact data of the people the
// user represents and returns only the rows that belong to the
// authenticated user and heart. This module creates, edits and deletes them.
//
// Keeping the client book is FREE: this module never asks for a quote,
// never reads the wallet and never shows a cost modal.
//
// Server-provided names, contact data and notes are rendered with DOM APIs
// only, so they can never be interpreted as markup.
//
// Every call names the heart explicitly: the API serves several hearts and
// rejects requests that do not identify one, so the book always belongs to
// the same installation the rest of the panel talks to.
//
// The list primitives (loading, empty, error and rows) live in the shared
// panel-section module, so the other panel sections can reuse them.

const FIELDS = Object.freeze(['nombre', 'email', 'telefono', 'rut', 'direccion', 'notas']);

const FIELD_LABELS = Object.freeze({
  nombre: 'Nombre',
  email: 'Correo',
  telefono: 'Teléfono',
  rut: 'RUT',
  direccion: 'Dirección',
  notas: 'Notas',
});

const INPUT_CLASS = 'mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100';

const LOADING_MESSAGE = 'Cargando tus clientes...';
const LOAD_ERROR_MESSAGE = 'No pudimos cargar tus clientes en este momento. Inténtalo nuevamente.';
const CREATE_ERROR_MESSAGE = 'No pudimos guardar el cliente en este momento. Inténtalo nuevamente.';
const UPDATE_ERROR_MESSAGE = 'No pudimos actualizar el cliente en este momento. Inténtalo nuevamente.';
const DELETE_ERROR_MESSAGE = 'No pudimos eliminar el cliente en este momento. Inténtalo nuevamente.';
const ROW_ERROR_MESSAGE = 'No pudimos completar esta acción. Inténtalo nuevamente en un momento.';
const EMPTY_TITLE = 'Todavía no tienes clientes guardados.';
const EMPTY_HINT = 'Cuando guardes a alguien a quien representas, aparecerá aquí con sus datos de contacto.';
const SEARCH_EMPTY_TITLE = 'No encontramos clientes con ese nombre.';
const SEARCH_EMPTY_HINT = 'Prueba con otro nombre o limpia la búsqueda para ver toda tu lista.';
const SAVE_SUCCESS_MESSAGE = 'Guardamos el cliente. Ya puedes asociarlo a una causa.';
const UPDATE_SUCCESS_MESSAGE = 'Actualizamos el cliente.';
const DELETE_SUCCESS_MESSAGE = 'Eliminamos el cliente.';
const NOTHING_TO_SAVE_MESSAGE = 'No había cambios que guardar.';

const $id = (id) => document.getElementById(id);

let initialized = false;
let refreshVersion = 0;

// The name filter currently applied to the list. It lives here so a refresh
// (after a create, an edit or a delete) keeps showing the same search.
let currentQuery = '';

/**
 * Reads the trimmed value of a form control.
 *
 * @param {string} id
 * @returns {string}
 */
function fieldValue(id) {
  const node = $id(id);
  return node ? String(node.value || '').trim() : '';
}

/**
 * Shows a kind confirmation near the section.
 *
 * @param {string} message
 */
function showStatus(message) {
  const node = $id('clients-status');
  if (!node) {
    return;
  }
  node.textContent = message;
  node.classList.remove('hidden');
}

/**
 * Shows the message the API sent, right next to the create form.
 *
 * @param {unknown} error
 */
function showFormError(error) {
  const node = $id('clients-form-error');
  if (!node) {
    return;
  }
  node.textContent = friendlyError(error, CREATE_ERROR_MESSAGE);
  node.classList.remove('hidden');
}

/**
 * Hides the message shown next to the create form.
 */
function clearFormError() {
  const node = $id('clients-form-error');
  if (!node) {
    return;
  }
  node.textContent = '';
  node.classList.add('hidden');
}

/**
 * Shows an error inside a row, without taking the whole list down.
 *
 * @param {HTMLElement} errorNode
 * @param {unknown} error
 */
function showRowError(errorNode, error) {
  errorNode.textContent = friendlyError(error, ROW_ERROR_MESSAGE);
  errorNode.classList.remove('hidden');
}

/**
 * Normalizes a value read from the API: an empty string is an empty value.
 *
 * @param {unknown} value
 * @returns {string}
 */
function normalize(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

/**
 * Builds the partial body of an update: only the fields that changed.
 *
 * A field the person emptied is sent as null, which is how the API stores
 * "no value" for that contact data.
 *
 * @param {object} client
 * @param {Record<string, string>} values
 * @returns {object}
 */
function buildChanges(client, values) {
  const changes = {};

  for (const field of FIELDS) {
    const next = normalize(values[field]);
    const current = normalize(client ? client[field] : '');
    if (next !== current) {
      changes[field] = next === '' ? null : next;
    }
  }

  return changes;
}

/**
 * Creates the inline form that edits one client.
 *
 * The form lives inside the row it edits, so the list keeps its shape while
 * the person corrects the contact data.
 *
 * @param {object} client
 * @param {(changes: object) => Promise<void>} onSave
 * @returns {HTMLFormElement}
 */
function createEditForm(client, onSave) {
  const form = el('form', 'mt-4 hidden space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4');
  form.dataset.clientEditForm = 'true';

  const grid = el('div', 'grid gap-3 sm:grid-cols-2');

  for (const field of FIELDS) {
    const wrap = el('div', field === 'notas' ? 'sm:col-span-2' : '');
    const inputId = `client-edit-${field}`;
    const label = el('label', 'text-sm font-medium text-slate-700', FIELD_LABELS[field]);
    label.setAttribute('for', inputId);

    let input;
    if (field === 'notas') {
      input = el('textarea', INPUT_CLASS);
      input.rows = 3;
    } else {
      input = el('input', INPUT_CLASS);
      input.type = field === 'email' ? 'email' : 'text';
    }
    input.id = inputId;
    input.name = field;
    input.dataset.clientField = field;
    input.value = normalize(client ? client[field] : '');
    if (field === 'nombre') {
      input.required = true;
    }

    wrap.append(label, input);
    grid.append(wrap);
  }

  const actions = el('div', 'flex flex-wrap items-center gap-2');

  const saveButton = el(
    'button',
    'rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-200',
    'Guardar cambios',
  );
  saveButton.type = 'submit';
  saveButton.dataset.clientEditSave = 'true';

  const cancelButton = actionButton(
    'Cancelar',
    'rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-400 hover:bg-slate-50',
    () => {
      form.classList.add('hidden');
    },
  );
  cancelButton.dataset.clientEditCancel = 'true';

  actions.append(saveButton, cancelButton);
  form.append(grid, actions);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const values = {};
    for (const field of FIELDS) {
      const input = form.querySelector(`[data-client-field="${field}"]`);
      values[field] = input ? String(input.value || '').trim() : '';
    }

    const changes = buildChanges(client, values);
    if (!Object.keys(changes).length) {
      form.classList.add('hidden');
      showStatus(NOTHING_TO_SAVE_MESSAGE);
      return;
    }

    saveButton.disabled = true;
    try {
      await onSave(changes);
      form.classList.add('hidden');
    } finally {
      saveButton.disabled = false;
    }
  });

  return form;
}

/**
 * Creates the row of one client: its name, the contact data that exists and
 * the actions to edit or delete it.
 *
 * @param {object} client
 * @returns {HTMLElement}
 */
function createClientRow(client) {
  const id = String((client && client.id) || '');
  const nombre = normalize(client && client.nombre) || 'Cliente sin nombre';

  const row = el('article', 'rounded-2xl border border-slate-200 bg-white p-4 shadow-sm');
  row.dataset.clientId = id;

  const info = el('div', 'min-w-0 flex-1');
  info.append(
    el('h2', 'truncate text-sm font-semibold text-slate-900', nombre),
    el('p', 'mt-1 text-xs text-slate-500', `Guardado el ${formatDate(client && client.created_at)}`),
  );

  // Only the contact data that exists is shown: an empty label would only
  // add noise to the list.
  const details = el('ul', 'mt-2 space-y-1 text-xs text-slate-600');
  details.dataset.clientDetails = 'true';
  for (const field of FIELDS) {
    if (field === 'nombre') {
      continue;
    }
    const value = normalize(client && client[field]);
    if (!value) {
      continue;
    }
    const item = el('li', 'break-words');
    item.dataset.clientDetail = field;
    item.append(
      el('span', 'font-medium text-slate-700', `${FIELD_LABELS[field]}: `),
      el('span', '', value),
    );
    details.append(item);
  }
  if (details.childElementCount) {
    info.append(details);
  }

  const rowError = el(
    'p',
    'mt-3 hidden rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900',
    '',
  );
  rowError.setAttribute('role', 'alert');

  const editForm = createEditForm(client, async (changes) => {
    rowError.classList.add('hidden');
    try {
      const heart = await resolveHeart();
      await apiPatch(
        `/clients/${encodeURIComponent(id)}?heart=${encodeURIComponent(heart)}`,
        changes,
        { fallbackMessage: UPDATE_ERROR_MESSAGE },
      );
      await refreshClientsLibrary();
      showStatus(UPDATE_SUCCESS_MESSAGE);
    } catch (error) {
      showRowError(rowError, error);
    }
  });

  const editButton = actionButton(
    'Editar',
    'rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-400 hover:bg-slate-50',
    () => {
      rowError.classList.add('hidden');
      editForm.classList.toggle('hidden');
      editButton.setAttribute('aria-expanded', editForm.classList.contains('hidden') ? 'false' : 'true');
    },
  );
  editButton.setAttribute('aria-expanded', 'false');

  const deleteButton = actionButton(
    'Eliminar',
    'rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700 transition hover:bg-red-50',
    async () => {
      const confirmed = window.confirm(
        `¿Quieres eliminar "${nombre}" de tu lista de clientes? Esta acción no se puede deshacer.`,
      );
      if (!confirmed) {
        return;
      }

      deleteButton.disabled = true;
      rowError.classList.add('hidden');

      try {
        const heart = await resolveHeart();
        await apiDelete(
          `/clients/${encodeURIComponent(id)}?heart=${encodeURIComponent(heart)}`,
          { fallbackMessage: DELETE_ERROR_MESSAGE },
        );
        await refreshClientsLibrary();
        showStatus(DELETE_SUCCESS_MESSAGE);
      } catch (error) {
        showRowError(rowError, error);
        deleteButton.disabled = false;
      }
    },
  );

  const actions = el('nav', 'mt-4 flex flex-wrap items-center gap-2');
  actions.append(editButton, deleteButton);

  row.append(info, actions, rowError, editForm);
  return row;
}

/**
 * Renders the list of clients.
 *
 * @param {HTMLElement} container
 * @param {Array<unknown>} clients
 */
function renderClients(container, clients) {
  // A search that matches nobody says so: telling the person that they have
  // no clients at all would be a lie when their list is simply filtered.
  const searching = currentQuery !== '';

  renderList(container, clients, {
    renderItem: (client) => createClientRow(client),
    emptyTitle: searching ? SEARCH_EMPTY_TITLE : EMPTY_TITLE,
    emptyHint: searching ? SEARCH_EMPTY_HINT : EMPTY_HINT,
  });
}

/**
 * Wires the create form and the name search. It runs only once, so the form
 * never ends up with two listeners and a double save.
 */
export function initClientsLibrary() {
  const form = $id('clients-form');
  const searchForm = $id('clients-search-form');
  if (!form || !searchForm || initialized) {
    return;
  }
  initialized = true;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFormError();

    const nombre = fieldValue('clients-nombre');
    if (!nombre) {
      showFormError(new Error('Indícanos el nombre del cliente.'));
      return;
    }

    const submitButton = $id('clients-submit');
    if (submitButton) {
      submitButton.disabled = true;
    }

    try {
      const heart = await resolveHeart();
      await apiPost(
        '/clients',
        {
          heart,
          nombre,
          email: fieldValue('clients-email') || null,
          telefono: fieldValue('clients-telefono') || null,
          rut: fieldValue('clients-rut') || null,
          direccion: fieldValue('clients-direccion') || null,
          notas: fieldValue('clients-notas') || null,
        },
        {},
        { fallbackMessage: CREATE_ERROR_MESSAGE },
      );

      form.reset();
      await refreshClientsLibrary();
      showStatus(SAVE_SUCCESS_MESSAGE);
    } catch (error) {
      showFormError(error);
    } finally {
      if (submitButton) {
        submitButton.disabled = false;
      }
    }
  });

  searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    currentQuery = fieldValue('clients-search');
    void refreshClientsLibrary();
  });

  const clearButton = $id('clients-search-clear');
  if (clearButton) {
    clearButton.addEventListener('click', () => {
      const search = $id('clients-search');
      if (search) {
        search.value = '';
      }
      currentQuery = '';
      void refreshClientsLibrary();
    });
  }
}

/**
 * Loads the client book and paints it on screen.
 *
 * @returns {Promise<void>}
 */
export async function refreshClientsLibrary() {
  const container = $id('clients-list');
  if (!container) {
    return;
  }

  const version = ++refreshVersion;
  renderLoading(container, LOADING_MESSAGE);

  try {
    const heart = await resolveHeart();
    const search = currentQuery ? `&q=${encodeURIComponent(currentQuery)}` : '';
    const data = await apiGet(
      `/clients?heart=${encodeURIComponent(heart)}${search}`,
      { fallbackMessage: LOAD_ERROR_MESSAGE },
    );
    if (version !== refreshVersion) {
      return;
    }
    const clients = data && Array.isArray(data.clientes) ? data.clientes : [];
    renderClients(container, clients);
  } catch (error) {
    if (version !== refreshVersion) {
      return;
    }
    renderError(container, error, LOAD_ERROR_MESSAGE, () => {
      void refreshClientsLibrary();
    });
  }
}
