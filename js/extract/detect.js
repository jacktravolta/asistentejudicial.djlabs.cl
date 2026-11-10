// Client-side file type detection.
//
// This is a fast guard so we can reject unsupported files before doing any
// work. It is NOT a security boundary: the server re-validates the declared
// type and the real file content.

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
const TEXT_EXTENSIONS = new Set(['txt', 'md']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'flac', 'webm']);
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const DOC_MIME = 'application/msword';

/**
 * @typedef {'image'|'pdf'|'docx'|'text'|'doc'|'audio'|'unknown'} DetectedType
 */

/**
 * @param {File} file
 * @returns {{ type: DetectedType, mime: string, ext: string }}
 */
export function detectType(file) {
  const name = String((file && file.name) || '').toLowerCase();
  const mime = String((file && file.type) || '').toLowerCase();
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot + 1) : '';

  // Legacy .doc is explicitly rejected: OLE2 binary, no browser parser.
  if (mime === DOC_MIME || ext === 'doc') {
    return { type: 'doc', mime, ext };
  }

  if (mime === 'application/pdf' || ext === 'pdf') {
    return { type: 'pdf', mime, ext };
  }

  if (mime === DOCX_MIME || ext === 'docx') {
    return { type: 'docx', mime, ext };
  }

  if (mime.startsWith('image/') || IMAGE_EXTENSIONS.has(ext)) {
    return { type: 'image', mime, ext };
  }

  if (mime.startsWith('text/') || TEXT_EXTENSIONS.has(ext)) {
    return { type: 'text', mime, ext };
  }

  // Audio files: mp3, wav, ogg, m4a, flac, webm
  if (mime.startsWith('audio/') || AUDIO_EXTENSIONS.has(ext)) {
    return { type: 'audio', mime, ext };
  }

  return { type: 'unknown', mime, ext };
}