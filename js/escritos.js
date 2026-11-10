// Redactor de escritos y documentos — Module 3 (T-04).
//
// Genera borradores de escritos judiciales a partir de plantillas
// (demanda civil, querella, recurso de protección). Cada escrito cuesta 5
// créditos y se confirma el costo antes de enviar.
//
// Reutiliza: http.js (apiPost con credentials: 'include'), auth.js
// (fetchMe para el saldo), chat-editor.js (window.ChatEditor, IIFE) para
// editar y descargar, y los tokens de diseño brand-*. No crea un cliente
// HTTP ni un sistema de edición paralelo.

import { apiPost, uuidV4 } from './http.js';
import { fetchMe } from './auth.js';

const COST_CREDITS = 5;

// Slice 1: las tres plantillas del requerimiento. Las siguientes se añaden
// en una rebanada posterior sin tocar el resto del módulo.
const TEMPLATES = [
  {
    id: 'demanda-civil', nombre: 'Demanda civil', area: 'civil',
    descripcion: 'Inicia un juicio civil: pensión de alimentos, cobro de sumas de dinero u otras reclamaciones civiles.',
    fields: [
      { key: 'partes', label: 'Partes', ph: 'Demandante y demandado (nombres y roles)' },
      { key: 'rut', label: 'RUT del solicitante', ph: 'Ej: 12.345.678-5' },
      { key: 'hechos', label: 'Hechos', ph: 'Relata los hechos de forma clara y cronológica.', rows: 6 },
      { key: 'petitorio', label: 'Petitorio', ph: '¿Qué solicitas al tribunal?', rows: 4 },
    ],
  },
  {
    id: 'querella', nombre: 'Querella', area: 'penal',
    descripcion: 'Escrito penal para presentar una querella ante un tribunal, dando inicio a una investigación.',
    fields: [
      { key: 'partes', label: 'Partes', ph: 'Querellante y querellado (nombres y roles)' },
      { key: 'rut', label: 'RUT del querellante', ph: 'Ej: 12.345.678-5' },
      { key: 'hechos', label: 'Hechos (relato del delito)', ph: 'Describe los hechos que constituyen el delito.', rows: 6 },
      { key: 'petitorio', label: 'Petitorio', ph: '¿Qué solicitas al tribunal (penalización, reparación)?', rows: 4 },
    ],
  },
  {
    id: 'recurso-proteccion', nombre: 'Recurso de protección', area: 'constitucional',
    descripcion: 'Acción constitucional para proteger garantías vulneradas por un acto ilegal u arbitrario.',
    fields: [
      { key: 'partes', label: 'Partes', ph: 'Recurrente y recurrido (nombres y roles)' },
      { key: 'rut', label: 'RUT del recurrente', ph: 'Ej: 12.345.678-5' },
      { key: 'hechos', label: 'Hechos y garantía vulnerada', ph: 'Describe el acto ilegal u arbitrario y el derecho vulnerado.', rows: 6 },
      { key: 'petitorio', label: 'Petitorio', ph: '¿Qué solicitas al tribunal (restablecer el derecho)?', rows: 4 },
    ],
  },
];

const TONES = [
  { value: 'cliente', label: 'Para cliente (lenguaje sencillo)' },
  { value: 'abogado', label: 'Para abogado (lenguaje técnico)' },
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

export function initEscritos(container) {
  if (!container) throw new Error('initEscritos requires a container');

  container.classList.add(
    'flex', 'flex-col', 'h-full', 'min-h-0', 'overflow-hidden',
    'rounded-3xl', 'border', 'border-slate-200/80', 'bg-white', 'shadow-sm'
  );

  const listHost = container.querySelector('#escritos-list') || container;
  const formHost = container.querySelector('#escritos-form');
  const outputHost = container.querySelector('#escritos-output');

  let balance = null;
  const state = { busy: false, template: null, area: 'civil', tone: 'cliente' };

  // ----- Cabecera: título + saldo + selectores -----
  const header = el('div', { class: 'mx-auto flex w-full max-w-3xl items-center justify-between gap-3 px-4 pb-1 pt-3' });

  const titleBox = el('div', { class: 'min-w-0' });
  const title = el('p', { class: 'truncate text-sm font-semibold text-slate-800' });
  title.textContent = 'Redactor de escritos';
  titleBox.append(title);

  header.append(titleBox);

  // ----- Área de avisos -----
  const noticeHost = el('div', { class: 'mx-auto w-full max-w-3xl px-4' });

  function showNotice(kind, message) {
    noticeHost.replaceChildren(noticeBox(kind, message));
    setTimeout(() => noticeHost.replaceChildren(), 6000);
  }

  function comprarCreditos() {
    document.dispatchEvent(new CustomEvent('aj:navigate', { detail: { panel: 'wallet' } }));
  }

  function handleError(err) {
    let message = 'No pudimos generar el escrito ahora mismo. No se te cobró nada: inténtalo de nuevo en un momento.';
    if (err.status === 401) {
      message = 'Tu sesión expiró. Inicia sesión nuevamente para continuar, solo toma un momento.';
      showNotice('err', message);
      document.dispatchEvent(new CustomEvent('aj:navigate', { detail: { panel: 'home' } }));
      return;
    }
    if (err.status === 402) {
      showNotice('err', 'No tienes suficientes créditos para este escrito.');
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

  // ----- Lista de plantillas -----
  const list = el('div', { class: 'mx-auto w-full max-w-3xl grid gap-2 px-4 pb-3' });

  function renderList() {
    list.replaceChildren();
    for (const tpl of TEMPLATES) {
      const card = el('article', {
        class: 'rounded-xl border border-slate-200 bg-white p-4 cursor-pointer transition hover:border-brand-300 hover:shadow-sm',
        'aria-label': 'Seleccionar ' + tpl.nombre,
      });
      card.append(
        el('h3', { class: 'text-sm font-semibold text-slate-900' }, [tpl.nombre]),
        el('p', { class: 'mt-1 text-xs text-slate-600 leading-relaxed' }, [tpl.descripcion]),
        el('p', { class: 'mt-2 text-[10px] font-medium text-brand-700' }, [`Costo: ${cr(COST_CREDITS)} por escrito`])
      );
      card.addEventListener('click', () => selectTemplate(tpl));
      list.append(card);
    }
  }

  function selectTemplate(tpl) {
    state.template = tpl;
    state.area = tpl.area;
    renderForm();
    outputHost.replaceChildren();
    showNotice('ok', `Plantilla seleccionada: ${tpl.nombre}. Completa los campos y redacta.`);
  }

  // ----- Formulario -----
  function renderForm() {
    formHost.replaceChildren();
    const tpl = state.template;
    if (!tpl) return;

    const form = el('form', { class: 'rounded-xl border border-slate-200 bg-white p-4 shadow-sm flex flex-col gap-3', novalidate: true });
    const intro = el('p', { class: 'text-xs text-slate-500' });
    intro.textContent = `Completa los campos para tu ${tpl.nombre}. Los datos que faltan quedan marcados para que los revises antes de usar el borrador.`;
    form.append(intro);

    const fieldsWrap = el('div', { class: 'grid gap-3' });
    const inputs = {};
    for (const field of tpl.fields) {
      const input = field.rows
        ? el('textarea', {
          rows: field.rows,
          class: 'rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 placeholder-slate-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-200',
          placeholder: field.ph,
        })
        : el('input', {
          type: 'text',
          class: 'rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 placeholder-slate-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-200',
          placeholder: field.ph,
        });
      const label = el('label', { class: 'flex flex-col gap-1' });
      label.append(
        el('span', { class: 'text-xs font-medium text-slate-700' }, [field.label + ' *']),
        input
      );
      inputs[field.key] = input;
      fieldsWrap.append(label);
    }
    form.append(fieldsWrap);

    const costRow = el('div', { class: 'flex items-center justify-between pt-2 border-t border-slate-100' });
    costRow.append(
      el('span', { class: 'text-xs font-semibold text-slate-700' }, [`Costo: ${cr(COST_CREDITS)}`]),
      el('span', { class: 'text-xs text-slate-500' }, ['Se confirma antes de enviar'])
    );
    form.append(costRow);

    const btnWrap = el('div', { class: 'mt-2 flex justify-end' });
    const btn = el('button', {
      type: 'submit',
      class: 'inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60',
    }, ['Redactar escrito']);
    btnWrap.append(btn);
    form.append(btnWrap);

    formHost.append(form);

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (state.busy) return;
      const values = {};
      let incomplete = false;
      for (const field of tpl.fields) {
        const v = (inputs[field.key].value || '').trim();
        values[field.key] = v;
        if (v === '') incomplete = true;
      }
      if (incomplete) {
        showNotice('err', 'Completa todos los campos (marcados con *) antes de redactar.');
        return;
      }

      let bal = balance;
      if (bal === null) {
        try {
          const session = await fetchMe();
          bal = session && typeof session.balance === 'number' ? session.balance : null;
          balance = bal;
        } catch (_) { bal = null; }
      }

      if (bal === null || bal <= 0) {
        showNotice('err', 'No tienes suficientes créditos para este escrito.');
        const btn2 = el('button', {
          type: 'button',
          class: 'mt-2 inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700',
        }, ['Comprar créditos']);
        btn2.addEventListener('click', (e) => { e.stopPropagation(); comprarCreditos(); });
        noticeHost.append(btn2);
        return;
      }

      const ok = await confirmModal({
        title: '¿Redactar este escrito?',
        message: `Esta acción costará ${cr(COST_CREDITS)}. Tienes ${cr(bal)}. ¿Continuar?`,
        confirmLabel: 'Sí, redactar',
        cancelLabel: 'No, cancelar',
      });
      if (!ok) return;

      await redactar(values);
    });
  }

  async function redactar(values) {
    state.busy = true;
    const btn = formHost.querySelector('button[type=submit]');
    if (btn) { btn.disabled = true; btn.textContent = 'Redactando…'; }
    noticeHost.replaceChildren();

    try {
      const data = await apiPost('/documents/generate', {
        templateId: state.template.id,
        partes: values.partes,
        rut: values.rut,
        hechos: values.hechos,
        petitorio: values.petitorio,
        area: state.area,
        tone: state.tone,
      }, { 'corazon': 'asistentejudicial' });

      if (typeof data.credits_remaining === 'number') {
        balance = data.credits_remaining;
        window.dispatchEvent(new CustomEvent('aj:balance-changed'));
      }

      const text = data.document || data.text || data.contenido || '';
      outputHost.replaceChildren();
      const ok = el('p', { class: 'rounded-xl p-3 border border-emerald-200 bg-emerald-50 text-emerald-900 text-sm' });
      ok.textContent = 'Escrito generado. Revisa y edita el borrador antes de usarlo: es solo una ayuda, no sustituye a un abogado.';
      outputHost.append(ok);

      // Botones de exportación junto al resultado (DOCX / PDF).
      const exportRow = el('div', { class: 'flex flex-wrap gap-2 mt-3' });
      const btnDocx = el('button', {
        type: 'button',
        class: 'inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-brand-300 hover:bg-brand-50',
      }, ['Exportar DOCX']);
      const btnPdf = el('button', {
        type: 'button',
        class: 'inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-brand-300 hover:bg-brand-50',
      }, ['Exportar PDF']);
      btnDocx.onclick = () => exportarDocumento({ html: documentHtml(text), format: 'docx', templateId: state.template.id });
      btnPdf.onclick = () => exportarDocumento({ html: documentHtml(text), format: 'pdf', templateId: state.template.id });
      exportRow.append(btnDocx, btnPdf);
      outputHost.append(exportRow);

      // Editor para editar y descargar (reuse ChatEditor, IIFE -> window.ChatEditor).
      import(new URL('./chat-editor.js?v=' + Date.now(), import.meta.url).href)
        .then(() => {
          const Editor = window.ChatEditor;
          if (!Editor || typeof Editor.open !== 'function') {
            throw new Error('ChatEditor no disponible');
          }
          Editor.open(text, undefined, async (format, { html, text: contenido }) => {
            try {
              await apiPost('/documents/download', { html, text: contenido, format }, { 'corazon': 'asistentejudicial' });
              showNotice('ok', 'Documento descargado.');
            } catch (downloadErr) { handleError(downloadErr); }
          });
        })
        .catch(() => {
          showNotice('err', 'No pudimos abrir el editor de texto. El borrador se generó correctamente.');
        });

      showNotice('ok', 'Escrito generado.');
    } catch (err) {
      handleError(err);
    } finally {
      state.busy = false;
      if (btn) { btn.disabled = false; btn.textContent = 'Redactar escrito'; }
    }
  }

  // ----- Exportación DOCX / PDF (T-05) -----
  // Reutiliza http.js (apiPost, uuidV4) y el endpoint /documents/download.
  // El pie legal es obligatorio en cada exportación (AGENTS.md).

  function fechaChile() {
    return new Date().toLocaleString('es-CL', {
      timeZone: 'America/Santiago',
      year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  }

  function legalFooterHtml(fecha) {
    return (
      '<hr style="border:none;border-top:1px solid #cbd5e1;margin:18px 0 8px 0;">' +
      '<p style="font-size:11.5px;line-height:1.5;color:#475569;text-align:center;">' +
      'Borrador generado con asistencia de IA el ' + fecha +
      '. No constituye asesoría legal ni garantiza resultado judicial. ' +
      'Requiere revisión humana.' +
      '</p>'
    );
  }

  function documentHtml(text) {
    if (/<[a-z][\s\S]*>/i.test(text || '')) return text;
    return (text || '').split(/\n\s*\n/).map(p => '<p>' + p.trim() + '</p>').join('');
  }

  async function exportarDocumento({ html, format, templateId }) {
    const htmlConPie = html + legalFooterHtml(fechaChile());
    const operationId = uuidV4();
    try {
      const data = await apiPost('/documents/download', {
        format,
        html: htmlConPie,
        operationId,
        templateId,
        heart: 'asistentejudicial',
        quote: true
      }, { 'corazon': 'asistentejudicial' });

      const blobBase64 = data && data.blob_base64;
      const filename = (data && data.filename) || ('documento.' + format);
      if (blobBase64) {
        const bin = atob(blobBase64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
        if (typeof data.new_balance === 'number') {
          balance = data.new_balance;
          window.dispatchEvent(new CustomEvent('aj:balance-changed'));
        }
        showNotice('ok', 'Descarga iniciada: ' + filename);
      } else {
        showNotice('ok', 'Documento listo.');
      }
    } catch (err) {
      handleError(err);
    }
  }

  renderList();
  renderForm();
}
