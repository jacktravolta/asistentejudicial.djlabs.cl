  (function () {
    // Marcador de tokens: agrega las consultas corporativas (anónimas) que
    // consumen el RAG de la cuenta del snippet. Solo visible en desarrollo.
    var ownerId = (document.querySelector('script[data-owner-id]') || {}).getAttribute;
    ownerId = ownerId ? document.querySelector('script[data-owner-id]').getAttribute('data-owner-id') : '';
    var box = document.getElementById('corp-usage-badge');
    function fmt(n) { return n >= 1000 ? (Math.round(n / 100) / 10) + 'k' : String(n); }
    function load() {
      fetch(window.__API_BASE__ + '/usage/summary?heart=ley_datos_21719', { credentials: 'include' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          if (!d || !d.data) { box.style.display = 'none'; return; }
          var u = d.data && d.data.corporate ? d.data.corporate : null;
          if (!u) { box.style.display = 'none'; return; }
          box.firstElementChild.textContent = u.queries > 0
            ? 'Consultas corporativas: ' + u.queries + ' · ' + fmt(u.total_tokens) + ' tokens (entrada ' + fmt(u.input_tokens) + ' + salida ' + fmt(u.output_tokens) + ')'
            : 'Consultas corporativas: 0 · sin tokens usados aún';
        })
        .catch(function () { box.style.display = 'none'; });
    }
    load();
    window.setInterval(load, 30000);
  })();
  