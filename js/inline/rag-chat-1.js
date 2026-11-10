(function () {
  'use strict';

  // The API origin comes from api-config.js (the front is static and
  // served from another host).
  var API = (typeof window.__API_BASE__ === 'string')
    ? window.__API_BASE__.trim().replace(/\/+$/, '')
    : '';
  var conversationId = null;
  var chat = document.getElementById('chat');
  var q = document.getElementById('q');
  var send = document.getElementById('send');
  var errBox = document.getElementById('err');

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function showErr(msg) {
    errBox.textContent = msg;
    errBox.style.display = 'block';
    setTimeout(function () { errBox.style.display = 'none'; }, 6000);
  }
  function addMsg(cls, text, extra) {
    var box = el('div', 'msg ' + cls, text);
    if (extra) box.append(extra);
    chat.append(box);
    chat.scrollTop = chat.scrollHeight;
    return box;
  }
  function setConv(id) {
    conversationId = id;
    document.getElementById('conv').textContent = id ? 'conversación ' + id.slice(0, 8) + '…' : 'conversación nueva';
  }

  // Session + balance
  fetch(API + '/auth/me', { credentials: 'include', headers: { Accept: 'application/json' } })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      var who = document.getElementById('who');
      if (d && d.success && d.data && d.data.user) {
        who.textContent = 'Sesión: ' + d.data.user.email + ' · saldo ' + d.data.balance + ' créditos';
      } else {
        who.innerHTML = 'Sin sesión. Inicia sesión en la app principal (mismo navegador) o pide un enlace mágico.';
      }
    })
    .catch(function () { document.getElementById('who').textContent = 'Sin sesión (no se pudo verificar).'; });

  function sendQuestion() {
    var question = q.value.trim();
    if (question === '' || send.disabled) return;
    q.value = '';
    send.disabled = true;
    addMsg('user', question);

    var body = { question: question };
    var heart = document.getElementById('heart').value.trim();
    if (heart !== '') body.heart = heart;
    if (conversationId) body.conversation_id = conversationId;

    fetch(API + '/chat/completions', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body)
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.d || res.d.success === false) {
          var e = (res.d && res.d.error) || {};
          addMsg('bot', '⚠ ' + (e.message || 'Error del servidor'));
          if (e.code) showErr(e.code + ': ' + (e.message || ''));
          return;
        }
        var data = res.d.data || {};
        if (data.conversation_id) setConv(data.conversation_id);

        var box = el('div', 'msg bot');
        box.append(el('span', null, data.answer || '(sin respuesta)'));

        var meta = [];
        var m = data.monitoring || {};
        if (m.total_tokens) meta.push(m.total_tokens + ' tokens');
        if (m.cost_clp !== undefined) meta.push('~' + m.cost_clp + ' CLP');
        if (data.credits_charged !== undefined) meta.push(data.credits_charged + ' créditos cobrados');
        var src = data.sources || [];
        if (src.length) {
          meta.push('fuentes: ' + src.map(function (s) {
            return (s.title || s.source_id || '?') + ' (' + s.scope + ', ' + Number(s.score).toFixed(2) + ')';
          }).join(' · '));
        }
        if (meta.length) box.append(el('div', 'meta', meta.join(' · ')));

        var ps = data.prompt_sent;
        if (ps && (ps.system || ps.user)) {
          var det = el('details');
          det.append(el('summary', null, '🔧 prompt enviado a la IA'));
          var sys = el('div'); sys.append(el('b', null, 'SYSTEM:'));
          var sysPre = el('pre', null, ps.system || '');
          var usr = el('div'); usr.append(el('b', null, 'USER:'));
          var usrPre = el('pre', null, ps.user || '');
          det.append(sys, sysPre, usr, usrPre);
          box.append(det);
        }
        chat.append(box);
        chat.scrollTop = chat.scrollHeight;
      })
      .catch(function (e) { addMsg('bot', '⚠ Error de red: ' + e); })
      .finally(function () { send.disabled = false; q.focus(); });
  }

  function attachText() {
    var name = document.getElementById('aname').value.trim() || 'pegado.txt';
    var text = document.getElementById('atext').value.trim();
    if (text === '') { showErr('Pega texto para adjuntar.'); return; }
    var form = new FormData();
    form.append('text', text);
    form.append('source_type', 'text');
    var heart2 = document.getElementById('heart').value.trim();
    if (heart2 !== '') form.append('heart', heart2);
    form.append('original_filename', name);
    fetch(API + '/documents/ingest', {
      method: 'POST', credentials: 'include',
      headers: { Accept: 'application/json' }, body: form
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.success === false) { showErr((d.error && d.error.message) || 'Error al adjuntar'); return; }
        document.getElementById('atext').value = '';
        addMsg('bot', '📎 "' + name + '" guardado como adjunto pendiente. Tu próxima pregunta lo incluye.');
      })
      .catch(function (e) { showErr('Error de red: ' + e); });
  }

  send.addEventListener('click', sendQuestion);
  q.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendQuestion(); }
  });
  document.getElementById('attach').addEventListener('click', attachText);
  document.getElementById('newConv').addEventListener('click', function () {
    setConv(null);
    addMsg('bot', '— conversación nueva (los adjuntos pendientes siguen activos) —');
  });
  q.focus();
})();
