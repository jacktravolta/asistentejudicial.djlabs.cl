// Buscador de leyes BCN — Module 2 (requerimiento.txt, "Módulo 2: Buscador de Leyes BCN - ON DEMAND").
//
// Consulta una ley de la Biblioteca del Congreso Nacional de Chile a demanda,
// una ley a la vez, sin descargar ni indexar la BCN completa.
//
// Reutiliza el cliente HTTP existente (api-base.js + http.js → apiGet con
// credentials: 'include') y los tokens de diseño brand-*. No crea un cliente
// HTTP paralelo ni un sistema de cobros paralelo.
//
// Reglas madre (requerimiento.txt):
//   - Buscar ley es GRATIS (0 créditos): nunca se descuenta saldo ni se pide
//     confirmación de compra.
//   - Caché SOLO puntual y temporal de leyes ya consultadas, con TTL y fecha
//     de consulta. Nunca como descarga masiva de la BCN.
//   - Si la BCN/API falla, avisar con amabilidad. Nunca inventar texto de ley.

import { apiGet } from './http.js';

// Mismo selector de área que el panel chat-legal (10 áreas de derecho).
const AREAS = [
  { value: 'civil', label: 'Civil' },
  { value: 'penal', label: 'Penal' },
  { value: 'laboral', label: 'Laboral' },
  { value: 'familia', label: 'Familia' },
  { value: 'comercial', label: 'Comercial' },
  { value: 'tributario', label: 'Tributario' },
  { value: 'administrativo', label: 'Administrativo' },
  { value: 'constitucional', label: 'Constitucional' },
  { value: 'consumidor', label: 'Consumidor' },
  { value: 'policia_local', label: 'Policía Local' },
];

const STORAGE_PREFIX = 'bcn_law_';
const TTL_MS = 24 * 60 * 60 * 1000; // Caché puntual: 24 horas por ley consultada.
const MSG_ERROR = 'No se pudo consultar la BCN. Inténtalo de nuevo.';
const MSG_EMPTY = 'Ingresa un Nº de ley, un Nº de artículo o una palabra clave y busca.';

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) {
    if (typeof child === 'string') node.appendChild(document.createTextNode(child));
    else if (child instanceof Node) node.appendChild(child);
  }
  return node;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function pick(result, keys) {
  for (const key of keys) {
    const value = result && result[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function cacheKey(ley, articulo) {
  return STORAGE_PREFIX + (ley || '').trim() + (articulo ? '|art=' + String(articulo).trim() : '');
}

function readCache(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (!entry || typeof entry.ts !== 'number') return null;
    if (Date.now() - entry.ts > TTL_MS) return null;
    return entry;
  } catch (_) {
    return null;
  }
}

function writeCache(key, ley, data) {
  try {
    localStorage.setItem(key, JSON.stringify({ ley, data, ts: Date.now(), ttl: TTL_MS }));
  } catch (_) {
    /* Almacenamiento bloqueado o cuota llena: la búsqueda sigue sin caché. */
  }
}

function formatFecha(ts) {
  return new Date(ts).toLocaleString('es-CL', { timeZone: 'America/Santiago' });
}

export function initBcnLaws(container) {
  if (!container) throw new Error('initBcnLaws requires a container');
  if (initBcnLaws.mounted) return; // Idempotente: el panel solo se oculta/muestra.
  initBcnLaws.mounted = true;

  const form = container.querySelector('#bcn-search-form');
  const inputLey = container.querySelector('#bcn-ley');
  const inputArticulo = container.querySelector('#bcn-articulo');
  const inputQ = container.querySelector('#bcn-q');
  const selectArea = container.querySelector('#bcn-area');
  const submit = container.querySelector('#bcn-submit');
  const boxError = container.querySelector('#bcn-error');
  const boxOk = container.querySelector('#bcn-ok');
  const results = container.querySelector('#bcn-results');

  if (!(form && inputLey && inputArticulo && inputQ && selectArea && submit && boxError && boxOk && results)) {
    throw new Error('initBcnLaws: elementos del buscador no encontrados en el contenedor');
  }

  // Área de derecho (misma lista que el chat legal; se muestra en la UI).
  for (const area of AREAS) {
    selectArea.append(new Option(area.label, area.value));
  }

  function showError(message) {
    boxError.textContent = message;
    boxError.classList.remove('hidden');
    boxOk.classList.add('hidden');
    results.replaceChildren();
  }

  function showOk(message) {
    boxOk.textContent = message;
    boxOk.classList.remove('hidden');
    boxError.classList.add('hidden');
  }

  function clearNotices() {
    boxError.classList.add('hidden');
    boxOk.classList.add('hidden');
  }

  function setBusy(busy) {
    submit.disabled = busy;
    submit.textContent = busy ? 'Buscando…' : 'Buscar ley';
  }

  // ----- Renderizado de resultado(s) -----

  function renderCard(data, cachedAt) {
    const card = el('div', { class: 'rounded-2xl border border-slate-200 bg-white p-5 shadow-sm flex flex-col gap-3' });

    const ley = pick(data, ['numero_ley', 'ley', 'numero', 'numeroLey', 'id_ley']);
    const nombre = pick(data, ['nombre', 'nombre_ley', 'titulo', 'title', 'nombreLey']);
    const texto = pick(data, ['texto_vigente', 'texto', 'contenido', 'contenido_vigente']);
    const fecha = pick(data, ['fecha_actualizacion', 'ultima_actualizacion', 'fecha_vigencia', 'updated_at', 'fecha_modificacion']);
    const link = pick(data, ['link_bcn', 'url', 'url_bcn', 'enlace', 'link']);
    const historial = Array.isArray(data.historial) ? data.historial : [];

    const top = el('div', { class: 'flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2' });
    const numero = el('h3', { class: 'text-base font-semibold text-slate-900' });
    numero.textContent = ley ? `Ley Nº ${escapeHtml(String(ley))}` : 'Ley';
    const nombreEl = el('p', { class: 'text-sm text-slate-600' });
    nombreEl.textContent = nombre ? `— ${escapeHtml(String(nombre))}` : '';
    top.append(numero, nombreEl);
    card.appendChild(top);

    if (fecha) {
      const linea = el('p', { class: 'text-xs text-slate-500' });
      linea.textContent = `Última actualización según BCN: ${escapeHtml(String(fecha))}`;
      card.appendChild(linea);
    }

    if (texto !== undefined) {
      const box = el('div', {
        class: 'rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm leading-relaxed text-slate-700 whitespace-pre-wrap break-words max-h-[44vh] overflow-y-auto',
      });
      box.textContent = String(texto);
      const label = el('p', { class: 'mb-1 mt-2 text-xs font-semibold text-slate-700 uppercase tracking-wide' }, ['Texto vigente']);
      card.appendChild(label, box);
    }

    if (link) {
      const enlace = el('a', {
        href: String(link),
        target: '_blank',
        rel: 'noopener noreferrer',
        class: 'text-sm font-medium text-brand-600 underline underline-offset-4 hover:text-brand-700',
      });
      enlace.textContent = 'Ver en la Biblioteca del Congreso Nacional (BCN)';
      card.appendChild(enlace);
    }

    if (historial.length) {
      const histLabel = el('p', { class: 'mt-2 mb-1 text-xs font-semibold text-slate-700 uppercase tracking-wide' }, ['Historial']);
      const list = el('ul', { class: 'text-sm text-slate-600 space-y-1' });
      for (const h of historial) {
        const when = pick(h, ['fecha', 'fecha_actualizacion', 'fecha_cambio', 'fecha_modificacion']) || '';
        const what = pick(h, ['cambio', 'descripcion', 'detalle', 'nota']) || String(h);
        const item = el('li', { class: 'flex gap-1' });
        item.append(
          el('span', { class: 'shrink-0 text-slate-400' }, [when ? escapeHtml(String(when)) + ': ' : '']),
          el('span', {}, [escapeHtml(String(what))])
        );
        list.appendChild(item);
      }
      card.appendChild(histLabel, list);
    }

    if (cachedAt) {
      const aviso = el('p', { class: 'mt-2 text-[10px] text-slate-400' });
      aviso.textContent = `Resultado en caché · Última consulta: ${formatFecha(cachedAt)}`;
      card.appendChild(aviso);
    }

    return card;
  }

  function renderResults(data, cachedAt) {
    results.replaceChildren();
    const items = Array.isArray(data) ? data : [data];
    for (const item of items) {
      results.appendChild(renderCard(item, cachedAt));
    }
  }

  function renderEmpty() {
    results.replaceChildren();
    const aviso = el('p', { class: 'text-sm text-slate-500' });
    aviso.textContent = MSG_EMPTY;
    results.appendChild(aviso);
  }

  // ----- Búsqueda (gratis, 0 créditos) -----

  async function buscar() {
    const ley = (inputLey.value || '').trim();
    const articulo = (inputArticulo.value || '').trim();
    const q = (inputQ.value || '').trim();

    if (!ley && !articulo && !q) {
      showError('Ingresa un Nº de ley, un Nº de artículo o una palabra clave para buscar.');
      return;
    }

    clearNotices();
    results.replaceChildren();
    setBusy(true);

    // Caché puntual de la ley (o consulta) ya consultada, con TTL.
    const key = cacheKey(ley, articulo || q);
    const cached = readCache(key);
    if (cached) {
      setBusy(false);
      renderResults(cached.data, cached.ts);
      showOk('Resultado recuperado de tu caché local.');
      return;
    }

    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (ley) params.set('ley', ley);
    if (articulo) params.set('articulo', articulo);

    try {
      // GET /laws/search con header corazon y credentials: 'include', igual que
      // el resto de llamadas del front (http.js). Sin descuento de créditos.
      const data = await apiGet('/laws/search?' + params.toString(), {
        headers: { 'corazon': 'asistentejudicial' },
      });
      writeCache(key, ley || q, data);
      renderResults(data);
      showOk('Resultado listo.');
    } catch (err) {
      // La API o la BCN fallaron: avisar con amabilidad, nunca inventar texto de ley.
      showError(MSG_ERROR);
    } finally {
      setBusy(false);
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void buscar();
  });

  [inputLey, inputArticulo, inputQ].forEach((input) => {
    input.addEventListener('input', () => clearNotices());
  });

  renderEmpty();

  return {
    destroy() {
      // El panel solo se oculta al cambiar de ruta; el DOM se conserva.
    },
  };
}

initBcnLaws.mounted = false;
