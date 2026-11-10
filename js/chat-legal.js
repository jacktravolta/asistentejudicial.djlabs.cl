// Chat legal inteligente — Module 1 (requerimiento.txt).
//
// Panel propio del chat con asistencia de IA jurídica. Incluye:
//   - selectores de área de derecho y tono de respuesta,
//   - confirmación de costo antes del primer mensaje cuando el saldo está bajo,
//   - manejo empático de errores 401 / 402 / 429,
//   - citas de fuentes (ley, artículo, inciso, link a BCN, vigencia,
//     norma derogada/modificada),
//   - actualización del saldo tras cada respuesta.
//
// Reutiliza: typewrite() (efecto de escritura), http.js (apiPost con
// credentials: 'include'), auth.js (fetchMe para el saldo inicial) y los
// tokens de diseño brand-*. No crea un cliente HTTP ni un sistema de auth
// paralelo: todas las llamadas a la API pasan por http.js y el header
// 'corazon' viaja en cada llamada que toca créditos/LLM.

import { typewrite } from './chat-typewriter.js?v=2';
import { apiPost } from './http.js';
import { apiUrl } from './api-base.js';
import { fetchMe } from './auth.js';

// ---------------------------------------------------------------------------
// Datos de los selectores
// ---------------------------------------------------------------------------

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

const TONES = [
  { value: 'cliente', label: 'Para cliente (lenguaje sencillo)' },
  { value: 'abogado', label: 'Para abogado (lenguaje técnico)' },
];

// Umbral de saldo bajo por el que se pide confirmar antes del primer mensaje.
const LOW_CREDITS = 5;
const CONV_STORAGE_KEY = 'chat_legal_conversation_id';

// ---------------------------------------------------------------------------
// Helpers del DOM (mismo patrón que chat-widget.js)
// ---------------------------------------------------------------------------

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

function mdInline(escaped) {
  let s = escaped;
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]*)\)/g, (m, t, u) =>
    '<a href="' + u + '" target="_blank" rel="noopener noreferrer" ' +
    'style="color:#2563eb;text-decoration:underline;">' + t + '</a>');
  s = s.replace(/(^|[\s(])((?:https?:\/\/)[^\s<)"']+)/g, (m, pre, u) =>
    pre + '<a href="' + u + '" target="_blank" rel="noopener noreferrer" ' +
    'style="color:#2563eb;text-decoration:underline;word-break:break-all;">' + u + '</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,;:!?)~]|$)/g, '$1<em>$2</em>');
  s = s.replace(/`([^`\n]+)`/g, '<code style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#e2e8f0;border-radius:4px;padding:1px 5px;font-size:12px;">$1</code>');
  return s;
}

function renderMarkdown(raw) {
  const lines = String(raw ?? '').split(/\r?\n/);
  const out = [];
  let list = null;
  let para = null;
  const closeList = () => { if (list) { out.push('</' + list + '>'); list = null; } };
  const closePara = () => { if (para !== null) { out.push('<p style="margin:0 0 6px;">' + para + '</p>'); para = null; } };
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') { closePara(); closeList(); continue; }
    const heading = trimmed.match(/^#{1,4}\s+(.*)$/);
    const bullet = trimmed.match(/^[-•]\s+(.*)$/);
    const ordered = trimmed.match(/^(\d{1,2})[.)]\s+(.*)$/);
    if (heading) {
      closePara(); closeList();
      out.push('<p style="margin:10px 0 4px;font-weight:700;font-size:14px;color:#0f172a;">' +
        mdInline(escapeHtml(heading[1])) + '</p>');
      continue;
    }
    if (bullet || ordered) {
      closePara();
      const kind = bullet ? 'ul' : 'ol';
      if (list !== kind) { closeList(); out.push('<' + kind + ' style="margin:4px 0 6px;padding-left:18px;">'); list = kind; }
      out.push('<li style="margin:2px 0;">' + mdInline(escapeHtml(bullet ? bullet[1] : ordered[2])) + '</li>');
      continue;
    }
    closeList();
    const seg = mdInline(escapeHtml(trimmed));
    para = para === null ? seg : para + '<br>' + seg;
  }
  closePara(); closeList();
  return out.join('');
}

function cr(n) {
  return `${n} crédito${n === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------------------
// Modales ligeros
// ---------------------------------------------------------------------------

function confirmModal({ title, message, confirmLabel, cancelLabel }) {
  return new Promise((resolve) => {
    const overlay = el('div', {
      class: 'fixed inset-0 z-50 hidden items-center justify-center bg-slate-900/40 p-4',
    });
    const box = el('div', {
      class: 'mx-4 w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-xl',
    });
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
    overlay.onclick = (e) => { if (e.target === overlay) done(false); };
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

// ---------------------------------------------------------------------------
// Módulo
// ---------------------------------------------------------------------------

export function initChatLegal(container) {
  if (!container) throw new Error('initChatLegal requires a container');

  container.classList.add(
    'chat-legal', 'flex', 'flex-col', 'h-full', 'min-h-0', 'overflow-hidden',
    'rounded-3xl', 'border', 'border-slate-200/80', 'bg-white', 'shadow-sm'
  );

  let conversationId = null;
  try { conversationId = sessionStorage.getItem(CONV_STORAGE_KEY) || null; } catch (_) {}
  let balance = null;
  let firstMessage = true;
  const state = { busy: false, area: 'civil', tone: 'cliente' };

  // ----- Cabecera: título + saldo + selectores -----
  const header = el('div', { class: 'mx-auto flex w-full max-w-3xl items-center justify-between gap-3 px-4 pb-1 pt-3' });

  const titleBox = el('div', { class: 'min-w-0' });
  const title = el('p', { class: 'truncate text-sm font-semibold text-slate-800' });
  title.textContent = 'Asistente legal';
  const subtitle = el('p', { class: 'truncate text-xs text-slate-500' });
  subtitle.textContent = 'Respuestas con asistencia de IA. Revisa siempre con un profesional.';
  titleBox.append(title, subtitle);

  const balanceBadge = el('span', {
    class: 'hidden shrink-0 rounded-full border border-brand-100 bg-brand-50 px-3 py-1 text-xs font-medium text-brand-700',
  });
  balanceBadge.textContent = '— créditos';

  const selectors = el('div', { class: 'flex flex-wrap items-center gap-2' });

  const areaSelect = el('select', {
    class: 'rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500',
    'aria-label': 'Área de derecho',
  });
  for (const area of AREAS) {
    areaSelect.append(new Option(area.label, area.value));
  }
  areaSelect.value = state.area;
  areaSelect.addEventListener('change', (e) => { state.area = e.target.value; });

  const toneSelect = el('select', {
    class: 'rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500',
    'aria-label': 'Tono de respuesta',
  });
  for (const tone of TONES) {
    toneSelect.append(new Option(tone.label, tone.value));
  }
  toneSelect.value = state.tone;
  toneSelect.addEventListener('change', (e) => { state.tone = e.target.value; });

  selectors.append(
    el('span', { class: 'text-[10px] uppercase tracking-wider text-slate-400 shrink-0' }, ['Área']),
    areaSelect,
    el('span', { class: 'text-[10px] uppercase tracking-wider text-slate-400 shrink-0' }, ['Tono']),
    toneSelect,
    balanceBadge
  );

  header.append(titleBox, selectors);

  // ----- Lista de mensajes -----
  const list = el('div', {
    class: 'chat-messages mx-auto w-full max-w-3xl flex-1 space-y-3 overflow-y-auto px-4 py-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden scroll-smooth',
  });

  const noticeHost = el('div', { class: 'mx-auto w-full max-w-3xl px-4' });

  // ----- Barra de entrada -----
  const form = el('form', {
    class: 'mx-auto flex w-full max-w-3xl items-end gap-2 border-t border-slate-200/70 bg-white/90 px-4 py-3 backdrop-blur',
  });

  const pill = el('div', {
    class: 'flex flex-1 items-end gap-1 rounded-full border border-slate-200 bg-slate-100 px-2 py-1.5 transition focus-within:border-brand-500 focus-within:bg-white',
  });

  const input = el('textarea', {
    rows: '1',
    class: 'max-h-32 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-slate-800 placeholder-slate-500 outline-none',
  });
  input.placeholder = 'Escribe tu consulta legal aquí…';

  const sendButton = el('button', {
    type: 'submit',
    class: 'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-600 text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50',
    'aria-label': 'Enviar consulta',
  });
  const sendIcon = el('span', { class: 'inline-flex' });
  sendIcon.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 19V5m-6 6l6-6 6 6"/></svg>';
  const sendBusy = el('span', { class: 'hidden text-sm font-medium' });
  sendBusy.textContent = '…';
  sendButton.append(sendIcon, sendBusy);

  pill.append(input);
  form.append(pill, sendButton);

  container.append(header, noticeHost, list, form);

  // ----- Funciones de UI -----
  function updateBalanceBadge() {
    if (typeof balance === 'number') {
      balanceBadge.textContent = `Saldo: ${balance.toLocaleString('es-CL')} ${cr(balance)}`;
      balanceBadge.classList.remove('hidden');
    } else {
      balanceBadge.classList.add('hidden');
    }
  }

  function showNotice(kind, message) {
    noticeHost.replaceChildren(noticeBox(kind, message));
    setTimeout(() => noticeHost.replaceChildren(), 6000);
  }

  function nearBottom() {
    return list.scrollHeight - list.scrollTop - list.clientHeight <= 90;
  }

  function addTypingRow() {
    const row = el('div', { class: 'flex items-end gap-2' });
    const content = el('div', { class: 'flex min-w-0 flex-1 flex-col items-start' });
    const bubble = el('div', { class: 'flex items-center gap-1 rounded-2xl rounded-bl-sm bg-slate-100 px-4 py-3' });
    for (let i = 0; i < 3; i++) {
      bubble.append(el('span', { class: 'h-2 w-2 animate-bounce rounded-full bg-slate-400', style: `animation-delay:${(i * 0.15).toFixed(2)}s` }));
    }
    content.append(bubble);
    row.append(content);
    list.append(row);
    if (nearBottom()) list.scrollTop = list.scrollHeight;
    return row;
  }

  function addMessage(role, text, meta = {}, opts = {}) {
    const isOwn = role === 'user';
    const row = el('div', { class: 'flex items-end gap-2' });
    const content = el('div', { class: 'flex min-w-0 flex-1 flex-col gap-1 ' + (isOwn ? 'items-end' : 'items-start') });
    const bubble = el('div', {
      class: isOwn
        ? 'max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-brand-600 px-3.5 py-2.5 text-sm text-white'
        : 'max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-slate-100 px-3.5 py-2.5 text-sm text-slate-800',
    });
    row.dataset.messageText = text;

    if (isOwn) {
      bubble.textContent = text;
    } else {
      const displayText = /(\*\*[^*]+\*\*|`[^`\n]+`|^\s*#{1,4}\s|^\s*[-•]\s|^\s*\d{1,2}[.)]\s|\[[^\]]+\]\(/m.test(String(text ?? ''))
        ? String(text)
          .replace(/\[([^\]]+)\]\((?:https?:\/\/[^\s)]+|\/[^\s)]*)\)/g, '$1')
          .replace(/\*\*([^*]+)\*\*/g, '$1')
          .replace(/`([^`\n]+)`/g, '$1')
        : text;
      const renderMarkdown = displayText !== text;
      const typer = typewrite(bubble, displayText, {
        scroller: list,
        onComplete: () => {
          if (renderMarkdown) {
            bubble.innerHTML = renderMarkdown(text);
            bubble.style.whiteSpace = 'normal';
          }
          // Citas de fuentes (ley, artículo, inciso, link BCN, vigencia,
          // aviso de norma derogada/modificada).
          if (meta && Array.isArray(meta.markers) && meta.markers.length > 0) {
            renderSources(meta.markers);
          }
          // Confianza / uso de tokens (meta, discreto).
          if (meta && (typeof meta.confidence === 'number' || meta.usage_tokens)) {
            const line = el('p', { class: 'mt-1 text-[10px] text-slate-400' });
            const parts = [];
            if (typeof meta.confidence === 'number') parts.push(`Confianza: ${Math.round(meta.confidence * 100)}%`);
            if (meta.usage_tokens) parts.push(`Tokens: ${meta.usage_tokens.total ?? meta.usage_tokens}`);
            if (parts.length) line.textContent = parts.join('  ·  ');
            bubble.after(line);
          }
          // Créditos usados en esta respuesta.
          if (typeof meta.credits_used === 'number') {
            const line = el('p', { class: 'mt-1 text-[10px] text-brand-600 font-medium' });
            line.textContent = `Costo de esta respuesta: ${cr(meta.credits_used)}`;
            bubble.after(line);
          }
        },
        instant: opts.instant === true,
      });
      if (typer.animated) {
        bubble.classList.add('cursor-pointer');
        bubble.title = 'Mostrar todo';
        bubble.setAttribute('aria-busy', 'true');
        bubble.addEventListener('click', () => typer.complete());
      }
    }

    // Aviso de baja confianza.
    if (!isOwn && typeof meta.confidence === 'number' && meta.confidence < 0.5) {
      const warn = el('p', { class: 'mt-1 text-[10px] text-amber-600 font-medium' });
      warn.textContent = 'Esta respuesta tiene baja confianza: verifica la información antes de usarla.';
      content.append(warn);
    }

    row.append(content);
    list.append(row);
    if (nearBottom()) list.scrollTop = list.scrollHeight;
    return row;
  }

  function renderSources(markers) {
    const box = el('details', { class: 'mt-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2' });
    const summary = el('summary', { class: 'cursor-pointer select-none text-[11px] font-medium uppercase tracking-wide text-slate-400' });
    summary.textContent = `Fuentes consultadas (${markers.length})`;
    const listEl = el('div', { class: 'mt-1 space-y-1' });
    for (const m of markers) {
      const line = el('p', { class: 'truncate text-[11px] leading-relaxed text-slate-600' });
      const parts = [];
      if (m.ley) parts.push(`Ley ${m.ley}`);
      if (m.numero) parts.push(`Nº ${m.numero}`);
      if (m.articulo) parts.push(`art. ${m.articulo}`);
      if (m.inciso) parts.push(`inciso ${m.inciso}`);
      if (m.fecha_vigencia) parts.push(`vigente desde ${m.fecha_vigencia}`);
      let txt = parts.length ? parts.join(' · ') : 'Fuente jurídica';
      if (m.link_bcn) {
        txt += ` <a href="${escapeHtml(m.link_bcn)}" target="_blank" rel="noopener noreferrer" style="color:#2563eb;text-decoration:underline;">(BCN)</a>`;
      }
      if (m.derogada || m.modificada) {
        txt += ` <span style="color:#b91c1c;font-weight:600;">⚠ ${m.derogada ? 'Norma derogada' : 'Norma modificada'}</span>`;
      }
      line.innerHTML = txt;
      listEl.append(line);
    }
    box.append(summary, listEl);
    const lastRow = list.lastElementChild;
    if (lastRow) {
      const column = lastRow.querySelector(':scope > div:last-child');
      (column || lastRow).append(box);
    }
  }

  // ----- Envío -----
  async function send() {
    if (state.busy) return;
    const question = input.value.trim();
    if (question === '') return;

    // Confirmación de costo cuando el saldo está bajo (primer mensaje).
    if (firstMessage && typeof balance === 'number' && balance <= LOW_CREDITS) {
      const ok = await confirmModal({
        title: '¿Continuar con esta consulta?',
        message: `Tienes ${cr(balance)}. Esta consulta consumirá créditos de tu billetera. ¿Deseas continuar?`,
        confirmLabel: 'Sí, continuar',
        cancelLabel: 'No, cancelar',
      });
      if (!ok) return;
    }

    state.busy = true;
    firstMessage = false;
    sendButton.disabled = true;
    sendIcon.classList.add('hidden');
    sendBusy.classList.remove('hidden');
    noticeHost.replaceChildren();

    addMessage('user', question);
    input.value = '';
    input.style.height = 'auto';

    const typingRow = addTypingRow();

    try {
      const body = { question, area: state.area, tone: state.tone };
      if (conversationId) body.conversation_id = conversationId;

      // POST con header 'corazon' (créditos/LLM) y credentials: 'include' (apiPost).
      const data = await apiPost('/chat/completions', body, { 'corazon': 'asistentejudicial' });

      typingRow.remove();

      conversationId = data.conversation_id || conversationId;
      try { if (conversationId) sessionStorage.setItem(CONV_STORAGE_KEY, conversationId); } catch (_) {}

      if (typeof data.credits_remaining === 'number') {
        balance = data.credits_remaining;
        updateBalanceBadge();
        // El header global se refresca mediante el listener de app.js.
        window.dispatchEvent(new CustomEvent('aj:balance-changed'));
      }

      addMessage('assistant', String(data.answer ?? ''), {
        markers: data.markers || [],
        confidence: data.confidence,
        usage_tokens: data.usage_tokens,
        credits_used: data.credits_used,
      });

      showNotice('ok', 'Respuesta lista.');
    } catch (err) {
      typingRow.remove();
      let message = 'No pudimos generar una respuesta ahora mismo. No se te cobró nada: inténtalo de nuevo en un momento.';
      if (err.status === 401) {
        message = 'Tu sesión expiró. Inicia sesión nuevamente para continuar, solo toma un momento.';
        showNotice('err', message);
        addMessage('assistant', message, {}, { instant: true });
        return;
      }
      if (err.status === 402) {
        message = 'No tienes suficientes créditos para esta consulta. Puedes recargar cuando quieras y seguir desde donde ibas.';
        showNotice('err', message);
        const row = addMessage('assistant', message, {}, { instant: true });
        const btn = el('button', {
          type: 'button',
          class: 'mt-2 inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700',
        }, ['Comprar créditos']);
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          document.dispatchEvent(new CustomEvent('aj:navigate', { detail: { panel: 'wallet' } }));
        });
        row.querySelector(':scope > div:last-child').append(btn);
        return;
      }
      if (err.status === 429) {
        message = 'Has alcanzado el límite de mensajes por ahora. En unos minutos puedes volver a intentarlo: gracias por tu paciencia.';
      } else if (err.message) {
        message = err.message;
      }
      showNotice('err', message);
      addMessage('assistant', message, {}, { instant: true });
    } finally {
      state.busy = false;
      sendButton.disabled = false;
      sendIcon.classList.remove('hidden');
      sendBusy.classList.add('hidden');
      input.focus();
    }
  }

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 128) + 'px';
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void send();
  });

  // ----- Saldo inicial (para la confirmación de saldo bajo) -----
  (async () => {
    try {
      const session = await fetchMe();
      if (session && typeof session.balance === 'number') {
        balance = session.balance;
        updateBalanceBadge();
      }
    } catch (_) { /* saldo no disponible: se actualiza tras la primera respuesta */ }
  })();

  return {
    destroy() {
      container.replaceChildren();
    },
  };
}
