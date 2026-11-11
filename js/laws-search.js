import { apiGet } from './http.js?v=1';
import { resolveHeart } from './heart.js?v=1';
import {
  actionButton,
  el,
  formatDate,
  formatNumber,
  renderError,
  renderList,
  renderLoading,
} from './panel-section.js?v=1';

// Law search panel: reads the official text of a Chilean law by its number.
//
// The API resolves the number against the official source (BCN) on demand and
// keeps a short-lived cache, so the panel only asks for what the person typed
// and never downloads the whole corpus.
//
// Searching a law is FREE: this module never asks for a quote, never reads
// the wallet and never shows a cost modal. The panel says so out loud.
//
// Server-provided titles, summaries and article texts are rendered with DOM
// APIs only, so they can never be interpreted as markup.
//
// A law in "refundido" form can repeat an article number: the body and the
// final provisions both have an article 1. Each occurrence is a different part
// of the law and is shown exactly as the official text states it. The panel
// never hides nor merges them.
//
// The list primitives (loading, error, empty state and rows) live in the
// shared panel-section module, so the other panel sections can reuse them.

const PAGE_SIZE = 50;
const LOADING_MESSAGE = 'Consultando la fuente oficial...';
const SEARCH_ERROR_MESSAGE = 'No pudimos consultar la fuente oficial en este momento. Inténtalo nuevamente.';
const ARTICLE_MISSING_TITLE = 'No encontramos ese artículo en esta ley.';
const ARTICLE_MISSING_HINT = 'Puedes intentar con otro número de artículo o consultar la ley completa.';
const NO_ARTICLES_TITLE = 'Esta ley no tiene artículos para mostrar.';
const NO_ARTICLES_HINT = 'Prueba con el número de otra ley.';
const DUPLICATE_NOTE = 'Esta ley refundida repite algunos números de artículo en otra sección (por ejemplo, las disposiciones finales). Cada aparición es una parte distinta de la ley y se muestra tal como aparece en el texto oficial.';

const $id = (id) => document.getElementById(id);
let initialized = false;
let refreshVersion = 0;

// The law currently on screen: its metadata, the articles already shown and
// the window they came from, so "Ver más artículos" can append the next one.
let activeSearch = null;

/**
 * Names where the answer came from.
 *
 * @param {unknown} fuente
 * @returns {string}
 */
function sourceLabel(fuente) {
  const value = String(fuente || '').trim().toLowerCase();
  return value === 'cache' ? 'Caché del servicio' : 'Fuente oficial';
}

/**
 * Formats the law number the way it is written in Chile (19.628).
 *
 * @param {unknown} numero
 * @returns {string}
 */
function lawNumberLabel(numero) {
  const value = String(numero || '').trim();
  if (!value) {
    return '';
  }
  return /^\d+$/.test(value) ? formatNumber(value) : value;
}

/**
 * Keeps only the official links we are willing to open.
 *
 * @param {unknown} value
 * @returns {string}
 */
function officialUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }

  try {
    const parsed = new URL(raw, window.location.origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '';
    }
    return parsed.href;
  } catch (_) {
    return '';
  }
}

/**
 * Creates a small state label (vigencia, verification).
 *
 * @param {string} text
 * @param {boolean} positive
 * @returns {HTMLElement}
 */
function createBadge(text, positive) {
  const className = positive
    ? 'rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700'
    : 'rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600';
  return el('span', className, text);
}

/**
 * One article of the law: its number and its text.
 *
 * @param {unknown} article
 * @returns {HTMLElement}
 */
function createArticleItem(article) {
  const numero = String((article && article.numero) || '').trim();
  const texto = String((article && article.texto) || '').trim();
  const modificado = String((article && article.modificado_por) || '').trim();

  const item = el('li', 'rounded-xl border border-slate-200 bg-white p-4');
  item.dataset.articleNumero = numero;

  item.append(
    el('h3', 'text-sm font-semibold text-slate-900', numero ? `Artículo ${numero}` : 'Artículo'),
    el('p', 'mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-700', texto),
  );

  if (modificado) {
    item.append(el('p', 'mt-2 text-xs text-slate-500', `Modificado por: ${modificado}`));
  }

  return item;
}

/**
 * Tells whether the same article number appears more than once.
 *
 * A refundido law repeats numbers (body + final provisions). The panel shows
 * every occurrence, so it must also explain the repetition when it happens.
 *
 * @param {Array<unknown>} articles
 * @returns {boolean}
 */
function hasRepeatedNumber(articles) {
  const seen = new Set();

  for (const article of articles) {
    const numero = String((article && article.numero) || '').trim();
    if (!numero) {
      continue;
    }
    if (seen.has(numero)) {
      return true;
    }
    seen.add(numero);
  }

  return false;
}

/**
 * Builds the card with the law and its articles.
 *
 * @param {{ law: object, articles: Array<unknown>, articulo: string }} search
 * @returns {HTMLElement}
 */
function createLawCard(search) {
  const law = search.law || {};
  const articles = search.articles || [];
  const articleMissing = law.articulo_encontrado === false;

  const card = el('article', 'rounded-2xl border border-slate-200 bg-white p-4 shadow-sm');
  card.dataset.lawNumero = String(law.numero || '');

  const header = el('header', 'space-y-2');
  header.append(
    el('h2', 'text-sm font-semibold text-slate-900', String(law.titulo || '').trim() || 'Ley sin título'),
  );

  const tipo = String(law.tipo || '').trim();
  const numero = lawNumberLabel(law.numero);
  const organismo = String(law.organismo || '').trim();
  const identity = [tipo && numero ? `${tipo} ${numero}` : (tipo || numero), organismo]
    .filter(Boolean)
    .join(' · ');
  if (identity) {
    header.append(el('p', 'text-xs text-slate-500', identity));
  }

  const badges = el('div', 'flex flex-wrap items-center gap-2');
  badges.append(
    createBadge(law.vigente === true ? 'Vigente' : 'Sin vigencia informada', law.vigente === true),
    createBadge(law.verbatim === true ? 'Texto oficial verificado' : 'Texto no verificado', law.verbatim === true),
  );
  header.append(badges);

  const total = Number(law.total_articulos);
  const parts = [sourceLabel(law.fuente), `consultado el ${formatDate(law.consultado_en)}`];
  if (Number.isFinite(total) && total >= 0) {
    parts.push(`${formatNumber(total)} artículos en total`);
  }
  header.append(el('p', 'text-xs text-slate-500', parts.join(' · ')));

  const url = officialUrl(law.url);
  if (url) {
    const link = el(
      'a',
      'inline-flex items-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-400 hover:bg-slate-50',
      'Ver en la fuente oficial',
    );
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    header.append(link);
  }

  card.append(header);

  const resumen = String(law.resumen || '').trim();
  if (resumen) {
    card.append(el('p', 'text-sm leading-relaxed text-slate-600', resumen));
  }

  if (hasRepeatedNumber(articles)) {
    card.append(
      el('p', 'rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600', DUPLICATE_NOTE),
    );
  }

  // renderList() REPLACES the content of the container it receives, so the
  // articles get their own host: the header of the law stays on screen.
  const articlesHost = el('div', 'space-y-3');
  renderList(articlesHost, articles, {
    renderItem: (article) => createArticleItem(article),
    emptyTitle: articleMissing ? ARTICLE_MISSING_TITLE : NO_ARTICLES_TITLE,
    emptyHint: articleMissing ? ARTICLE_MISSING_HINT : NO_ARTICLES_HINT,
  });
  card.append(articlesHost);

  // A single article is a closed question: there is nothing else to load.
  if (law.truncado === true && !search.articulo) {
    const more = actionButton(
      'Ver más artículos',
      'rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-400 hover:bg-slate-50',
      async () => {
        more.disabled = true;
        try {
          await loadNextWindow();
        } finally {
          more.disabled = false;
        }
      },
    );
    const actions = el('nav', 'mt-4 flex flex-wrap items-center gap-2');
    actions.append(more);
    card.append(actions);
  }

  return card;
}

/**
 * Renders the law currently on screen.
 *
 * @param {HTMLElement} container
 * @param {{ law: object, articles: Array<unknown>, articulo: string }} search
 */
function renderResults(container, search) {
  container.replaceChildren(createLawCard(search));
}

/**
 * Asks the API for a law (or for the next window of the law on screen).
 *
 * @param {{ numero: string, articulo: string, desde?: number, append?: boolean }} options
 * @returns {Promise<void>}
 */
async function searchLaws(options) {
  const container = $id('laws-results');
  if (!container) {
    return;
  }

  const { numero, articulo, desde = 0, append = false } = options;
  const version = ++refreshVersion;

  if (!append) {
    activeSearch = null;
    renderLoading(container, LOADING_MESSAGE);
  }

  try {
    const heart = await resolveHeart();
    const query = `/laws/search?numero=${encodeURIComponent(numero)}&heart=${encodeURIComponent(heart)}`
      + (articulo ? `&articulo=${encodeURIComponent(articulo)}` : '')
      + `&desde=${desde}&limite=${PAGE_SIZE}`;

    const data = await apiGet(query, { fallbackMessage: SEARCH_ERROR_MESSAGE });
    if (version !== refreshVersion) {
      return;
    }

    const articles = data && Array.isArray(data.articulos) ? data.articulos : [];

    if (append && activeSearch) {
      activeSearch = {
        ...activeSearch,
        law: data,
        articles: activeSearch.articles.concat(articles),
        desde,
      };
    } else {
      activeSearch = { numero, articulo, heart, desde, law: data, articles };
    }

    renderResults(container, activeSearch);
  } catch (error) {
    if (version !== refreshVersion) {
      return;
    }
    activeSearch = null;
    renderError(container, error, SEARCH_ERROR_MESSAGE, () => {
      void searchLaws({ numero, articulo, desde: 0, append: false });
    });
  }
}

/**
 * Loads the next window of the law on screen and appends it.
 *
 * @returns {Promise<void>}
 */
async function loadNextWindow() {
  if (!activeSearch) {
    return;
  }

  await searchLaws({
    numero: activeSearch.numero,
    articulo: activeSearch.articulo,
    desde: activeSearch.desde + PAGE_SIZE,
    append: true,
  });
}

/**
 * Wires the search form. It runs only once, so the form never ends up with
 * two listeners and a double search.
 */
export function initLawsSearch() {
  const form = $id('laws-form');
  if (!form || initialized) {
    return;
  }
  initialized = true;

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const numero = ($id('laws-numero')?.value || '').trim();
    const articulo = ($id('laws-articulo')?.value || '').trim();
    void searchLaws({ numero, articulo, desde: 0, append: false });
  });
}
