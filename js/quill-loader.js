// Shared Quill loader for every modal editor (admin composer, user reply).
//
// Self-hosted bundle: the CSP blocks cdn.quilljs.com, so the script lives in
// /js/vendor/quill.min.js (same convention as chat-editor.js). Concurrent
// callers share ONE load promise, and the module is imported (not a global),
// so each caller gets the same window.Quill instance.

// Resolved against THIS module's URL so the bundle is found on any host
// path (the front is served from a sub-path on a static host).
const QUILL_SOURCE = new URL('./vendor/quill.min.js', import.meta.url).href;
const QUILL_STYLE = new URL('../css/quill.snow.css', import.meta.url).href;

let pending = null;

export function loadQuillEditor() {
  if (window.Quill) {
    return Promise.resolve(window.Quill);
  }

  if (pending) {
    return pending;
  }

  pending = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = QUILL_SOURCE;
    script.async = true;
    script.onload = () => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = QUILL_STYLE;
      link.media = 'screen';
      document.head.appendChild(link);
      resolve(window.Quill);
    };
    script.onerror = () => {
      pending = null; // allow a retry on the next open
      reject(new Error('No pudimos cargar el editor. Revisa tu conexión e inténtalo nuevamente.'));
    };
    document.head.appendChild(script);
  });

  return pending;
}
