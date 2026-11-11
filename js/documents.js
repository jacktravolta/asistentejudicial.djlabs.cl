// Documents panel: file upload, text input, extraction, and ingest.
//
// Flow (file):   detect -> extract -> preview -> confirm -> ingest.
// Flow (text):   read textarea -> preview -> confirm -> ingest.
//
// All DOM manipulation lives in ui.js; all network access lives in api.js.
// The SPA calls initDocuments() once at startup.

import { detectType } from './extract/detect.js?v=4';
import { extract, DOC_ERROR, UNKNOWN_ERROR } from './extract/index.js?v=4';
import { ingestDocument } from './api.js?v=4';
import * as ui from './ui.js?v=5';
import { resolveHeart } from './heart.js?v=1';

// Queue of documents awaiting confirmation: [{ id, text, sourceType, file, name, status, progress }]
let pendingQueue = [];
let pasteHandler = null;

// Debug mode
const DEBUG = true;
function debugLog(...args) {
  if (DEBUG) {
    console.log('[DEBUG Documents]', new Date().toISOString(), ...args);
  }
}

/**
 * Returns a friendly Spanish message for an error, falling back when needed.
 *
 * @param {unknown} error
 * @param {string} fallback
 * @returns {string}
 */
function friendlyMessage(error, fallback) {
  const fallbackMessages = {
    default: 'No pudimos procesar tu documento. Lo siento, estamos teniendo dificultades técnicas. ' +
             'Por favor, verifica el formato e inténtalo nuevamente en unos minutos.',
    unknown: 'Ocurrió un error inesperado. Lo siento, por favor inténtalo nuevamente.'
  };
  
  if (error && typeof error.message === 'string' && error.message.trim() !== '') {
    const msg = error.message;
    if (msg.includes('no pudimos') || msg.includes('No pudimos') || msg.includes('ERROR')) {
      return msg;
    }
    return fallbackMessages.default;
  }
  return fallbackMessages.unknown;
}

/**
 * Generates a unique ID for a pending document.
 */
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

/**
 * Handles a selected / dropped file: detect, extract and preview.
 *
 * @param {File} file
 */
async function handleFile(file) {
  debugLog('handleFile called', { name: file.name, type: file.type, size: file.size });
  ui.clear();

  const { type } = detectType(file);
  debugLog('detectType result', type);

  if (type === 'doc') {
    ui.showError(DOC_ERROR);
    return;
  }

  if (type === 'unknown') {
    ui.showError(UNKNOWN_ERROR);
    return;
  }

  // Add to pending queue immediately with pending status
  const pendingItem = {
    id: generateId(),
    file,
    name: file.name,
    sourceType: type,
    text: null,
    status: 'pending',
    progress: 0
  };
  
  pendingQueue.push(pendingItem);
  ui.showUploadList(pendingQueue.map(item => ({
    name: item.name,
    type: item.sourceType,
    size: file.size,
    progress: item.progress,
    status: item.status
  })));

  ui.setStatus('Leyendo tu documento, esto puede tardar unos segundos...');
  ui.setProgress(0);

  try {
    const { text, sourceType } = await extract(file, (percent) => {
      // Update progress for this specific file
      const index = pendingQueue.findIndex(item => item.id === pendingItem.id);
      if (index !== -1) {
        pendingQueue[index].progress = percent;
        ui.updateUploadProgress(index, percent, 'extracting');
      }
      ui.setProgress(percent);
    });
    
    debugLog('extract completed', { sourceType, textLength: text?.length });
    const clean = (text || '').trim();

    if (clean === '') {
      ui.setStatus('');
      ui.showError(
        'No encontramos texto en el documento. Si es una imagen, prueba con una foto más nítida; ' +
        'si es un PDF, verifica que no esté protegido.'
      );
      // Remove from queue
      const index = pendingQueue.findIndex(item => item.id === pendingItem.id);
      if (index !== -1) {
        pendingQueue.splice(index, 1);
        ui.showUploadList(pendingQueue.map(item => ({
          name: item.name,
          type: item.sourceType,
          size: item.file ? item.file.size : 0,
          progress: item.progress,
          status: item.status
        })));
      }
      ui.setProgress(0);
      ui.setStatus('');
      return;
    }

    // Update item with extracted text and mark as ready
    const index = pendingQueue.findIndex(item => item.id === pendingItem.id);
    if (index !== -1) {
      pendingQueue[index].text = clean;
      pendingQueue[index].sourceType = sourceType;
      pendingQueue[index].status = 'ready';
      pendingQueue[index].progress = 100;
      ui.updateUploadProgress(index, 100, 'done');
    }

    debugLog('extract completed', { sourceType, textLength: text?.length });
    ui.setProgress(100);
    ui.setStatus('Listo. Revisa el texto y confirma para guardarlo.');
    ui.showResult(clean);
  } catch (error) {
    debugLog('extract error', error);
    const index = pendingQueue.findIndex(item => item.id === pendingItem.id);
    if (index !== -1) {
      pendingQueue[index].status = 'error';
      ui.updateUploadProgress(index, 0, 'error');
    }
    ui.setStatus('');
    ui.setProgress(0);
    ui.showError(friendlyMessage(error, 'No pudimos leer el documento. Lo siento, estamos teniendo dificultades técnicas. Por favor, verifica el formato e inténtalo nuevamente en unos minutos.'));
  }
}

/**
 * Handles the free-text textarea path.
 */
function handleFreeText() {
  debugLog('handleFreeText called');
  ui.clear();

  const text = (ui.getFreeText() || '').trim();
  debugLog('handleFreeText text length', text.length);

  if (text === '') {
    ui.showError('Escribe o pega el texto que quieres guardar. Lo siento, necesitamos tu texto para continuar. Verifique e inténtalo nuevamente.');
    return;
  }

  const pendingItem = {
    id: generateId(),
    file: null,
    name: 'Texto libre',
    sourceType: 'text',
    text: text,
    status: 'ready',
    progress: 100
  };

  pendingQueue.push(pendingItem);
  ui.showUploadList(pendingQueue.map(item => ({
    name: item.name,
    type: item.sourceType,
    size: item.text ? item.text.length : 0,
    progress: item.progress,
    status: item.status
  })));

  debugLog('pending set (free text)', { textLength: text.length });
  ui.showResult(text);
  ui.setStatus('Revisa el texto y confirma para guardarlo.');
}

/**
 * Sends the pending documents to the server.
 */
async function handleConfirm() {
  debugLog('handleConfirm called', { queueLength: pendingQueue.length, pendingKeys: pendingQueue.map(p => p.id) });
  
  const readyItems = pendingQueue.filter(item => item.status === 'ready');
  
  if (readyItems.length === 0) {
    debugLog('handleConfirm: no ready documents');
    return;
  }

  ui.clear();
  ui.setStatus('Guardando tus documentos...');
  ui.setProgress(0);

  try {
    // The ingest must land in the SAME heart the chat and the library use:
    // the API serves several hearts and does not guess.
    const heart = await resolveHeart();

    for (let i = 0; i < readyItems.length; i++) {
      const item = readyItems[i];
      const globalIndex = pendingQueue.findIndex(p => p.id === item.id);
      
      ui.setProgress(Math.round(((i + 1) / readyItems.length) * 100));
      ui.setStatus(`Guardando ${i + 1} de ${readyItems.length}: ${item.name}...`);
      
      if (item.status !== 'ready') {
        debugLog('Skipping non-ready item', { id: item.id, status: item.status });
        continue;
      }

      try {
        const data = await ingestDocument({
          text: item.text,
          sourceType: item.sourceType,
          name: item.name,
          extra: { heart },
        });
        debugLog('ingestDocument success', data);

        if (globalIndex !== -1) {
          pendingQueue[globalIndex].status = 'saved';
          ui.updateUploadProgress(pendingQueue.findIndex(p => p.id === item.id), 100, 'saved');
        }

        // No auto-send: the ingest endpoint records the attachment as
        // PENDING for this owner. It attaches to the user's NEXT real
        // question, so "Pregunta del usuario" is what they actually typed.
      } catch (error) {
        debugLog('ingestDocument error for item', { id: item.id, error });
        const globalIndex = pendingQueue.findIndex(p => p.id === item.id);
        if (globalIndex !== -1) {
          pendingQueue[globalIndex].status = 'error';
          ui.updateUploadProgress(globalIndex, 0, 'error');
        }
        throw error;
      }
    }

    ui.setProgress(100);
    ui.setStatus('');

    const totalChars = readyItems.reduce((sum, item) => sum + (item.text?.length || 0), 0);
    const savedCount = readyItems.filter(i => pendingQueue.find(p => p.id === i.id)?.status === 'saved').length;
    ui.showSuccess(`Guardamos ${savedCount} documento${savedCount > 1 ? 's' : ''} (${totalChars} caracteres). Ya puedes continuar.`);

    if (savedCount > 0) {
      document.dispatchEvent(new CustomEvent('documents:ingested', {
        detail: { count: savedCount },
      }));
    }
    
    // Remove saved items from queue
    pendingQueue = pendingQueue.filter(item => item.status !== 'saved');
    ui.showUploadList(pendingQueue.map(item => ({
      name: item.name,
      type: item.sourceType,
      size: item.file ? item.file.size : 0,
      progress: item.progress,
      status: item.status
    })));
  } catch (error) {
    debugLog('handleConfirm error', error);
    ui.setProgress(0);
    ui.setStatus('');
    ui.showError(
      friendlyMessage(error, 'No pudimos guardar el documento. Lo siento, hubo un error al guardar. Por favor, inténtalo nuevamente en unos minutos.')
    );
  }
}

/**
 * Wires the documents panel: upload/ingest flow and clipboard paste.
 * Called once at app startup.
 */
let documentsInitialized = false;

export function initDocuments() {
  if (documentsInitialized) {
    debugLog('initDocuments: already initialized, skipping');
    return;
  }
  documentsInitialized = true;
  debugLog('initDocuments called');
  ui.bindFileInput(handleFile);
  ui.bindDropzone(handleFile);
  ui.bindTextSubmit(handleFreeText);
  ui.bindConfirm(handleConfirm);

  // Clipboard paste: treat pasted images as uploaded screenshots.
  if (pasteHandler) {
    document.removeEventListener('paste', pasteHandler);
  }
  // Clipboard paste: any pasted file (screenshot, PDF, DOCX, text) goes
  // through the same browser-side extraction pipeline. Pasted text is left
  // alone so normal text paste keeps working.
  pasteHandler = (event) => {
    const items = event.clipboardData && event.clipboardData.items;
    if (!items) return;

    for (const item of items) {
      if (item.kind && item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (!file) continue;

      const fileInput = document.getElementById('file-input');
      if (fileInput) {
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        fileInput.files = dataTransfer.files;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      break;
    }
  };
  document.addEventListener('paste', pasteHandler);
}

export function destroyDocuments() {
  if (pasteHandler) {
    document.removeEventListener('paste', pasteHandler);
    pasteHandler = null;
  }
}