import { apiGet } from './http.js?v=1';
import { resolveHeart } from './heart.js?v=1';
import {
  actionButton,
  el,
  formatDate,
  formatNumber,
  friendlyError,
  renderError,
  renderList,
  renderLoading,
} from './panel-section.js?v=1';

// Conversations library for the person's own chat history.
//
// The API owns the conversations: it lists the ones that belong to the
// authenticated user and returns their messages oldest first. This module
// only reads them and points the chat at one of them, so a conversation can
// continue where it was left.
//
// Server-provided titles and messages are rendered with DOM APIs only, so
// they can never be interpreted as markup.
//
// Every call names the heart explicitly: the API serves several hearts and
// rejects requests that do not identify one, so the library and the chat must
// read and write the SAME heart.
//
// The list primitives (loading, empty, error and rows) live in the shared
// panel-section module, so the other panel sections can reuse them.

const LIST_LIMIT = 20;
const LOADING_MESSAGE = 'Cargando tus conversaciones...';
const LOAD_ERROR_MESSAGE = 'No pudimos cargar tus conversaciones en este momento. Inténtalo nuevamente.';
const TRANSCRIPT_ERROR_MESSAGE = 'No pudimos cargar esta conversación. Inténtalo nuevamente.';
const OPEN_ERROR_MESSAGE = 'No pudimos abrir esta conversación en el chat. Inténtalo nuevamente.';
const EMPTY_TITLE = 'Todavía no tienes conversaciones.';
const EMPTY_HINT = 'Cuando le preguntes algo al asistente, la conversación aparecerá aquí para que puedas revisarla y continuarla.';
const UNTITLED_TITLE = 'Conversación sin título';
const EMPTY_TRANSCRIPT = 'Esta conversación todavía no tiene mensajes.';

const $id = (id) => document.getElementById(id);
let initialized = false;
let refreshVersion = 0;

function showRowError(errorNode, error) {
  errorNode.textContent = friendlyError(error, OPEN_ERROR_MESSAGE);
  errorNode.classList.remove('hidden');
}

// One message of the transcript, in its own block. The role drives the style
// and the label; the text always goes through textContent.
function createMessageBlock(message) {
  const role = String((message && message.role) || '');
  const isUser = role === 'user';
  const block = el(
    'div',
    isUser
      ? 'rounded-xl border border-brand-100 bg-brand-50/70 p-3'
      : 'rounded-xl border border-slate-200 bg-white p-3',
  );
  block.dataset.role = role || 'unknown';

  if (message && message.id) {
    block.dataset.messageId = String(message.id);
  }

  block.append(
    el('p', 'text-xs font-semibold uppercase tracking-wide text-slate-500', isUser ? 'Tú' : 'Asistente'),
    el(
      'p',
      'mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-800',
      String((message && message.content) || ''),
    ),
  );

  return block;
}

function createConversationRow(conversation) {
  const id = String((conversation && conversation.id) || '');
  const title = String((conversation && conversation.title) || '').trim() || UNTITLED_TITLE;
  const row = el('article', 'rounded-2xl border border-slate-200 bg-white p-4 shadow-sm');
  row.dataset.conversationId = id;

  const info = el('div', 'min-w-0 flex-1');
  info.append(
    el('h2', 'truncate text-sm font-semibold text-slate-900', title),
    el(
      'p',
      'mt-1 text-xs text-slate-500',
      `${formatDate(conversation && conversation.last_activity_at)} · ${formatNumber(conversation && conversation.message_count)} mensajes`,
    ),
  );

  const rowError = el(
    'p',
    'mt-3 hidden rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900',
    '',
  );
  rowError.setAttribute('role', 'alert');

  // The transcript opens INSIDE the row: the list keeps its shape while the
  // person reads the conversation.
  const transcript = el('div', 'mt-4 hidden space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4');
  transcript.dataset.transcript = 'true';

  let expanded = false;

  const viewButton = actionButton(
    'Ver conversación',
    'rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-400 hover:bg-slate-50',
    async () => {
      if (expanded) {
        expanded = false;
        transcript.classList.add('hidden');
        viewButton.setAttribute('aria-expanded', 'false');
        return;
      }

      expanded = true;
      transcript.classList.remove('hidden');
      viewButton.setAttribute('aria-expanded', 'true');
      viewButton.disabled = true;
      transcript.replaceChildren(el('p', 'text-sm text-slate-500', 'Cargando la conversación...'));

      try {
        const heart = await resolveHeart();
        const data = await apiGet(
          `/conversations/${encodeURIComponent(id)}/messages?heart=${encodeURIComponent(heart)}`,
          { fallbackMessage: TRANSCRIPT_ERROR_MESSAGE },
        );
        const messages = data && Array.isArray(data.messages) ? data.messages : [];

        if (!messages.length) {
          transcript.replaceChildren(el('p', 'text-sm text-slate-500', EMPTY_TRANSCRIPT));
          return;
        }

        const blocks = messages.map((message) => createMessageBlock(message));
        transcript.replaceChildren(...blocks);
      } catch (error) {
        transcript.replaceChildren(
          el('p', 'text-sm text-amber-900', friendlyError(error, TRANSCRIPT_ERROR_MESSAGE)),
        );
      } finally {
        viewButton.disabled = false;
      }
    },
  );
  viewButton.setAttribute('aria-expanded', 'false');

  const openButton = actionButton(
    'Abrir en el chat',
    'rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-sm font-medium text-brand-700 transition hover:bg-brand-50',
    async () => {
      openButton.disabled = true;
      rowError.classList.add('hidden');

      try {
        // The widget mounts asynchronously, so the id is written to
        // sessionStorage FIRST: the widget picks it up when it mounts. An
        // already-mounted widget continues the conversation right away.
        const chatWidgetModule = await import('./chat-widget.js?v=9');
        chatWidgetModule.useConversation(id);

        if (window.chatWidget && typeof window.chatWidget.setConversationId === 'function') {
          window.chatWidget.setConversationId(id);
        }

        document.dispatchEvent(new CustomEvent('panel:navigate', { detail: { panel: 'chat' } }));
      } catch (error) {
        showRowError(rowError, error);
      } finally {
        openButton.disabled = false;
      }
    },
  );

  const actions = el('nav', 'mt-4 flex flex-wrap items-center gap-2');
  actions.append(viewButton, openButton);

  row.append(info, actions, rowError, transcript);
  return row;
}

function renderConversations(container, conversations) {
  renderList(container, conversations, {
    renderItem: (conversation) => createConversationRow(conversation),
    emptyTitle: EMPTY_TITLE,
    emptyHint: EMPTY_HINT,
  });
}

export function initConversationsLibrary() {
  if (initialized) {
    return;
  }
  initialized = true;
}

export async function refreshConversationsLibrary() {
  const container = $id('conversations-list');
  if (!container) {
    return;
  }

  const version = ++refreshVersion;
  renderLoading(container, LOADING_MESSAGE);

  try {
    const heart = await resolveHeart();
    const data = await apiGet(
      `/conversations?heart=${encodeURIComponent(heart)}&limit=${LIST_LIMIT}`,
      { fallbackMessage: LOAD_ERROR_MESSAGE },
    );
    if (version !== refreshVersion) {
      return;
    }
    const conversations = data && Array.isArray(data.conversations) ? data.conversations : [];
    renderConversations(container, conversations);
  } catch (error) {
    if (version !== refreshVersion) {
      return;
    }
    renderError(container, error, LOAD_ERROR_MESSAGE, () => {
      void refreshConversationsLibrary();
    });
  }
}
