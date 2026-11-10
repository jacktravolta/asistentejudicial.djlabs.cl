(function () {
  'use strict';

/*
 The backend origin (single deploy knob, api-config.js). Same-origin by default.
 */
var API_ROOT = (typeof window.__API_BASE__ === 'string' ? window.__API_BASE__.trim().replace(/\/+$/, '') : '');

  var CODE_RE = /[0-9a-f]{32}/i;
  var btn = document.getElementById('btn');
  var input = document.getElementById('code');
  var box = document.getElementById('result');
  var hp = document.getElementById('hp');

  /* Client-side length guard: never POST-looking, but bound what we send. */
  var MAX_LEN = 256;

  function check(data, status) {
    if (status === 429) {
      resultCard(
        '<p class="verdict"><span class="big">Demasiadas consultas</span></p>' +
        '<p>Estamos protegiendo el servicio de consultas automatizadas. Espera unos minutos y vuelve a intentarlo.</p>',
        'r-warn');
      return;
    }
    if (status >= 500) {
      resultCard('<p class="verdict"><span class="big">No pudimos verificar</span></p><p>Servidor temporalmente no disponible. Inténtalo en unos minutos.</p>', 'r-warn');
      return;
    }
    var v = data && data.verification ? data.verification : null;

    if (!v) {
      resultCard('<p class="verdict"><span class="big">No pudimos verificar</span></p><p>El servidor no entregó una respuesta válida. Inténtalo en unos minutos.</p>', 'r-warn');
      return;
    }

    if (v.valid === true) {
      resultCard(
        '<p class="verdict"><span class="big">✓ COMPROBANTE VÁLIDO</span></p>' +
        '<p class="muted" style="margin:0 0 8px;">Los datos coinciden con su emisión original.</p>' +
        '<ul>' +
        '<li>' + esc(docLabel(v.document_type)) + (v.folio ? ' · Folio ' + esc(v.folio) : '') + '</li>' +
        '<li>Monto pagado: <strong>' + esc(money(v.amount_clp)) + ' CLP</strong></li>' +
        '<li>Créditos acreditados: <strong>' + esc(Number(v.credits || 0).toLocaleString('es-CL')) + '</strong></li>' +
        '<li>Estado de la operación: <strong>' + esc(v.status || '') + '</strong></li>' +
        '<li class="muted">Orden ' + esc(v.order_id || '') + ' · verificado ' + esc(new Date(v.checked_at).toLocaleString('es-CL')) + '</li>' +
        '</ul>',
        'r-ok');
      return;
    }

    if (/ADULTERADO/i.test(String(v.reason || ''))) {
      resultCard(
        '<p class="verdict"><span class="big">✗ DOCUMENTO ADULTERADO</span></p>' +
        '<p>' + esc(v.reason) + '</p>' +
        '<p><strong>No aceptes este comprobante como prueba de pago.</strong> Si alguien te lo entregó, avísale: el documento no coincide con sus datos de emisión.</p>' +
        '<p class="muted">Verificado ' + esc(new Date(v.checked_at || Date.now()).toLocaleString('es-CL')) + '</p>',
        'r-bad');
      return;
    }

    resultCard(
      '<p class="verdict"><span class="big">Comprobante sin validez</span></p>' +
      '<p>' + esc(v.reason || 'Código no válido.') + '</p>' +
      '<p class="muted">Verificado ' + esc(new Date(v.checked_at || Date.now()).toLocaleString('es-CL')) + '</p>',
      'r-bad');
  }

  /* Accepts the full verification URL ...?code=X or the bare code. */
  function extract(raw) {
    raw = String(raw || '').trim();
    if (!raw) { return ''; }
    var inUrl = null;
    try {
      inUrl = new URL(raw).searchParams.get('code');
    } catch (_e) { /* not a URL: look for code= or a hex run */ }
    if (inUrl) { return inUrl.trim(); }
    var kv = raw.match(/[?&]code=([0-9a-f]{32})/i);
    if (kv) { return kv[1]; }
    var hex = raw.match(CODE_RE);
    return hex ? hex[0] : '';
  }

  function resultCard(html, cls) {
    box.hidden = false;
    box.className = 'result ' + cls;
    box.innerHTML = html;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function docLabel(t) { return Number(t) === 33 ? 'Factura electrónica' : 'Boleta electrónica'; }

  function money(n) { return '$' + Number(n || 0).toLocaleString('es-CL'); }

  function verify(rawInput) {
    /* Honeypot: a filled hidden field means a robot — stay silent. */
    if (hp && hp.value !== '') {
      resultCard('<p class="verdict muted">Verificando…</p>', 'r-warn');
      return;
    }

    var code = extract(rawInput);
    if (!code) {
      resultCard('<p class="verdict"><span class="big">Código no encontrado</span></p><p>Revisa que la URL o el código estén completos (32 caracteres).</p>', 'r-warn');
      return;
    }
    if (code.length > MAX_LEN) {
      resultCard('<p class="verdict"><span class="big">Código demasiado largo</span></p>', 'r-warn');
      return;
    }

    btn.disabled = true;
    resultCard('<p class="verdict muted">Verificando…</p>', 'r-warn');

    fetch(API_ROOT + '/payments/voucher/verify?code=' + encodeURIComponent(code))
      .then(function (r) {
        return r.json().then(function (payload) {
          check(payload, r.status);
        });
      })
      .catch(function () {
        resultCard('<p class="verdict"><span class="big">No pudimos verificar</span></p><p>Sin conexión con el servidor. Inténtalo en unos minutos.</p>', 'r-warn');
      })
      .finally(function () { btn.disabled = false; });
  }

  btn.addEventListener('click', function () { verify(extract(input.value)); });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { verify(extract(input.value)); }
  });

  /* The stamp carries the code IN the URL: process automatically. */
  var urlCode = extract(window.location.href);
  if (urlCode) {
    input.value = urlCode;
    verify(urlCode);
  }
})();
