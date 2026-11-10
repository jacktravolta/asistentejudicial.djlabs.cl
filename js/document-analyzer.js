// Document analyzer — M4 / T-06 (hash route #/analizador).
//
// Upload panel: pick a PDF / DOCX / JPG / PNG (max 10 MB), confirm the 4-credit
// cost, POST to /documents/analyze and show the extracted fields plus any
// detection warnings (plazos vencidos, artículos mal citados, errores formales).
//
// Reuses api-base.js (apiUrl), auth.js (fetchMe) and the confirm-cost modal
// pattern from escritos.js. Every API call uses credentials: 'include' and the
// 'corazon: asistentejudicial' header. One POST per file (no parallel upload
// system). Code in English, UI copy in Spanish.

import { apiUrl } from './api-base.js';
import { fetchMe } from './auth.js';

const COST_CREDITS = 4;
const MAX_BYTES = 10 * 1024 * 1024;

const FIELDS = [
  { key: 'partes', label: 'Partes' },
  { key: 'tribunal', label: 'Tribunal' },
  { key: 'rol', label: 'Rol / Nº de causa' },
  { key: 'fechas', label: 'Fechas' },
  { key: 'plazos', label: 'Plazos' },
  { key: 'pretensiones', label: 'Pretensiones' },
  { key: 'argumentos', label: 'Argumentos' },
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

function cr(n) {
  return `${n} crédito${n === 1 ? '' : 's'}`;
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

function confirmModal({ title, message, confirmLabel, cancelLabel }) {
  return new Promise((resolve) => {
    const overlay = el('div', { class: 'fixed inset-0 z-50 hidden items-center justify-center bg-slate-900/40 p-4' });
    const box = el('div', { class: 'mx-4 w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-xl' });
    box.append(
      el('h3', { class: 'text-base font-semibold text-slate-900' }, [title]),
      el('p', { class: 'mt-3 text-sm leading-relaxed text-slate-600' }, [message])
    );
    const actions = el('div', { class: 'mt-5 flex justify-end gap-2' });
    const cancelBtn = el('button', {
      type: 'button',
      class: 'rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-400',
    }, [cancelLabel || 'Cancelar']);
    const okBtn = el('button', {
      type: 'button',
      class: 'rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700',
    }, [confirmLabel || 'Continuar']);
    actions.append(cancelBtn, okBtn);
    box.append(actions);
    overlay.append(box);
    document.body.append(overlay);
    requestAnimationFrame(() => { overlay.classList.remove('hidden'); overlay.classList.add('flex'); });
    const done = (val) => { overlay.remove(); resolve(val); };
    cancelBtn.onclick = () => done(false);
    okBtn.onclick = () => done(true);
  });
}

function validateFile(file) {
  if (!file) return null;
  if (file.size > MAX_BYTES) {
    return new Error('El archivo pesa más de 10 MB. Elige uno más liviano: el tamaño máximo es 10 MB.');
  }
  const allowed = {
    'application/pdf': true,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': true,
    'image/jpeg': true,
    'image/png': true,
  };
  if (!allowed[file.type]) {
    return new Error('Tipo de archivo no soportado. Sube un PDF, Word (.docx) o imagen (JPG/PNG).');
  }
  return null;
}

export function initDocumentAnalyzer(container) {
  if (!container) throw new Error('initDocumentAnalyzer requires a container');

  let balance = null;
  let file = null;
  let busy = false;

  const uploadHost = container.querySelector('#da-upload') || container;
  const resultsHost = container.querySelector('#da-results');
  const errorHost = container.querySelector('#da-error');
  const okHost = container.querySelector('#da-ok');

  function showNotice(kind, message) {
    const host = kind === 'ok' ? okHost : errorHost;
    if (!host) return;
    host.replaceChildren();
    host.textContent = message;
    host.classList.remove('hidden');
    setTimeout(() => host.classList.add('hidden'), 6000);
  }

  function comprarCreditos() {
    document.dispatchEvent(new CustomEvent('aj:navigate', { detail: { panel: 'wallet' } }));
  }

  function handleError(err) {
    let message = 'No pudimos analizar el documento ahora mismo. No se te cobró nada: inténtalo de nuevo en un momento.';
    if (err.status === 401) {
      message = 'Tu sesión expiró. Inicia sesión nuevamente para continuar.';
      showNotice('err', message);
      document.dispatchEvent(new CustomEvent('aj:navigate', { detail: { panel: 'home' } }));
      return;
    }
    if (err.status === 402) {
      errorHost.replaceChildren();
      errorHost.appendChild(noticeBox('err', 'No tienes suficientes créditos para este análisis.'));
      const btn = el('button', {
        type: 'button',
        class: 'mt-2 inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700',
      }, ['Comprar créditos']);
      btn.addEventListener('click', (e) => { e.stopPropagation(); comprarCreditos(); });
      errorHost.appendChild(btn);
      errorHost.classList.remove('hidden');
      return;
    }
    if (err.status === 429) {
      message = 'Has alcanzado el límite de operaciones por ahora. En unos minutos puedes volver a intentarlo.';
    } else if (err.message) {
      message = err.message;
    }
    showNotice('err', message);
  }

  // ----- Build upload UI -----

  uploadHost.replaceChildren();
  uploadHost.className = 'rounded-2xl border border-slate-200 bg-white p-6 shadow-sm flex flex-col gap-4';

  const hint = el('p', { class: 'text-sm text-slate-500' }, [
    'Formatos aceptados: PDF, Word (.docx), JPG y PNG. Tamaño máximo: 10 MB.'
  ]);
  uploadHost.append(hint);

  const drop = el('div', {
    class: 'flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 p-8 text-center hover:border-brand-400 hover:bg-brand-50 transition cursor-pointer',
    role: 'button',
    tabindex: '0',
    'aria-label': 'Seleccionar documento para analizar',
  });
  const icon = el('svg', {
    class: 'h-8 w-8 text-slate-400',
    xmlns: 'http://www.w3.org/2000/svg',
    fill: 'none',
    viewBox: '0 0 24 24',
    stroke: 'currentColor',
    'aria-hidden': 'true',
  }, [
    el('path', { 'stroke-linecap': 'round', 'stroke-linejoin': 'round', d: 'M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4' }),
  ]);
  const label = el('p', { class: 'text-sm font-medium text-slate-700' }, ['Haz clic para seleccionar un documento o arrástralo aquí']);
  const types = el('p', { class: 'text-xs text-slate-500' }, ['PDF · DOCX · JPG · PNG · hasta 10 MB']);
  drop.append(icon, label, types);
  uploadHost.append(drop);

  const fileInput = el('input', {
    id: 'da-file-input',
    type: 'file',
    accept: '.pdf,.docx,.jpg,.jpeg,.png',
    class: 'sr-only',
  });
  uploadHost.append(fileInput);

  const fileInfo = el('div', {
    class: 'flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 hidden',
  });
  const fileName = el('span', { id: 'da-file-name', class: 'truncate text-sm text-slate-700' }, ['']);
  const fileSize = el('span', { id: 'da-file-size', class: 'text-xs text-slate-500' }, ['']);
  const changeBtn = el('button', {
    type: 'button',
    class: 'ml-auto text-xs font-medium text-brand-600 hover:underline',
  }, ['Cambiar archivo']);
  changeBtn.addEventListener('click', () => fileInput.click());
  fileInfo.append(fileName, fileSize, changeBtn);
  uploadHost.append(fileInfo);

  const analyzeBtn = el('button', {
    id: 'da-analyze-btn',
    type: 'button',
    class: 'inline-flex items-center justify-center gap-2 rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700 disabled:opacity-60 disabled:cursor-not-allowed',
    disabled: true,
  }, ['Analizar documento']);
  uploadHost.append(analyzeBtn);

  function updateFileInfo(f) {
    fileName.textContent = f.name;
    fileSize.textContent = (f.size / 1024 / 1024).toFixed(2) + ' MB';
    fileInfo.classList.remove('hidden');
    analyzeBtn.disabled = false;
  }

  function clearFile() {
    file = null;
    fileInput.value = '';
    fileInfo.classList.add('hidden');
    analyzeBtn.disabled = true;
    analyzeBtn.textContent = 'Analizar documento';
    resultsHost.classList.add('hidden');
  }

  // ----- Wire upload interactions -----

  drop.addEventListener('click', () => fileInput.click());
  ['dragenter', 'dragover'].forEach((name) => {
    drop.addEventListener(name, (ev) => { ev.preventDefault(); drop.classList.add('border-brand-400', 'bg-brand-50'); });
  });
  ['dragleave', 'drop'].forEach((name) => {
    drop.addEventListener(name, (ev) => { ev.preventDefault(); drop.classList.remove('border-brand-400', 'bg-brand-50'); });
  });
  drop.addEventListener('drop', (ev) => {
    const f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
    if (!f) return;
    const err = validateFile(f);
    if (err) { showNotice('err', err.message); return; }
    file = f;
    const dt = new DataTransfer();
    dt.items.add(f);
    fileInput.files = dt.files;
    updateFileInfo(f);
    resultsHost.classList.add('hidden');
  });

  fileInput.addEventListener('change', () => {
    const f = fileInput.files && fileInput.files[0];
    if (!f) return;
    const err = validateFile(f);
    if (err) {
      showNotice('err', err.message);
      clearFile();
      return;
    }
    file = f;
    updateFileInfo(f);
    resultsHost.classList.add('hidden');
  });

  // ----- Analyze -----

  async function analyze() {
    if (!file) { showNotice('err', 'Selecciona un archivo antes de analizar.'); return; }
    if (busy) return;

    let bal = balance;
    if (bal === null) {
      try {
        const session = await fetchMe();
        bal = session && typeof session.balance === 'number' ? session.balance : null;
        balance = bal;
      } catch (_) { bal = null; }
    }

    if (bal === null || bal < COST_CREDITS) {
      errorHost.replaceChildren();
      errorHost.appendChild(noticeBox('err', 'No tienes suficientes créditos para este análisis.'));
      const btn = el('button', {
        type: 'button',
        class: 'mt-2 inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700',
      }, ['Comprar créditos']);
      btn.addEventListener('click', (e) => { e.stopPropagation(); comprarCreditos(); });
      errorHost.appendChild(btn);
      errorHost.classList.remove('hidden');
      return;
    }

    const ok = await confirmModal({
      title: '¿Analizar este documento?',
      message: `Esta acción costará ${cr(COST_CREDITS)}. Tienes ${cr(bal)}. ¿Continuar?`,
      confirmLabel: 'Sí, analizar',
      cancelLabel: 'No, cancelar',
    });
    if (!ok) return;

    busy = true;
    analyzeBtn.disabled = true;
    analyzeBtn.textContent = 'Analizando…';
    resultsHost.classList.add('hidden');
    errorHost.classList.add('hidden');

    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('filename', file.name);
      formData.append('content_type', file.type);

      const response = await fetch(apiUrl('/documents/analyze'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'corazon': 'asistentejudicial' },
        body: formData,
      });

      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error('No pudimos interpretar la respuesta del servidor. Inténtalo nuevamente.');
      }

      if (response.status === 401) {
        const err = new Error('Sesión no disponible.');
        err.status = 401;
        throw err;
      }

      if (!response.ok || !(payload && payload.success === true)) {
        const message = payload && payload.error && payload.error.message
          ? payload.error.message
          : 'No pudimos analizar el documento en este momento. Inténtalo nuevamente.';
        const err = new Error(message);
        err.status = response.status;
        err.code = payload && payload.error ? payload.error.code : undefined;
        throw err;
      }

      const data = payload && payload.data ? payload.data : {};
      if (typeof data.credits_remaining === 'number') {
        balance = data.credits_remaining;
        window.dispatchEvent(new CustomEvent('aj:balance-changed'));
      } else if (typeof bal === 'number') {
        balance = bal - COST_CREDITS;
        window.dispatchEvent(new CustomEvent('aj:balance-changed'));
      }

      renderResults(data);
      showNotice('ok', 'Documento analizado. Revisa los campos extraídos antes de usarlos.');
    } catch (err) {
      handleError(err);
    } finally {
      busy = false;
      analyzeBtn.disabled = false;
      analyzeBtn.textContent = 'Analizar documento';
    }
  }

  analyzeBtn.addEventListener('click', analyze);

  // ----- Results rendering -----

  function renderResults(data) {
    resultsHost.replaceChildren();
    resultsHost.classList.remove('hidden');

    const card = el('div', { class: 'rounded-2xl border border-slate-200 bg-white p-5 shadow-sm' });
    card.append(el('h2', { class: 'text-base font-semibold text-slate-900 mb-3' }, ['Resultado del análisis']));

    const grid = el('div', { class: 'grid gap-3' });
    for (const f of FIELDS) {
      const value = data[f.key];
      const text = Array.isArray(value) ? value.join(', ') : (value === null || value === undefined || value === '' ? '—' : String(value));
      const row = el('div', { class: 'flex items-start gap-3 px-3 py-2.5 rounded-xl border border-slate-200 bg-slate-50' });
      row.append(
        el('span', { class: 'shrink-0 w-20 text-xs font-medium text-slate-500' }, [f.label + ':']),
        el('span', { class: 'min-w-0 text-sm text-slate-700 leading-relaxed' }, [text])
      );
      grid.append(row);
    }
    card.append(grid);
    resultsHost.append(card);

    const warnings = data.warnings || data.detecciones || [];
    if (warnings.length) {
      const warnCard = el('div', { class: 'mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4' });
      warnCard.append(
        el('h3', { class: 'text-sm font-semibold text-amber-900 mb-2 flex items-center gap-1.5' }, [
          el('svg', {
            class: 'h-4 w-4 shrink-0', fill: 'none', viewBox: '0 0 24 24', stroke: 'currentColor', 'stroke-width': '1.8', 'aria-hidden': 'true',
          }, [
            el('path', { 'stroke-linecap': 'round', 'stroke-linejoin': 'round', d: 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z' }),
          ]),
          ['Revisa estos puntos'],
        ])
      );
      const list = el('ul', { class: 'space-y-1 text-sm text-amber-800' });
      for (const w of warnings) {
        const item = el('li', { class: 'flex items-start gap-1.5' });
        item.append(
          el('span', { class: 'shrink-0 mt-0.5', 'aria-hidden': 'true' }, ['⚠']),
          el('span', {}, [typeof w === 'string' ? w : (w.message || w.tipo || String(w))])
        );
        list.append(item);
      }
      warnCard.append(list);
      resultsHost.append(warnCard);
    }

    resultsHost.append(el('p', { class: 'mt-4 text-xs text-slate-500' }, [
      'Este resultado es un borrador generado con asistencia de IA. Revisa siempre los datos antes de usarlos y consulta a un profesional si tu caso lo requiere.'
    ]));
  }
}
