// Seguimiento de causas y plazos procesales — M5 (T-07).
//
// Registra una causa (ROL / RIT / RUC, tribunal, cliente, estado, próxima
// audiencia) y lista las causas con una alerta de plazo cuando la próxima
// audiencia está próxima o vencida.
//
// Reutiliza: http.js (apiGet/apiPost con credentials: 'include'), el header
// `corazon: asistentejudicial`, y los tokens de diseño brand-*. No crea un
// cliente HTTP ni un sistema de navegación paralelo.

import { apiGet, apiPost } from './http.js';

const CORAZON = { 'corazon': 'asistentejudicial' };

const PLAZO_PROXIMO_DIAS = 7;

const ESTADOS = [
  { value: 'activo', label: 'Activo' },
  { value: 'en_tramitacion', label: 'En tramitación' },
  { value: 'suspendido', label: 'Suspendido' },
  { value: 'finalizado', label: 'Finalizado' },
  { value: 'archivado', label: 'Archivado' },
];

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

function noticeBox(kind, message) {
  const box = el('div', {
    class: 'rounded-xl p-4 text-sm ' +
      (kind === 'ok' ? 'border border-emerald-200 bg-emerald-50 text-emerald-900' :
        kind === 'err' ? 'border border-amber-200 bg-amber-50 text-amber-900' :
          'border border-slate-200 bg-slate-50 text-slate-700'),
  });
  box.textContent = message;
  return box;
}

// Fecha en zona horaria de Chile, formato es-CL (solo fecha).
function fechaChile(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('es-CL', {
    timeZone: 'America/Santiago',
    year: 'numeric', month: '2-digit', day: 'numeric',
  }).format(date);
}

function santiagoDateKey(date) {
  const parts = new Intl.DateTimeFormat('es-CL', {
    timeZone: 'America/Santiago',
    year: 'numeric', month: '2-digit', day: 'numeric',
  }).formatToParts(date);
  const pick = (type) => Number(parts.find((p) => p.type === type).value);
  return `${pick('year')}-${String(pick('month')).padStart(2, '0')}-${String(pick('day')).padStart(2, '0')}`;
}

// 'vencido' si ya pasó, 'proximo' si cae en los próximos 7 días, null si no hay alerta.
function plazoEstado(fechaStr) {
  if (!fechaStr) return null;
  const audiencia = new Date(fechaStr);
  if (Number.isNaN(audiencia.getTime())) return null;
  const ahora = new Date();
  const hoyKey = santiagoDateKey(ahora);
  const audienciaKey = santiagoDateKey(audiencia);
  if (audienciaKey < hoyKey) return 'vencido';
  const limite = new Date(ahora);
  limite.setDate(limite.getDate() + PLAZO_PROXIMO_DIAS);
  if (audienciaKey <= santiagoDateKey(limite)) return 'proximo';
  return null;
}

export function initCaseTracking(container) {
  if (!container) throw new Error('initCaseTracking requires a container');

  container.classList.add('flex', 'flex-col', 'gap-4', 'min-h-0');

  const noticeHost = el('div', { class: 'w-full' });
  container.append(noticeHost);

  function showNotice(kind, message) {
    noticeHost.replaceChildren(noticeBox(kind, message));
    setTimeout(() => noticeHost.replaceChildren(), 6000);
  }

  function comprarCreditos() {
    document.dispatchEvent(new CustomEvent('aj:navigate', { detail: { panel: 'wallet' } }));
  }

  function handleError(err) {
    let message = 'No pudimos completar la operación ahora mismo. Inténtalo de nuevo en un momento.';
    if (err.status === 401) {
      message = 'Tu sesión expiró. Inicia sesión nuevamente para continuar, solo toma un momento.';
      showNotice('err', message);
      document.dispatchEvent(new CustomEvent('aj:navigate', { detail: { panel: 'home' } }));
      return;
    }
    if (err.status === 402) {
      showNotice('err', 'No tienes suficientes créditos para registrar esta causa.');
      const btn = el('button', {
        type: 'button',
        class: 'mt-2 inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700',
      }, ['Comprar créditos']);
      btn.addEventListener('click', (e) => { e.stopPropagation(); comprarCreditos(); });
      noticeHost.append(btn);
      return;
    }
    if (err.status === 429) {
      message = 'Has alcanzado el límite de operaciones por ahora. En unos minutos puedes volver a intentarlo.';
    } else if (err.message) {
      message = err.message;
    }
    showNotice('err', message);
  }

  // ----- Formulario: agregar causa -----
  const formHost = el('div', { class: 'rounded-xl border border-slate-200 bg-white p-4 shadow-sm flex flex-col gap-3' });
  formHost.append(el('h2', { class: 'text-base font-semibold text-slate-900' }, ['Registrar causa']));

  const form = el('form', { class: 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3', novalidate: true });
  const inputs = {};

  const field = (key, label, element) => {
    const wrap = el('div', { class: 'flex flex-col gap-1' });
    wrap.append(
      el('label', { class: 'text-xs font-medium text-slate-700' }, [label + ' *']),
      element
    );
    inputs[key] = element;
    form.append(wrap);
  };

  const inputClass = 'rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 placeholder-slate-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-200';

  field('rol', 'ROL', el('input', {
    type: 'text', class: inputClass, placeholder: 'Ej: 1234-2026',
  }));
  field('rit', 'RIT', el('input', {
    type: 'text', class: inputClass, placeholder: 'Ej: RIT-2026-001',
  }));
  field('ruc', 'RUC', el('input', {
    type: 'text', class: inputClass, placeholder: 'Ej: 76.123.456-7',
  }));
  field('tribunal', 'Tribunal', el('input', {
    type: 'text', class: inputClass, placeholder: 'Juzgado de Letras de ...',
  }));
  field('cliente', 'Cliente', el('input', {
    type: 'text', class: inputClass, placeholder: 'Nombre del cliente',
  }));

  const estadoSelect = el('select', { class: inputClass });
  for (const e of ESTADOS) {
    estadoSelect.append(el('option', { value: e.value }, [e.label]));
  }
  field('estado', 'Estado', estadoSelect);

  field('proxima_audiencia', 'Próxima audiencia', el('input', {
    type: 'date', class: inputClass,
  }));

  formHost.append(form);

  const btnWrap = el('div', { class: 'flex justify-end' });
  const btn = el('button', {
    type: 'submit',
    class: 'inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60',
  }, ['Agregar causa']);
  btnWrap.append(btn);
  formHost.append(btnWrap);

  container.append(formHost);

  // ----- Lista de causas -----
  const listHost = el('div', { class: 'min-h-0 flex-1' });
  const emptyState = el('div', { class: 'rounded-xl border border-dashed border-slate-300 bg-white p-12 text-center' });
  emptyState.append(
    el('p', { class: 'text-sm font-medium text-slate-700' }, ['No tienes causas registradas. Agrega tu primera causa.'])
  );

  container.append(el('h2', { class: 'text-base font-semibold text-slate-900' }, ['Tus causas']));
  container.append(listHost);

  let busy = false;

  function casoReferencia(c) {
    return c.rol || c.rit || c.ruc || '—';
  }

  function plazoChip(c) {
    const st = plazoEstado(c.proxima_audiencia);
    if (!st) return null;
    return el('span', {
      class: 'inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-[10px] font-medium text-amber-800',
    }, [st === 'vencido' ? 'Plazo vencido' : 'Plazo próximo']);
  }

  function renderCases(cases) {
    listHost.replaceChildren();
    if (!cases || !cases.length) {
      listHost.append(emptyState);
      return;
    }
    const table = el('table', { class: 'min-w-full divide-y divide-slate-200 text-sm' });
    const thead = el('thead', { class: 'bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500' });
    thead.append(
      el('tr', {}, [
        el('th', { class: 'px-4 py-3 font-medium text-slate-900' }, ['Referencia']),
        el('th', { class: 'px-4 py-3 font-medium text-slate-900' }, ['Tribunal']),
        el('th', { class: 'px-4 py-3 font-medium text-slate-900' }, ['Estado']),
        el('th', { class: 'px-4 py-3 font-medium text-slate-900' }, ['Próxima audiencia']),
        el('th', { class: 'px-4 py-3 font-medium text-slate-900' }, ['Plazo']),
      ])
    );
    table.append(thead);
    const tbody = el('tbody', { class: 'divide-y divide-slate-100' });
    for (const c of cases) {
      const chip = plazoChip(c);
      const acciones = el('td', { class: 'px-4 py-3' });
      if (chip) acciones.append(chip);
      tbody.append(el('tr', {}, [
        el('td', { class: 'px-4 py-3 text-slate-800' }, [casoReferencia(c)]),
        el('td', { class: 'px-4 py-3 text-slate-800' }, [c.tribunal || '—']),
        el('td', { class: 'px-4 py-3 text-slate-800' }, [c.estado || '—']),
        el('td', { class: 'px-4 py-3 text-slate-800' }, [fechaChile(c.proxima_audiencia)]),
        acciones,
      ]));
    }
    table.append(tbody);
    listHost.append(table);
  }

  async function loadCases() {
    try {
      const cases = await apiGet('/cases/list', { headers: CORAZON });
      renderCases(Array.isArray(cases) ? cases : []);
    } catch (err) {
      handleError(err);
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    const tribunal = (inputs.tribunal.value || '').trim();
    if (tribunal === '') {
      showNotice('err', 'El tribunal es obligatorio.');
      return;
    }
    busy = true;
    btn.disabled = true;
    btn.textContent = 'Registrando…';
    noticeHost.replaceChildren();

    try {
      await apiPost('/cases/add', {
        rol: (inputs.rol.value || '').trim(),
        rit: (inputs.rit.value || '').trim(),
        ruc: (inputs.ruc.value || '').trim(),
        tribunal,
        cliente_id: (inputs.cliente.value || '').trim(),
        estado: inputs.estado.value,
        proxima_audiencia: inputs.proxima_audiencia.value || null,
      }, CORAZON);
      showNotice('ok', 'Causa registrada.');
      form.reset();
      await loadCases();
    } catch (err) {
      handleError(err);
    } finally {
      busy = false;
      btn.disabled = false;
      btn.textContent = 'Agregar causa';
    }
  });

  loadCases();
}
