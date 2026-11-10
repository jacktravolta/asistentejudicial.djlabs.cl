    // API(path): every backend endpoint. api-config.js points at the API
    // origin, because this front is static and served from another host.
    window.API = (function () {
      var base = (typeof window.__API_BASE__ === 'string')
        ? window.__API_BASE__.trim().replace(/\/+$/, '')
        : '';
      return function (path) { return base + path; };
    })();
  