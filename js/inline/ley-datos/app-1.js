    // API(path): todo endpoint del backend. En 2-servidores apunta al API
    // origin; con api-config.js local ('') es same-origin puro.
    window.API = (function () {
      var base = (typeof window.__API_BASE__ === 'string')
        ? window.__API_BASE__.trim().replace(/\/+$/, '')
        : '';
      return function (path) { return base + path; };
    })();
    // FRONT_BASE: the absolute base URL of THIS front (host + sub-path), so
    // assets and the embeddable widget resolve when the site is served from
    // a sub-path (a static host has no server-side rewrite).
    window.FRONT_BASE = new URL('../', window.location.href).href;
  