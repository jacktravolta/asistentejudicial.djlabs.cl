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

// Cases library: the person's own case docket.
//
// The API owns the records: it stores the case data of the causes the user
// follows and returns only the rows that belong to the authenticated user
// and heart. This module creates, lists, edits and deletes them.
//
// Keeping the docket is FREE: this module never asks for a quote, never
// reads the wallet and never shows a cost modal.
//
// Server-provided case data is rendered with DOM APIs only, so it can never
// be interpreted as markup.
//
// Every call names the heart explicitly: the API serves several hearts and
// rejects requests that do not identify one, so the docket always belongs to
// the same installation the rest of the panel talks to.
//
// The list primitives (loading, empty, error and rows) live in the shared
// panel-section module, so the other panel sections can reuse them.

const FIELDS = Object.freeze([
  'rol',
  'ruc',
  'rit',
  'tribunal',
  'materia',
  'estado',
  'etapa',
  'ultima_resolucion',
  'ultima_resolucion_fecha',
  'proxima_audiencia',
  'fecha_ingreso',
  'notas',
]);

// Fields shown and editable in the inline edit form of a row.
const EDIT_FIELDS = Object.freeze([
  'rol',
  'ruc',
  'rit',
  'tribunal',
  'materia',
  'estado',
  'etapa',
  'proxima_audiencia',
  'notas',
]);

const DATE_FIELDS = Object.freeze([
  'ultima_resolucion_fecha',
  'proxima_audiencia',
  'fecha_ingreso',
]);

const FIELD_LABELS = Object.freeze({
  rol: 'Rol',
  ruc: 'RUC',
  rit: 'RIT',
  tribunal: 'Tribunal',
  materia: 'Materia',
  estado: 'Estado',
  etapa: 'Etapa',
  ultima_resolucion: 'Última resolución',
  ultima_resolucion_fecha: 'Fecha de la última resolución',
  proxima_audiencia: 'Próxima audiencia',
  fecha_ingreso: 'Fecha de ingreso',
  notas: 'Notas',
});

const INPUT_CLASS = 'mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100';

const LOADING_MESSAGE = 'Cargando tus causas...';
const LOAD_ERROR_MESSAGE = 'No pudimos cargar tus causas en este momento. Inténtalo nuevamente.';
const CREATE_ERROR_MESSAGE = 'No pudimos guardar la causa en este momento. Inténtalo nuevamente.';
const UPDATE_ERROR_MESSAGE = 'No pudimos actualizar la causa en este momento. Inténtalo nuevamente.';
const DELETE_ERROR_MESSAGE = 'No pudimos eliminar la causa en este momento. Inténtalo nuevamente.';
const ROW_ERROR_MESSAGE = 'No pudimos completar esta acción. Inténtalo nuevamente en un momento.';
const EMPTY_TITLE = 'Todavía no tienes causas guardadas.';
const EMPTY_HINT = 'Cuando guardes una causa, aparecerá aquí con sus plazos y estado.';
const SAVE_SUCCESS_MESSAGE = 'Guardamos la causa. Ya puedes seguir sus plazos.';
const UPDATE_SUCCESS_MESSAGE = 'Actualizamos la causa.';
const DELETE_SUCCESS_MESSAGE = 'Eliminamos la causa.';
const NOTHING_TO_SAVE_MESSAGE = 'No había cambios que guardar.';
const AT_LEAST_ONE_ID_MESSAGE = 'Dinos al menos un identificador de la causa: el rol, el RUC o el RIT.';
const CLIENT_SELECT_PLACEHOLDER = 'Sin cliente asociado (opcional)';

const $id = (id) => document.getElementById(id);

let initialized = false;
let refreshVersion = 0;

// Clients already loaded for the "cliente asociado" selector. The association
// is optional, so a failed load never blocks the docket itself.
let clientOptions = [];

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
  const node = $id('cases-status');
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
  const node = $id('cases-form-error');
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
  const node = $id('cases-form-error');
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
 * "no value" for that case data.
 *
 * @param {object} caso
 * @param {Record<string, string>} values
 * @returns {object}
 */
function buildChanges(caso, values) {
  const changes = {};

  for (const field of EDIT_FIELDS) {
    const next = normalize(values[field]);
    const current = normalize(caso ? caso[field] : '');
    if (next !== current) {
      changes[field] = next === '' ? null : next;
    }
  }

  return changes;
}

/**
 * Creates a single form control for one case field.
 *
 * @param {string} field
 * @param {string} value
 * @returns {HTMLElement}
 */
function createFieldControl(field, value) {
  const inputId = `case-edit-${field}`;
  const label = el('label', 'text-sm font-medium text-slate-700', FIELD_LABELS[field]);
  label.setAttribute('for', inputId);

  let input;
  if (DATE_FIELDS.includes(field)) {
    input = el('input', INPUT_CLASS);
    input.type = 'date';
    input.id = inputId;
    input.name = field;
    input.dataset.caseField = field;
    input.value = value;
  } else if (field === 'notas') {
    input = el('textarea', INPUT_CLASS);
    input.rows = 3;
    input.id = inputId;
    input.name = field;
    input.dataset.caseField = field;
    input.value = value;
  } else {
    input = el('input', INPUT_CLASS);
    input.type = 'text';
    input.id = inputId;
    input.name = field;
    input.dataset.caseField = field;
    input.value = value;
  }

  const wrap = el('div', field === 'notas' ? 'sm:col-span-2' : '');
  wrap.append(label, input);
  return wrap;
}

/**
 * Creates the inline form that edits one case.
 *
 * The form lives inside the row it edits, so the list keeps its shape while
 * the person corrects the case data.
 *
 * @param {object} caso
 * @param {(changes: object) => Promise<void>} onSave
 * @returns {HTMLFormElement}
 */
function createEditForm(caso, onSave) {
  const form = el('form', 'mt-4 hidden space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4');
  form.dataset.casoEditForm = 'true';

  const grid = el('div', 'grid gap-3 sm:grid-cols-2');

  for (const field of EDIT_FIELDS) {
    grid.append(createFieldControl(field, normalize(caso ? caso[field] : '')));
  }

  const actions = el('div', 'flex flex-wrap items-center gap-2');

  const saveButton = el(
    'button',
    'rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-200',
    'Guardar cambios',
  );
  saveButton.type = 'submit';
  saveButton.dataset.casoEditSave = 'true';

  const cancelButton = actionButton(
    'Cancelar',
    'rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-400 hover:bg-slate-50',
    () => {
      form.classList.add('hidden');
    },
  );
  cancelButton.dataset.casoEditCancel = 'true';

  actions.append(saveButton, cancelButton);
  form.append(grid, actions);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const values = {};
    for (const field of EDIT_FIELDS) {
      const input = form.querySelector(`[data-case-field="${field}"]`);
      values[field] = input ? String(input.value || '').trim() : '';
    }

    const changes = buildChanges(caso, values);
    if (!Object.keys(changes).length) {
      form.classList.add('hidden');
      showStatus(NOTHING_TO_SAVE_MESSAGE);
      return;
    }

    saveButton.disabled = true;
    try {
      const heart = await resolveHeart();
      await onSave(changes, heart);
      form.classList.add('hidden');
    } finally {
      saveButton.disabled = false;
    }
  });

  return form;
}

/**
 * Populates the "cliente asociado" select of the create form with the
 * clients of the current heart. The association is optional.
 *
 * @returns {Promise<void>}
 */
async function loadClientSelect() {
  const select = $id('cases-cliente_id');
  if (!select) {
    return;
  }

  // Keep the placeholder option, drop any previously loaded ones.
  const placeholder = select.querySelector('option');
  select.replaceChildren(placeholder);

  try {
    const heart = await resolveHeart();
    const data = await apiGet(
      `/clients?heart=${encodeURIComponent(heart)}`,
      { fallbackMessage: LOAD_ERROR_MESSAGE },
    );
    const clients = data && Array.isArray(data.clientes) ? data.clientes : [];
    clientOptions = clients;

    for (const client of clients) {
      const id = String((client && client.id) || '');
      const nombre = normalize(client && client.nombre) || 'Cliente sin nombre';
      const option = el('option', '', nombre);
      option.value = id;
      select.append(option);
    }
  } catch (error) {
    // Non-fatal: the client association is optional. Keep the select with
    // only the placeholder and let the docket load normally.
    clientOptions = [];
    console.warn('[CasesLibrary] No se pudieron cargar los clientes para el selector:', error);
  }
}

/**
 * Creates the row of one case: its identifiers, the data that exists and the
 * actions to edit or delete it.
 *
 * @param {object} caso
 * @returns {HTMLElement}
 */
function createCaseRow(caso) {
  const id = String((caso && caso.id) || '');
  const rol = normalize(caso && caso.rol) || 'Causa sin rol';

  const row = el('article', 'rounded-2xl border border-slate-200 bg-white p-4 shadow-sm');
  row.dataset.casoId = id;

  const info = el('div', 'min-w-0 flex-1');
  info.append(
    el('h2', 'truncate text-sm font-semibold text-slate-900', rol),
    el('p', 'mt-1 text-xs text-slate-500', `Registrada el ${formatDate(caso && caso.created_at)}`),
  );

  // Only the data that exists is shown: an empty label would only add noise.
  const details = el('ul', 'mt-2 space-y-1 text-xs text-slate-600');
  details.dataset.casoDetails = 'true';

  const detailSpec = [
    { field: 'ruc', label: 'RUC' },
    { field: 'rit', label: 'RIT' },
    { field: 'tribunal', label: 'Tribunal' },
    { field: 'materia', label: 'Materia' },
    { field: 'estado', label: 'Estado' },
    { field: 'etapa', label: 'Etapa' },
    { field: 'proxima_audiencia', label: 'Próxima audiencia' },
    { field: 'notas', label: 'Notas' },
  ];

  for (const spec of detailSpec) {
    const value = normalize(caso && caso[spec.field]);
    if (!value) {
      continue;
    }
    const item = el('li', 'break-words');
    item.dataset.casoDetail = spec.field;
    item.append(
      el('span', 'font-medium text-slate-700', `${spec.label}: `),
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

  const editForm = createEditForm(caso, async (changes, heart) => {
    rowError.classList.add('hidden');
    try {
      await apiPatch(
        `/cases/${encodeURIComponent(id)}?heart=${encodeURIComponent(heart)}`,
        changes,
        { fallbackMessage: UPDATE_ERROR_MESSAGE },
      );
      await refreshCasesLibrary();
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
        `¿Quieres eliminar "${rol}"? Esta acción no se puede deshacer.`,
      );
      if (!confirmed) {
        return;
      }

      deleteButton.disabled = true;
      rowError.classList.add('hidden');

      try {
        const heart = await resolveHeart();
        await apiDelete(
          `/cases/${encodeURIComponent(id)}?heart=${encodeURIComponent(heart)}`,
          { fallbackMessage: DELETE_ERROR_MESSAGE },
        );
        await refreshCasesLibrary();
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
 * Renders the list of cases.
 *
 * @param {HTMLElement} container
 * @param {Array<unknown>} casos
 */
function renderCases(container, casos) {
  renderList(container, casos, {
    renderItem: (caso) => createCaseRow(caso),
    emptyTitle: EMPTY_TITLE,
    emptyHint: EMPTY_HINT,
  });
}

/**
 * Wires the create form. It runs only once, so the form never ends up with
 * two listeners and a double save.
 */
export function initCasesLibrary() {
  const form = $id('cases-form');
  if (!form || initialized) {
    return;
  }
  initialized = true;

  void loadClientSelect();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFormError();

    const rol = fieldValue('cases-rol');
    const ruc = fieldValue('cases-ruc');
    const rit = fieldValue('cases-rit');
    if (!rol && !ruc && !rit) {
      showFormError(new Error(AT_LEAST_ONE_ID_MESSAGE));
      return;
    }

    const submitButton = $id('cases-submit');
    if (submitButton) {
      submitButton.disabled = true;
    }

    try {
      const heart = await resolveHeart();
      await apiPost(
        '/cases',
        {
          heart,
          cliente_id: fieldValue('cases-cliente_id') || null,
          rol,
          ruc,
          rit,
          tribunal: fieldValue('cases-tribunal') || null,
          materia: fieldValue('cases-materia') || null,
          estado: fieldValue('cases-estado') || null,
          etapa: fieldValue('cases-etapa') || null,
          ultima_resolucion: fieldValue('cases-ultima_resolucion') || null,
          ultima_resolucion_fecha: fieldValue('cases-ultima_resolucion_fecha') || null,
          proxima_audiencia: fieldValue('cases-proxima_audiencia') || null,
          fecha_ingreso: fieldValue('cases-fecha_ingreso') || null,
          notas: fieldValue('cases-notas') || null,
        },
        {},
        { fallbackMessage: CREATE_ERROR_MESSAGE },
      );

      form.reset();
      await loadClientSelect();
      await refreshCasesLibrary();
      showStatus(SAVE_SUCCESS_MESSAGE);
    } catch (error) {
      showFormError(error);
    } finally {
      if (submitButton) {
        submitButton.disabled = false;
      }
    }
  });
}

/**
 * Loads the case docket and paints it on screen.
 *
 * @returns {Promise<void>}
 */
export async function refreshCasesLibrary() {
  const container = $id('cases-list');
  if (!container) {
    return;
  }

  const version = ++refreshVersion;
  renderLoading(container, LOADING_MESSAGE);

  try {
    const heart = await resolveHeart();
    const data = await apiGet(
      `/cases?heart=${encodeURIComponent(heart)}`,
      { fallbackMessage: LOAD_ERROR_MESSAGE },
    );
    if (version !== refreshVersion) {
      return;
    }
    const casos = data && Array.isArray(data.casos) ? data.casos : [];
    renderCases(container, casos);
    // The client selector is refreshed together with the docket so a newly
    // created client can be associated right away.
    void loadClientSelect();
  } catch (error) {
    if (version !== refreshVersion) {
      return;
    }
    renderError(container, error, LOAD_ERROR_MESSAGE, () => {
      void refreshCasesLibrary();
    });
  }
}
