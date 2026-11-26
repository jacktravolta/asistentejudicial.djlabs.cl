// Conversation storage helpers without DOM dependencies.
// The conversation id and its owner are kept together so a tab can safely
// continue a conversation only while the same authenticated user is active.

export const CONVERSATION_STORAGE_KEY = 'chat_conversation_id';
export const CONVERSATION_OWNER_STORAGE_KEY = 'chat_conversation_user';
export const CONVERSATION_NOT_FOUND_MESSAGE = 'No encontramos esa conversación';

function normalizeOwnerId(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

/**
 * Reads a stored conversation id after validating its owner.
 * Legacy entries without an owner are accepted so the request-level recovery
 * can replace a stale id without blocking the chat.
 *
 * @param {{ getItem: (key: string) => string|null, removeItem: (key: string) => void }|null|undefined} storage
 * @param {string|number|null|undefined} currentUserId
 * @returns {string|null}
 */
export function readConversationId(storage, currentUserId) {
  if (!storage) return null;

  const id = storage.getItem(CONVERSATION_STORAGE_KEY) || '';
  if (!id) return null;

  const storedOwner = normalizeOwnerId(storage.getItem(CONVERSATION_OWNER_STORAGE_KEY));
  const currentOwner = normalizeOwnerId(currentUserId);

  // An absent owner is a legacy entry. The API-level recovery handles it if
  // the id is stale or belongs to another account.
  if (!storedOwner) return id;

  // Visitors must not continue an authenticated conversation, and a different
  // user must not inherit the previous account's conversation in this tab.
  if (!currentOwner || storedOwner !== currentOwner) {
    clearConversationId(storage);
    return null;
  }

  return id;
}

/**
 * Stores a conversation id together with its current owner.
 * A missing current user is represented by an empty owner.
 *
 * @param {{ setItem: (key: string, value: string) => void, removeItem: (key: string) => void }|null|undefined} storage
 * @param {string|null|undefined} id
 * @param {string|number|null|undefined} currentUserId
 */
export function writeConversationId(storage, id, currentUserId) {
  if (!storage) return;

  const value = id === null || id === undefined ? '' : String(id);
  if (!value) {
    clearConversationId(storage);
    return;
  }

  storage.setItem(CONVERSATION_STORAGE_KEY, value);
  storage.setItem(CONVERSATION_OWNER_STORAGE_KEY, normalizeOwnerId(currentUserId));
}

/**
 * Removes both the stored conversation id and its owner.
 *
 * @param {{ removeItem: (key: string) => void }|null|undefined} storage
 */
export function clearConversationId(storage) {
  if (!storage) return;
  storage.removeItem(CONVERSATION_STORAGE_KEY);
  storage.removeItem(CONVERSATION_OWNER_STORAGE_KEY);
}

/**
 * Identifies the API rejection caused by a missing or foreign conversation.
 *
 * @param {number|string|undefined} status
 * @param {{ error?: { code?: string, message?: string } }|null|undefined} payload
 * @returns {boolean}
 */
export function isConversationNotFoundError(status, payload) {
  if (Number(status) !== 400) return false;
  if (!payload || !payload.error || payload.error.code !== 'VALIDATION_ERROR') return false;

  return String(payload.error.message || '').includes(CONVERSATION_NOT_FOUND_MESSAGE);
}
