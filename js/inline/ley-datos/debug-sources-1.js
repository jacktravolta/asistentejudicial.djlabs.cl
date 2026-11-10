'use strict';
const out = document.getElementById('out');
function card(title, bodyText, cls) {
  const d = document.createElement('div');
  d.className = 'card ' + (cls || '');
  d.innerHTML = '<h2>' + title + '</h2><pre></pre>';
  d.querySelector('pre').textContent = bodyText;
  out.appendChild(d);
  return d;
}

(async () => {
  const jwt = localStorage.getItem('jwt') || '';
  card('1 · Token en localStorage', 'localStorage["jwt"]: ' + (jwt ? 'PRESENTE (' + jwt.length + ' chars, …' + jwt.slice(-12) + ')' : 'VACÍO (solo cookie)'), jwt ? 'ok' : 'bad');

  try {
    const r = await fetch(window.__API_BASE__ + '/auth/me', { credentials: 'include', headers: { Authorization: 'Bearer ' + jwt } });
    const d = await r.json();
    card('2 · Sesión detectada por el servidor', 'HTTP ' + r.status + '\n' + JSON.stringify(d && d.data || d, null, 2), r.ok ? 'ok' : 'bad');
  } catch (e) {
    card('2 · Sesión detectada por el servidor', 'ERROR: ' + e.message, 'bad');
  }

  const urls = [
    'con heart: /rag/sources?heart=ley_datos_21719',
    'sin heart: /rag/sources'
  ];
  for (const label of urls) {
    const url = label.split(': ')[1];
    try {
      const r = await fetch(window.__API_BASE__ + url, { credentials: 'include', headers: { Authorization: 'Bearer ' + jwt } });
      const text = await r.text();
      let parsed;
      try { parsed = JSON.parse(text); } catch (_) { parsed = null; }
      const count = parsed && parsed.data && Array.isArray(parsed.data.sources) ? parsed.data.sources.length : 'NO';
      const lines = ['HTTP ' + r.status, 'fuentes devueltas: ' + count, '', text.slice(0, 900)];
      card('3 · ' + label, lines.join('\n'), r.ok && count !== 'NO' && count > 0 ? 'ok' : 'bad');
      if (parsed && parsed.data && Array.isArray(parsed.data.sources)) {
        for (const s of parsed.data.sources) {
          card('   ↳ fuente', JSON.stringify(s, null, 2), 'ok');
        }
      }
    } catch (e) {
      card('3 · ' + label, 'ERROR de red/JS: ' + (e && e.stack || e), 'bad');
    }
  }

  card('4 · Cómo seguir', 'Copia TODO lo que ves en esta página (Ctrl+A, Ctrl+C) y pégalo en el chat.');
})();
