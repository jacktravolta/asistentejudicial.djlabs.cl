// Shared primitives for the panel sections.
//
// The panel keeps growing (conversations, cases, clients, law search, drafts
// and the analyzer) and every section needs the same list skeleton: a loading
// state, an honest empty state, a friendly error state with a retry button,
// and the list of rows itself.
//
// This module is intentionally dependency-free: it only builds DOM nodes and
// formats strings. It never talks to the API, never reads or writes globals,
// and never renders server-provided text as markup (text always goes through
// textContent).

const DATE_FORMAT = new Intl.DateTimeFormat('es-CL', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});

const NUMBER_FORMAT = new Intl.NumberFormat('es-CL');

/**
 * Creates an element and fills it with plain text.
 *
 * @param {string} tag
 * @param {string} [className]
 * @param {string|number|null} [text]
 * @returns {HTMLElement}
 */
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined && text !== null) {
    node.textContent = String(text);
  }
  return node;
}

/**
 * Picks the message to show for a failed request.
 *
 * A missing session always gets the same honest message; any other error
 * keeps the message the API sent; anything else falls back.
 *
 * @param {unknown} error
 * @param {string} fallback
 * @returns {string}
 */
export function friendlyError(error, fallback) {
  if (error && error.status === 401) {
    return 'Tu sesión no está disponible. Inicia sesión nuevamente para continuar.';
  }
  if (error && typeof error.message === 'string' && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

/**
 * Formats a date for the panel, in Spanish (Chile).
 *
 * @param {string|number|Date|null|undefined} value
 * @returns {string}
 */
export function formatDate(value) {
  if (!value) {
    return 'Fecha no disponible';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'Fecha no disponible';
  }
  return DATE_FORMAT.format(date);
}

/**
 * Formats a number for the panel, in Spanish (Chile).
 *
 * Anything that is not a finite, non-negative number is shown as 0.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function formatNumber(value) {
  const count = Number(value);
  const safeCount = Number.isFinite(count) && count >= 0 ? count : 0;
  return NUMBER_FORMAT.format(safeCount);
}

/**
 * Replaces the container content with a loading message.
 *
 * @param {HTMLElement} container
 * @param {string} message
 */
export function renderLoading(container, message) {
  container.replaceChildren(
    el('p', 'rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500', message),
  );
}

/**
 * Replaces the container content with an honest empty state.
 *
 * @param {HTMLElement} container
 * @param {string} title
 * @param {string} hint
 */
export function renderEmpty(container, title, hint) {
  const box = el('div', 'rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center');
  box.append(
    el('p', 'text-sm font-medium text-slate-700', title),
    el('p', 'mt-1 text-sm text-slate-500', hint),
  );
  container.replaceChildren(box);
}

/**
 * Replaces the container content with a friendly error and a retry button.
 *
 * The caller owns the retry behavior: `onRetry` is invoked when the user
 * asks to try again.
 *
 * @param {HTMLElement} container
 * @param {unknown} error
 * @param {string} fallbackMessage
 * @param {() => void|Promise<void>} onRetry
 */
export function renderError(container, error, fallbackMessage, onRetry) {
  const box = el('div', 'rounded-xl border border-amber-200 bg-amber-50 p-4');
  box.append(
    el('p', 'text-sm text-amber-900', friendlyError(error, fallbackMessage)),
  );
  box.append(
    actionButton(
      'Reintentar',
      'mt-3 rounded-lg border border-amber-300 bg-white px-4 py-2 text-sm font-medium text-amber-800 transition hover:bg-amber-50',
      onRetry,
    ),
  );
  container.replaceChildren(box);
}

/**
 * Replaces the container content with the list of rows.
 *
 * When there is nothing to show, the empty state takes over.
 *
 * @param {HTMLElement} container
 * @param {Array<unknown>} items
 * @param {{ renderItem: (item: unknown) => Node, emptyTitle: string, emptyHint: string }} options
 */
export function renderList(container, items, options) {
  const { renderItem, emptyTitle, emptyHint } = options || {};
  const list = Array.isArray(items) ? items : [];

  if (!list.length) {
    renderEmpty(container, emptyTitle, emptyHint);
    return;
  }

  const node = el('ul', 'space-y-3');
  for (const item of list) {
    const wrapper = el('li');
    wrapper.append(renderItem(item));
    node.append(wrapper);
  }
  container.replaceChildren(node);
}

/**
 * Creates a button that runs an action.
 *
 * The callback owns its own error handling (the rows show their errors
 * inline), so an async callback is safe to pass.
 *
 * @param {string} label
 * @param {string} className
 * @param {() => void|Promise<void>} onClick
 * @returns {HTMLButtonElement}
 */
export function actionButton(label, className, onClick) {
  const button = el('button', className, label);
  button.type = 'button';
  button.addEventListener('click', () => {
    if (typeof onClick !== 'function') {
      return;
    }
    try {
      const result = onClick();
      if (result && typeof result.catch === 'function') {
        result.catch((error) => {
          console.error('[PanelSection] Action failed:', error);
        });
      }
    } catch (error) {
      console.error('[PanelSection] Action failed:', error);
    }
  });
  return button;
}
