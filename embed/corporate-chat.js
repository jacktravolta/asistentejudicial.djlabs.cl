/**
 * corporate-chat.js — chat web corporativo embebible, autónomo, 100% JS.
 *
 * Uso en CUALQUIER web (mismo origen o cross-origin):
 *
 *   <script src="http://127.0.0.1:8086/embed/corporate-chat.js"
 *           data-api-base="http://127.0.0.1:8086"
 *           data-heart="ley_datos_21719"
 *           data-owner-id="6d6a5892-ca77-11f1-8f9d-48a4729fc720"
 *           data-title="Asistente Acme"></script>
 *
 * Contrato backend:
 *   POST {api}/chat/completions  {question, heart, rag_owner?, visitor_id?,
 *                                 history?: [{role, content}, ...max 6]}
 *   -> {success, data:{answer, sources[], markers[], credits_charged?, balance?}}
 *   El visitante va anónimo (sin cookies, sin auth); el RAG y la wallet
 *   cobrada son los del dueño definido por los parámetros del snippet
 *   (data-heart + data-owner-id), resueltos y validados server-side.
 *
 *   El atributo data-api-base apunta al origen del API. Cuando falta, el
 *   widget recurre a window.__API_BASE__ (api-config.js), así que el mismo
 *   archivo también funciona servido desde este front.
 *
 * Comportamiento:
 *   - Burbuja abajo-izquierda; el panel se MINIMIZA (vuelve a burbuja),
 *     MAXIMIZA (grande) y se cierra.
 *   - Avatar de ejecutivo en cada respuesta del asistente.
 *   - Voz a texto (dictado) en el input, mismo patrón del chat principal.
 *   - Conversación PERSISTENTE por visitante (localStorage) + botón para
 *     borrarla y partir de cero.
 *   - Disponibilidad: el API unificado NO tiene un probe de disponibilidad
 *     (GAP documentado en MIGRATION.md), así que la burbuja siempre aparece
 *     y el saldo del dueño se verifica en el primer turno (402 amable).
 *   - Seguridad: todo texto del modelo se escapa ANTES de cualquier HTML y
 *     solo se inyectan tags construidos por este archivo. Shadow DOM aísla
 *     los estilos del sitio anfitrión.
 */
(function () {
  'use strict';

  var script = document.currentScript;
  if (!script) {
    var candidates = document.querySelectorAll('script[data-heart]');
    script = candidates[candidates.length - 1];
  }
  if (!script) return;

  // The API origin: the data attribute of the snippet wins (the widget is
  // embedded in other sites); when it is absent, fall back to the page's
  // api-config.js, so the same file works inside this front too.
  var API_BASE = (script.getAttribute('data-api-base')
    || (typeof window.__API_BASE__ === 'string' ? window.__API_BASE__ : '')
    || '').replace(/\/+$/, '');
  var HEART = script.getAttribute('data-heart') || 'default';
  var OWNER = script.getAttribute('data-owner-id') || '';
  var TITLE = script.getAttribute('data-title') || 'Asistente';
  var WELCOME = script.getAttribute('data-welcome') || 'Hola: pregúntame lo que quieras y te oriento.';
  var ACCENT = script.getAttribute('data-accent') || '#4f46e5';

  // Apariencia del bot (feature T13): la DB manda (embed_configs por
  // owner+heart vía /rag/embed-config); estos valores iniciales son los
  // defaults actuales del widget y el respaldo si el fetch falla.
  var SIDE = 'left';
  var AVATAR_URL = '';

  // Per-card RAG scoping (feature: embed-rag-config): data-source-id es una
  // lista separada por comas. Si viene, cada pregunta se responde SOLO sobre
  // esas fuentes (el servidor valida que sean del dueño); si no viene, el
  // widget no manda el campo y el chat usa la selección por defecto.
  var SOURCE_IDS = (script.getAttribute('data-source-id') || '')
    .split(',')
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s !== ''; });

  // Voz de lectura: la fuente de verdad es el servidor (owner+heart, tabla
  // embed_configs): al arrancar el widget pide su config a
  // GET /rag/embed-config y se autoconfigura. data-tts / data-voice en
  // el snippet quedan SOLO como respaldo (snippets viejos) por si el fetch
  // aún no resuelve o falla. data-tts="off" quita el botón Escuchar del
  // chat; data-voice="Nombre|es-XX" fija la voz de locución cuando el
  // navegador del visitante la tiene.
  var TTS_ON = (script.getAttribute('data-tts') || 'on') !== 'off';
  var VOICE_PREF = script.getAttribute('data-voice') || '';

  var HOST_KEY = 'cc_hist_' + (OWNER || 'default') + '_' + HEART;
  var STATE_KEY = 'cc_state_' + (OWNER || 'default') + '_' + HEART;
  var HISTORY_LIMIT = 60;

  // Stable per-visitor id (feature: visitor-conversations): random UUID in
  // localStorage, scoped to this owner+heart. Opaque by design: no IP, no
  // email, no account. The server groups the visitor's turns by it so the
  // owner's panel can list and administer the conversation. If localStorage
  // is unavailable, the server falls back to a per-operation key.
  var VISITOR_KEY = 'cc_vid_' + (OWNER || 'default') + '_' + HEART;

  function mintVisitorId() {
    try {
      var v = localStorage.getItem(VISITOR_KEY);
      if (!v) {
        v = (window.crypto && typeof crypto.randomUUID === 'function')
          ? crypto.randomUUID()
          : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
              var r = Math.random() * 16 | 0;
              return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
            });
        localStorage.setItem(VISITOR_KEY, v);
      }
      return v;
    } catch (_) {
      return ''; // sin localStorage: el server agrupa por operación
    }
  }

  var VISITOR_ID = mintVisitorId();

  var host = document.createElement('div');
  host.setAttribute('data-corporate-chat', '');
  var shadow = host.attachShadow({ mode: 'open' });

  var CSS = [
    // --cc-accent: el valor inicial es el atributo data-accent del snippet
    // (respaldo); la DB (embed_configs) lo gana en runtime vía
    // host.style.setProperty (applyAppearance).
    ':host{all:initial;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:14px;--cc-accent:' + ACCENT + ';}',
    '*{box-sizing:border-box;margin:0;padding:0;}',
    '.bubble{position:fixed;left:18px;bottom:18px;width:56px;height:56px;border-radius:50%;border:none;cursor:pointer;',
    '  background:var(--cc-accent);box-shadow:0 6px 20px rgba(15,23,42,.35);display:flex;align-items:center;justify-content:center;z-index:2147483000;overflow:hidden;}',
    '.bubble:hover{filter:brightness(1.08);}',
    '.bubble svg{width:26px;height:26px;fill:#fff;}',
    '.bubble img{width:100%;height:100%;object-fit:cover;}',
    '.bubble.right{left:auto;right:18px;}',
    '.badge{position:fixed;left:66px;bottom:34px;background:#0f172a;color:#fff;font-size:11px;padding:4px 10px;border-radius:999px;opacity:0;transition:opacity .2s;z-index:2147483000;pointer-events:none;}',
    '.badge.show{opacity:1;}',
    '.badge.right{left:auto;right:66px;}',
    '.panel{position:fixed;left:12px;bottom:86px;width:min(380px,calc(100vw - 24px));height:min(560px,calc(100vh - 120px));',
    '  background:#f8fafc;border:1px solid #e2e8f0;border-radius:16px;box-shadow:0 18px 50px rgba(15,23,42,.28);',
    '  display:none;flex-direction:column;overflow:hidden;z-index:2147483000;}',
    '.panel.right{left:auto;right:12px;}',
    '.panel.open{display:flex;}',
    '.panel.max{width:min(760px,calc(100vw - 24px));height:calc(100vh - 96px);bottom:78px;}',
    '.head{display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--cc-accent);color:#fff;flex:0 0 auto;}',
    '.head .dot{width:34px;height:34px;border-radius:50%;background:rgba(255,255,255,.2);display:flex;align-items:center;justify-content:center;flex:0 0 auto;overflow:hidden;}',
    '.head .dot svg{width:20px;height:20px;fill:#fff;}',
    '.head .dot img{width:100%;height:100%;object-fit:cover;}',
    '.head .t{font-weight:700;font-size:14px;line-height:1.2;}',
    '.head .s{font-size:11px;opacity:.85;}',
    '.hbtn{background:none;border:none;color:#fff;cursor:pointer;padding:4px 7px;border-radius:8px;font-size:14px;line-height:1;}',
    '.hbtn:hover{background:rgba(255,255,255,.18);}',
    '.hbtn.confirm{background:#dc2626;font-weight:700;}',
    '.msgs{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;background:#fff;}',
    '.row{display:flex;align-items:flex-end;gap:8px;}',
    '.tts-btn{display:inline-flex;align-items:center;gap:4px;margin-top:6px;padding:3px 8px;border:0;border-radius:8px;background:transparent;color:#64748b;font-size:11px;cursor:pointer;}',
    '.tts-btn:hover{background:#e2e8f0;color:#0f172a;}',
    '.tts-btn svg{width:14px;height:14px;}',
    '.tts-btn.speaking{background:#dbeafe;color:#1d4ed8;}',
    '.row.own{justify-content:flex-end;}',
    '.avatar{width:30px;height:30px;border-radius:50%;background:var(--cc-accent);display:flex;align-items:center;justify-content:center;flex:0 0 auto;box-shadow:0 1px 4px rgba(15,23,42,.2);overflow:hidden;}',
    '.avatar svg{width:18px;height:18px;fill:#fff;}',
    '.avatar img{width:100%;height:100%;object-fit:cover;}',
    '.msg{max-width:80%;padding:9px 12px;border-radius:14px;font-size:13.5px;line-height:1.55;white-space:pre-wrap;word-break:break-word;}',
    '.msg.user{background:var(--cc-accent);color:#fff;border-bottom-right-radius:4px;}',
    '.msg.bot{background:#f1f5f9;color:#0f172a;border-bottom-left-radius:4px;}',
    '.msg.bot p{margin:0 0 6px;white-space:normal;}',
    '.msg.bot p:last-child{margin-bottom:0;}',
    '.msg.bot ul,.msg.bot ol{margin:4px 0 6px;padding-left:18px;white-space:normal;}',
    '.msg.bot li{margin:2px 0;}',
    '.msg.bot strong{font-weight:700;}',
    '.msg.bot code{font-family:ui-monospace,Menlo,Consolas,monospace;background:#e2e8f0;border-radius:4px;padding:1px 5px;font-size:12px;}',
    '.msg.bot a{color:var(--cc-accent);}',
    '.src{font-size:11px;color:#64748b;margin-top:6px;white-space:normal;}',
    '.cost{font-size:10.5px;color:#94a3b8;margin-top:3px;}',
    '.err{background:#fef2f2;color:#991b1b;}',
    '.typing{display:inline-flex;gap:4px;padding:4px 2px;}',
    '.typing i{width:6px;height:6px;border-radius:50%;background:#94a3b8;animation:cc-b 1.2s infinite;}',
    '.typing i:nth-child(2){animation-delay:.15s;}.typing i:nth-child(3){animation-delay:.3s;}',
    '@keyframes cc-b{0%,60%,100%{transform:translateY(0);opacity:.5;}30%{transform:translateY(-4px);opacity:1;}}',
    '@media (prefers-reduced-motion: reduce){.typing i{animation:none;}}',
    // Modal de video (enlaces YouTube/Vimeo en las respuestas): sobre el
    // panel (2147483000) y por dentro del shadow, aislado del sitio anfitrión.
    '.vmodal{position:fixed;inset:0;background:rgba(15,23,42,.72);display:flex;align-items:center;justify-content:center;padding:16px;z-index:2147483001;}',
    '.vbox{position:relative;width:min(92vw,156vh,880px);background:#0f172a;border-radius:14px;padding:12px;box-shadow:0 24px 60px rgba(0,0,0,.5);}',
    '.vbox iframe{display:block;width:100%;aspect-ratio:16/9;border:0;border-radius:10px;background:#000;}',
    '.vclose{position:absolute;top:-12px;right:-12px;width:34px;height:34px;border:none;border-radius:50%;cursor:pointer;background:#f8fafc;color:#0f172a;font-size:20px;line-height:1;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 10px rgba(0,0,0,.45);}',
    '.vclose:hover{background:#e2e8f0;}',
    '.inputbar{display:flex;gap:6px;padding:10px;border-top:1px solid #e2e8f0;background:#fff;flex:0 0 auto;align-items:flex-end;}',
    '.inputbar textarea{flex:1;resize:none;border:1px solid #cbd5e1;border-radius:10px;padding:8px 10px;font:inherit;font-size:13.5px;max-height:110px;outline:none;}',
    '.inputbar textarea:focus{border-color:var(--cc-accent);}',
    '.ibtn{border:none;border-radius:10px;width:38px;height:38px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex:0 0 auto;}',
    '.ibtn svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;}',
    '.mic{background:#f1f5f9;color:#475569;}',
    '.mic:hover{background:#e2e8f0;}',
    '.mic.rec{background:#fee2e2;color:#dc2626;animation:cc-pulse 1.2s infinite;}',
    '@keyframes cc-pulse{0%,100%{opacity:1;}50%{opacity:.55;}}',
    '.send{background:var(--cc-accent);color:#fff;}',
    '.send:disabled{opacity:.5;cursor:default;}',
    '@media (max-width:520px){.panel{width:calc(100vw - 16px);height:calc(100vh - 96px);left:8px;bottom:84px;}.panel.right{left:auto;right:8px;}}'
  ].join('');

  var style = document.createElement('style');
  style.textContent = CSS;

  // SVG del ejecutivo (avatar del asistente): persona con traje y corbata.
  var PLAY_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  var STOP_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h12v12H6z"/></svg>';
  var EXEC_SVG = '<svg viewBox="0 0 24 24"><path d="M12 2a4.2 4.2 0 1 1 0 8.4A4.2 4.2 0 0 1 12 2zm-1.2 9.6h2.4c.5 0 .9.3 1 .8l.3 1.6 2.1 1a1 1 0 0 1 .5 1.3l-.5 1a1 1 0 0 1-1.3.5l-1.5-.7.4 2.4a1 1 0 0 1-1 1.2h-2.4a1 1 0 0 1-1-1.2l.4-2.4-1.5.7a1 1 0 0 1-1.3-.5l-.5-1a1 1 0 0 1 .5-1.3l2.1-1 .3-1.6c.1-.5.5-.8 1-.8z"/></svg>';
  var MIC_SVG = '<svg viewBox="0 0 24 24"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3z"/><path d="M19 11a1 1 0 1 0-2 0 5 5 0 0 1-10 0 1 1 0 1 0-2 0 7 7 0 0 0 6 6.93V20H9a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2h-2v-2.07A7 7 0 0 0 19 11z" fill="currentColor" stroke="none"/></svg>';
  var SEND_SVG = '<svg viewBox="0 0 24 24"><path d="M3 11.5L20.5 4a.8.8 0 0 1 1.1 1L14 21.5a.8.8 0 0 1-1.5-.1l-1.6-5.6-5.6-1.6a.8.8 0 0 1-.3-1.7z" fill="currentColor" stroke="none"/></svg>';

  // ---- burbuja + panel ----
  var bubble = document.createElement('button');
  bubble.className = 'bubble';
  bubble.setAttribute('aria-label', 'Abrir chat de asistencia');
  bubble.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 3C6.9 3 2.8 6.6 2.8 11c0 2.5 1.3 4.7 3.4 6.2-.1 1-.5 2.4-1.6 3.5 0 0 2.6-.2 4.7-1.7.9.2 1.8.3 2.7.3 5.1 0 9.2-3.6 9.2-8.1S17.1 3 12 3z"/></svg>';

  var badge = document.createElement('div');
  badge.className = 'badge';
  badge.textContent = '¿Necesitas ayuda?';

  var panel = document.createElement('div');
  panel.className = 'panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', TITLE);

  panel.innerHTML =
    '<div class="head">' +
      '<div class="dot">' + EXEC_SVG + '</div>' +
      '<div style="flex:1;min-width:0;"><div class="t"></div><div class="s">Responde con IA · revisa siempre la información</div></div>' +
      '<button class="hbtn" data-act="del" aria-label="Borrar conversación" title="Borrar conversación">🗑</button>' +
      '<button class="hbtn" data-act="max" aria-label="Maximizar" title="Maximizar">⛶</button>' +
      '<button class="hbtn" data-act="min" aria-label="Minimizar" title="Minimizar">—</button>' +
      '<button class="hbtn" data-act="close" aria-label="Cerrar" title="Cerrar">×</button>' +
    '</div>' +
    '<div class="msgs"></div>' +
    '<div class="inputbar">' +
      '<button class="ibtn mic" aria-label="Dictar mensaje (voz a texto)" title="Dictar mensaje (voz a texto)">' + MIC_SVG + '</button>' +
      '<textarea rows="1" placeholder="Escribe tu pregunta…"></textarea>' +
      '<button class="ibtn send" aria-label="Enviar">' + SEND_SVG + '</button>' +
    '</div>';

  panel.querySelector('.head .t').textContent = TITLE;

  var msgs = panel.querySelector('.msgs');
  var textarea = panel.querySelector('textarea');
  var sendBtn = panel.querySelector('.send');
  var micBtn = panel.querySelector('.mic');

  shadow.appendChild(style);
  shadow.appendChild(bubble);
  shadow.appendChild(badge);
  shadow.appendChild(panel);
  document.body.appendChild(host);

  // ---- apariencia del bot (feature T13) ----
  // setAvatarImage: avatar configurado (imagen del dueño) o el glifo por
  // defecto. applyAppearance: color de acento (custom property del host),
  // lado de burbuja/badge/panel y todos los avatares ya renderizados.
  // La burbuja tiene SU propio glifo (globo de chat) distinto del ejecutivo:
  // se restaura tal cual cuando no hay imagen.
  var BUBBLE_DEFAULT_HTML = bubble.innerHTML;

  function setAvatarImage(container) {
    if (AVATAR_URL) {
      var img = document.createElement('img');
      img.src = AVATAR_URL;
      img.alt = '';
      container.replaceChildren(img);
    } else {
      container.innerHTML = EXEC_SVG;
    }
  }

  function applyAppearance() {
    host.style.setProperty('--cc-accent', ACCENT);
    var right = SIDE === 'right';
    bubble.classList.toggle('right', right);
    badge.classList.toggle('right', right);
    panel.classList.toggle('right', right);

    // La burbuja flotante de la esquina conserva SIEMPRE su glifo original
    // (decisión del dueño): el avatar configurado aparece en el header y en
    // las respuestas, no aquí.
    var headDot = panel.querySelector('.head .dot');

    // Retro-aplicar a TODOS los avatares de mensajes ya renderizados: el
    // historial se pinta antes de que resuelva el fetch de config (con
    // AVATAR_URL aún vacío), así que sin esto quedan con el glifo por
    // defecto hasta el siguiente mensaje.
    var msgAvatars = panel.querySelectorAll('.msgs .row .avatar');
    for (var i = 0; i < msgAvatars.length; i++) setAvatarImage(msgAvatars[i]);
  }

  // ---- helpers de texto seguro ----
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&' + 'amp;')
      .replace(/</g, '&' + 'lt;')
      .replace(/>/g, '&' + 'gt;')
      .replace(/"/g, '&' + 'quot;')
      .replace(/'/g, '&' + '#39;');
  }

  function mdInline(s) {
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]*)\)/g, function (m, t, u) {
      return '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + t + '</a>';
    });
    // Bare URLs -> clickable, new window (escaped text, so only safe chars).
    s = s.replace(/(^|[\s(])((?:https?:\/\/)[^\s<)"']+)/g, function (m, pre, u) {
      return pre + '<a href="' + u + '" target="_blank" rel="noopener noreferrer" style="word-break:break-all;">' + u + '</a>';
    });
    // Chilean phone numbers -> WhatsApp (wa.me), never inside a longer number.
    s = s.replace(/(^|[^\d.\w])(\+?56[\s.-]?)?(9[\s.-]?\d{4}[\s.-]?\d{4})(?!\d)/g, function (m, pre, cc, num) {
      var digits = String(num).replace(/\D/g, '');
      if (digits.length < 9 || digits.length > 11) return m;
      var wa = digits.indexOf('56') === 0 ? digits : '56' + digits;
      return pre + '<a href="https://wa.me/' + wa + '" target="_blank" rel="noopener noreferrer" style="color:#16a34a;text-decoration:underline;">' + num + '</a>';
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,;:!?)~]|$)/g, '$1<em>$2</em>');
    s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    return s;
  }

  // Etiquetas numeradas (T11): cada enlace de página web de una respuesta se
  // lee "enlace N" (N = orden de aparición, se reinicia por mensaje). El
  // href NUNCA se reescribe (el listener del modal de video lo lee) y title
  // conserva la URL original (comillas blindadas por si acaso; el texto ya
  // viene escapado por el paso escape-first). Excepción: wa.me conserva el
  // número como texto — es un atajo de contacto, no un enlace a un documento
  // — y no consume número. Se numera el HTML armado (una sola pasada, en
  // orden de aparición real), porque mdInline convierte primero los enlaces
  // markdown y después las URLs sueltas: un contador dentro de esas pasadas
  // numeraría mal cuando ambas conviven en una misma línea.
  function numberWebLinks(html) {
    var n = 0;
    return String(html).replace(/(<a\s[^>]*?href="([^"]*)"[^>]*>)([^<]*)<\/a>/g, function (m, open, href) {
      if (href.indexOf('https://wa.me/') === 0) return m; // teléfono: texto actual
      n += 1;
      return open.slice(0, -1) + ' title="' + href.replace(/"/g, '&' + 'quot;') + '">enlace ' + n + '</a>';
    });
  }

  function renderMd(raw, isUserMessage) {
    var lines = String(raw == null ? '' : raw).split(/\r?\n/);
    var out = [];
    var list = null;
    var para = null;
    function closeList() { if (list) { out.push('</' + list + '>'); list = null; } }
    function closePara() { if (para !== null) { out.push('<p>' + para + '</p>'); para = null; } }
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].trim();
      if (t === '') { closePara(); closeList(); continue; }
      var h = t.match(/^#{1,4}\s+(.*)$/);
      var b = t.match(/^[-•]\s+(.*)$/);
      var o = t.match(/^(\d{1,2})[.)]\s+(.*)$/);
      if (h) { closePara(); closeList(); out.push('<p><strong>' + mdInline(esc(h[1])) + '</strong></p>'); continue; }
      if (b || o) {
        closePara();
        var kind = b ? 'ul' : 'ol';
        if (list !== kind) { closeList(); out.push('<' + kind + '>'); list = kind; }
        out.push('<li>' + mdInline(esc(b ? b[1] : o[2])) + '</li>');
        continue;
      }
      closeList();
      var seg = mdInline(esc(t));
      para = para === null ? seg : para + '<br>' + seg;
    }
    closePara(); closeList();
    var html = out.join('');
    // El mensaje del USUARIO se muestra tal cual lo escribió: la numeración
    // "enlace N" es para las respuestas del asistente.
    return isUserMessage ? html : numberWebLinks(html);
  }

  function hasMd(raw) {
    return /(\*\*[^*]+\*\*|`[^`\n]+`|^\s*#{1,4}\s|^\s*[-•]\s|^\s*\d{1,2}[.)]\s|\[[^\]]+\]\((?:https?:\/\/|\/)[^\s)]*\))/m.test(String(raw || ''));
  }

  // URL suelta o teléfono chileno: merece render con <a> aunque no haya markdown.
  function hasLinks(raw) {
    return /((?:https?:\/\/)[^\s<)"']+|(^|[^\d.\w])(\+?56[\s.-]?)?(9[\s.-]?\d{4}[\s.-]?\d{4})(?!\d))/m.test(String(raw || ''));
  }

  // ---- Escuchar (TTS del navegador, gratuito y offline) ----
  // MECÁNICA: play = modo automático. Se habla esa respuesta y TODAS las
  // siguientes hasta presionar stop (mismo botón, icono cambia a stop).
  // Sin volver a pinchar play por cada respuesta del bot.
  var ttsAutoplay = false;

  function cleanForSpeech(text) {
    return String(text || '')
      .replace(/\[([^\]]+)\]\((?:https?:\/\/[^\s)]+|\/[^\s)]*)\)/g, '$1')
      .replace(/https?:\/\/[^\s]+/g, 'enlace')
      .replace(/\*\*/g, '').replace(/`/g, '')
      .replace(/^#{1,4}\s+/gm, '')
      .trim();
  }

  function pickBestVoice() {
    if (!window.speechSynthesis) return null;
    var voices = speechSynthesis.getVoices() || [];
    if (VOICE_PREF) {
      var want = VOICE_PREF.split('|');
      for (var p = 0; p < voices.length; p++) {
        if (voices[p].name === want[0] && (!want[1] || voices[p].lang === want[1])) return voices[p];
      }
    }
    var es = voices.filter(function (v) { return v.lang && v.lang.toLowerCase().indexOf('es') === 0; });
    if (es.length === 0) return null;
    es.sort(function (a, b) {
      var score = function (v) {
        var n = v.name.toLowerCase(), s = 0;
        if (n.indexOf('natural') >= 0 || n.indexOf('online') >= 0) s += 100;
        if (n.indexOf('google') >= 0) s += 80;
        if (n.indexOf('microsoft') >= 0) s += 60;
        if (/es-cl|es-419|es-mx|es-ar|es-co/.test(v.lang.toLowerCase())) s += 20;
        if (v.localService) s += 5;
        return s;
      };
      return score(b) - score(a);
    });
    return es[0];
  }

  function ttsScope(btn) {
    try {
      var root = btn.getRootNode();
      if (root && root.querySelectorAll) return root;
    } catch (_) { /* detached */ }
    return document;
  }

  function setTtsIcons(scope, playing) {
    var btns = (scope || document).querySelectorAll('.tts-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].innerHTML = playing ? STOP_SVG : PLAY_SVG;
      btns[i].title = playing ? 'Detener' : 'Escuchar mensaje';
      if (!playing) btns[i].classList.remove('speaking');
    }
  }

  function speakBubble(btn, answerText) {
    if (!window.speechSynthesis) return;
    // SOLO la respuesta del LLM: nunca narrar fuentes ni créditos.
    var clean = cleanForSpeech(answerText);
    if (clean === '') return;
    var utter = new SpeechSynthesisUtterance(clean);
    var voice = pickBestVoice();
    if (voice) utter.voice = voice;
    utter.lang = (voice && voice.lang) || 'es-CL';
    utter.rate = 1;
    utter.onend = function () {
      // En autoplay el icono queda en stop: la próxima respuesta se habla sola.
      if (btn && !ttsAutoplay) btn.classList.remove('speaking');
    };
    utter.onerror = function () {
      if (btn) btn.classList.remove('speaking');
    };
    if (btn) btn.classList.add('speaking');
    speechSynthesis.speak(utter);
  }

  function buildTtsButton(bubble, text) {
    if (!TTS_ON) return null; // el dueño apagó la voz en su panel
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tts-btn';
    btn.innerHTML = ttsAutoplay ? STOP_SVG : PLAY_SVG;
    btn.title = ttsAutoplay ? 'Detener' : 'Escuchar mensaje';
    btn.setAttribute('aria-label', 'Audio de la respuesta');
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (!window.speechSynthesis) return;
      if (ttsAutoplay) {
        // STOP: silencia todo y sale del modo automático.
        ttsAutoplay = false;
        speechSynthesis.cancel();
        setTtsIcons(ttsScope(btn), false);
        return;
      }
      // PLAY: habla esta respuesta y las siguientes automáticamente.
      ttsAutoplay = true;
      setTtsIcons(ttsScope(btn), true);
      speakBubble(btn, text);
    });
    return btn;
  }

  // ---- persistencia de la conversación (por visitante) ----
  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(HOST_KEY) || '[]'); } catch (_) { return []; }
  }

  function saveTurn(role, text, extra) {
    try {
      var h = loadHistory();
      h.push({ role: role, text: text, ts: Date.now() });
      while (h.length > HISTORY_LIMIT) h.shift();
      localStorage.setItem(HOST_KEY, JSON.stringify(h));
    } catch (_) { /* storage lleno/bloqueado: la sesión sigue en memoria */ }
  }

  function clearHistory() {
    try { localStorage.removeItem(HOST_KEY); } catch (_) { /* no crítico */ }
  }

  // ---- render ----
  function addMsg(role, text, opts) {
    opts = opts || {};
    var row = document.createElement('div');
    row.className = 'row' + (role === 'user' ? ' own' : '');

    if (role !== 'user') {
      var av = document.createElement('div');
      av.className = 'avatar';
      av.setAttribute('aria-hidden', 'true');
      setAvatarImage(av);
      row.appendChild(av);
    }

    var el = document.createElement('div');
    el.className = 'msg ' + (role === 'user' ? 'user' : 'bot');
    if (role === 'user' || !hasMd(text)) {
      if (role !== 'user' && hasLinks(text)) {
        el.innerHTML = renderMd(text); // escape-first: solo URLs/teléfonos se vuelven <a>
      } else {
        el.textContent = text;
      }
    } else {
      el.innerHTML = renderMd(text, role === 'user'); // escape-first: ver contrato arriba; el usuario mantiene su texto
    }
    if (opts.sources && opts.sources.length) {
      var src = document.createElement('div');
      src.className = 'src';
      var names = [];
      for (var i = 0; i < Math.min(opts.sources.length, 3); i++) {
        var s = opts.sources[i];
        names.push('• ' + (s && (s.title || 'documento')));
      }
      src.textContent = names.join('  ');
      el.appendChild(src);
    }
    if (typeof opts.credits === 'number' && opts.credits > 0) {
      var cost = document.createElement('div');
      cost.className = 'cost';
      cost.textContent = 'Consumo de esta respuesta: ' + opts.credits + ' crédito' + (opts.credits === 1 ? '' : 's');
      el.appendChild(cost);
    }
    if (role !== 'user') {
      var ttsBtn = buildTtsButton(el, text);
      if (ttsBtn) {
        el.appendChild(ttsBtn);
        if (ttsAutoplay) speakBubble(ttsBtn, text); // modo activo: la nueva respuesta se habla sola
      }
    }
    row.appendChild(el);
    msgs.appendChild(row);
    msgs.scrollTop = msgs.scrollHeight;
    return el;
  }

  function typingRow() {
    var row = document.createElement('div');
    row.className = 'row';
    var av = document.createElement('div');
    av.className = 'avatar';
    setAvatarImage(av);
    var el = document.createElement('div');
    el.className = 'msg bot';
    el.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
    row.appendChild(av);
    row.appendChild(el);
    msgs.appendChild(row);
    msgs.scrollTop = msgs.scrollHeight;
    return row;
  }

  // ---- enlaces de video en los mensajes: modal sobre el chat ----
  // YouTube/Vimeo dentro de una respuesta se abren AQUÍ (reproductor
  // embebido), nunca navegando fuera. Otros enlaces conservan su
  // comportamiento actual (pestaña nueva). Lista chica a propósito: para
  // sumar otra plataforma basta agregar una entrada (re + build).
  var VIDEO_PROVIDERS = [
    { re: /^https?:\/\/(?:www\.|m\.)?youtube\.com\/watch\?(?:[^#]*&)?v=([A-Za-z0-9_-]{5,40})(?:[&#]|$)/i,
      build: function (id) { return 'https://www.youtube-nocookie.com/embed/' + id + '?autoplay=1&rel=0'; } },
    { re: /^https?:\/\/(?:www\.)?youtu\.be\/([A-Za-z0-9_-]{5,40})(?:[?&#]|$)/i,
      build: function (id) { return 'https://www.youtube-nocookie.com/embed/' + id + '?autoplay=1&rel=0'; } },
    { re: /^https?:\/\/(?:www\.|m\.)?youtube\.com\/shorts\/([A-Za-z0-9_-]{5,40})(?:[?&#]|$)/i,
      build: function (id) { return 'https://www.youtube-nocookie.com/embed/' + id + '?autoplay=1&rel=0'; } },
    { re: /^https?:\/\/(?:www\.)?vimeo\.com\/(\d{6,15})(?:[?&#]|$)/i,
      build: function (id) { return 'https://player.vimeo.com/video/' + id + '?autoplay=1'; } }
  ];

  function videoEmbedUrl(href) {
    var u = String(href || '');
    for (var i = 0; i < VIDEO_PROVIDERS.length; i++) {
      var m = u.match(VIDEO_PROVIDERS[i].re);
      if (m) return VIDEO_PROVIDERS[i].build(m[1]);
    }
    return null;
  }

  var videoModal = null; // { backdrop, lastFocus } mientras esté abierto

  function onVideoKeydown(e) {
    if (e.key === 'Escape' && videoModal) { e.stopPropagation(); closeVideoModal(); }
  }

  function openVideoModal(embedUrl) {
    closeVideoModal(); // nunca dos a la vez
    var backdrop = document.createElement('div');
    backdrop.className = 'vmodal';
    var box = document.createElement('div');
    box.className = 'vbox';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', 'Video');
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'vclose';
    close.setAttribute('aria-label', 'Cerrar video');
    close.textContent = '×';
    var frame = document.createElement('iframe');
    frame.src = embedUrl;
    frame.title = 'Video';
    frame.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen');
    frame.setAttribute('allowfullscreen', '');
    frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation allow-popups');
    box.appendChild(close);
    box.appendChild(frame);
    backdrop.appendChild(box);
    shadow.appendChild(backdrop);
    videoModal = { backdrop: backdrop, lastFocus: shadow.activeElement || document.activeElement };
    close.focus();
    close.addEventListener('click', closeVideoModal);
    backdrop.addEventListener('click', function (e) { if (e.target === backdrop) closeVideoModal(); });
    document.addEventListener('keydown', onVideoKeydown, true);
  }

  function closeVideoModal() {
    if (!videoModal) return;
    document.removeEventListener('keydown', onVideoKeydown, true);
    videoModal.backdrop.remove(); // quitar el iframe del DOM detiene la reproducción
    var back = videoModal.lastFocus;
    videoModal = null;
    if (back && typeof back.focus === 'function') { try { back.focus(); } catch (_) { /* separado */ } }
  }

  // UN solo listener delegado en el contenedor de mensajes: los mensajes se
  // agregan dinámicamente, así que nunca se ata un listener por ancla.
  msgs.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a || !msgs.contains(a)) return;
    var embed = videoEmbedUrl(a.getAttribute('href'));
    if (!embed) return; // documentos y otros sitios: comportamiento actual
    e.preventDefault();
    openVideoModal(embed);
  });

  function friendly(status, payload) {
    var m = payload && payload.error && typeof payload.error.message === 'string' ? payload.error.message : '';
    if (status === 402) return m || 'El dueño de este asistente no tiene saldo para responder en este momento.';
    if (status === 429) return m || 'Demasiadas preguntas seguidas: espera un momento e inténtalo de nuevo.';
    if (status === 503) return m || 'El asistente no está disponible en este instante. Prueba en unos minutos.';
    return 'No pudimos generar una respuesta ahora. Inténtalo nuevamente en unos minutos: no se te cobró nada.';
  }

  // ---- voz a texto (mismo patrón del chat principal) ----
  var recognition = null;
  var isRecording = false;

  function stopRecording() {
    if (!isRecording) return;
    isRecording = false;
    micBtn.classList.remove('rec');
    micBtn.setAttribute('aria-label', 'Dictar mensaje (voz a texto)');
    micBtn.title = 'Dictar mensaje (voz a texto)';
    textarea.placeholder = 'Escribe tu pregunta…';
    if (recognition) {
      try { recognition.stop(); } catch (_) { /* ignorar */ }
    }
  }

  function initSpeechRecognition() {
    if (typeof window.SpeechRecognition === 'undefined' && typeof window.webkitSpeechRecognition === 'undefined') {
      micBtn.disabled = true;
      micBtn.style.opacity = '.4';
      micBtn.title = 'Voz a texto no soportado en este navegador';
      return;
    }
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new SR();
    recognition.lang = 'es-CL';
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = function () {
      isRecording = true;
      micBtn.classList.add('rec');
      micBtn.setAttribute('aria-label', 'Grabando… click para detener');
      textarea.placeholder = 'Escuchando…';
    };
    recognition.onresult = function (event) {
      var transcript = '';
      for (var i = event.resultIndex; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      textarea.value = transcript;
    };
    recognition.onerror = function (event) {
      if (event.error === 'not-allowed') {
        addMsg('assistant', 'Permiso de micrófono denegado: habilítalo en tu navegador para dictar.');
        saveTurn('assistant', 'Permiso de micrófono denegado: habilítalo en tu navegador para dictar.');
      }
      stopRecording();
    };
    recognition.onend = function () { stopRecording(); };
  }

  function toggleRecording() {
    if (isRecording) { stopRecording(); return; }
    if (!recognition) initSpeechRecognition();
    if (!recognition || recognition.state === 'recording') return;
    try {
      textarea.value = '';
      textarea.placeholder = 'Escuchando…';
      recognition.start();
    } catch (_) { /* ya iniciado */ }
  }

  // ---- envío ----
  var busy = false;

  // ---- pausa amable (429, feature: visitor-guard) ----
  // Un bloqueo o límite NO es un error del visitante: el mensaje del bot
  // explica el porqué con calidez y el input descansa solo, sin que nadie
  // tenga que hacer nada. Pasados los minutos indicados se reactiva solo.
  var inputPaused = false;
  var pauseTimer = null;
  var NORMAL_PLACEHOLDER = 'Escribe tu pregunta…';

  function pauseInput(minutes) {
    var mins = Math.max(1, Math.min(1440, Math.floor(Number(minutes) || 1)));
    inputPaused = true;
    textarea.disabled = true;
    sendBtn.disabled = true;
    textarea.placeholder = mins === 1
      ? 'El chat toma un descanso de 1 minuto. ¡Vuelve luego!'
      : 'El chat toma un descanso de ' + mins + ' minutos. ¡Vuelve luego!';
    if (pauseTimer) clearTimeout(pauseTimer);
    pauseTimer = setTimeout(function () {
      inputPaused = false;
      textarea.disabled = false;
      sendBtn.disabled = false;
      textarea.placeholder = NORMAL_PLACEHOLDER;
      textarea.focus();
    }, mins * 60 * 1000);
  }

  // Hilo para el backend (feature: panel-chat-cross-heart): el visitante
  // anónimo no tiene persistencia server-side, así que el widget envía sus
  // últimos turnos como contexto de conversación. Se excluye el turno actual
  // (la pregunta ya viaja aparte) y se recorta cada contenido; el servidor
  // re-valida todo de todas formas.
  function buildThreadHistory() {
    var turns = [];
    var saved = loadHistory();
    var start = Math.max(0, saved.length - 6);
    for (var i = start; i < saved.length; i++) {
      var m = saved[i];
      var text = String(m && m.text != null ? m.text : '').slice(0, 800);
      if (text === '') continue;
      turns.push({ role: m.role === 'user' ? 'user' : 'assistant', content: text });
    }
    return turns;
  }

  function send() {
    var q = textarea.value.trim();
    if (q === '' || busy || inputPaused) return;
    busy = true;
    sendBtn.disabled = true;
    stopRecording();
    var threadHistory = buildThreadHistory();
    addMsg('user', q);
    saveTurn('user', q);
    textarea.value = '';
    var ty = typingRow();

    fetch(API_BASE + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'omit', // anónimo por diseño: sin cookies del sitio anfitrión
      body: JSON.stringify(Object.assign(
        { question: q, heart: HEART },
        threadHistory.length ? { history: threadHistory } : {},
        VISITOR_ID ? { visitor_id: VISITOR_ID } : {},
        OWNER ? { rag_owner: OWNER } : {},
        SOURCE_IDS.length ? { rag_sources: SOURCE_IDS } : {}
      ))
    }).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (j) { return { status: r.status, json: j }; });
    }).then(function (res) {
      ty.remove();
      var d = res.json && res.json.data;
      if (res.status === 200 && res.json && res.json.success && d && typeof d.answer === 'string') {
        addMsg('assistant', d.answer, { sources: d.sources || [], credits: d.credits_charged });
        saveTurn('assistant', d.answer);
      } else if (res.status === 429) {
        // Pausa amable (visitor-guard / límite de mensajes): burbuja normal
        // del bot, no roja — es un descanso explicado, no un error. El
        // mensaje del servidor ya explica el porqué con calidez.
        var pauseMsg = res.json && res.json.error && typeof res.json.error.message === 'string'
          ? res.json.error.message
          : 'El chat toma un breve descanso para cuidar la calidad de las respuestas. Inténtalo de nuevo en unos minutos.';
        addMsg('assistant', pauseMsg);
        saveTurn('assistant', pauseMsg);
        var mins = res.json && res.json.error && res.json.error.retry_after_minutes;
        pauseInput(typeof mins === 'number' ? mins : 1);
      } else {
        var msg = friendly(res.status, res.json);
        addMsg('assistant', msg, { error: true });
        var el = msgs.lastElementChild && msgs.lastElementChild.querySelector('.msg');
        if (el) el.classList.add('err');
        saveTurn('assistant', msg);
      }
    }).catch(function () {
      ty.remove();
      addMsg('assistant', 'No pudimos conectar con el asistente: revisa tu conexión e inténtalo de nuevo.');
      saveTurn('assistant', 'No pudimos conectar con el asistente: revisa tu conexión e inténtalo de nuevo.');
    }).finally(function () {
      busy = false;
      if (!inputPaused) { // en pausa el input se reactiva solo, más tarde
        sendBtn.disabled = false;
        textarea.focus();
      }
    });
  }

  // ---- ventana: minimizar / maximizar / cerrar ----
  var maximized = false;

  function saveWinState() {
    try { localStorage.setItem(STATE_KEY, JSON.stringify({ open: opened, max: maximized })); } catch (_) { /* no crítico */ }
  }

  function open() {
    panel.classList.add('open');
    bubble.setAttribute('aria-expanded', 'true');
    if (msgs.children.length === 0) restoreOrWelcome();
    textarea.focus();
    saveWinState();
  }

  function minimize() {
    panel.classList.remove('open', 'max');
    maximized = false;
    panel.querySelector('[data-act="max"]').textContent = '⛶';
    bubble.setAttribute('aria-expanded', 'false');
    saveWinState();
  }

  function toggleMax() {
    maximized = !maximized;
    panel.classList.toggle('max', maximized);
    panel.querySelector('[data-act="max"]').textContent = maximized ? '⤡' : '⛶';
    panel.querySelector('[data-act="max"]').setAttribute('aria-label', maximized ? 'Restaurar tamaño' : 'Maximizar');
    saveWinState();
  }

  // borrar conversación: confirmación en dos pasos (sin confirm() nativo)
  var delArmed = false;
  var delTimer = null;

  function handleDelete(btn) {
    if (!delArmed) {
      delArmed = true;
      btn.classList.add('confirm');
      btn.textContent = '¿Borrar?';
      delTimer = setTimeout(function () { disarmDelete(btn); }, 3000);
      return;
    }
    disarmDelete(btn);
    clearHistory();
    msgs.replaceChildren();
    addMsg('assistant', WELCOME);
    saveTurn('assistant', WELCOME);
  }

  function disarmDelete(btn) {
    delArmed = false;
    clearTimeout(delTimer);
    btn.classList.remove('confirm');
    btn.textContent = '🗑';
  }

  // ---- restaurar / bienvenida ----
  function restoreOrWelcome() {
    var saved = loadHistory();
    if (saved.length === 0) {
      addMsg('assistant', WELCOME);
      return;
    }
    for (var i = 0; i < saved.length; i++) {
      var m = saved[i];
      if (m && m.text) addMsg(m.role === 'user' ? 'user' : 'assistant', m.text);
    }
  }

  // ---- interacción ----
  var opened = false;

  function toggle(openIt) {
    opened = typeof openIt === 'boolean' ? openIt : !opened;
    if (opened) { open(); } else { minimize(); }
  }

  bubble.addEventListener('click', function () { toggle(); });
  panel.querySelector('[data-act="min"]').addEventListener('click', function () { toggle(false); });
  panel.querySelector('[data-act="close"]').addEventListener('click', function () { toggle(false); });
  panel.querySelector('[data-act="max"]').addEventListener('click', function () { toggleMax(); });
  panel.querySelector('[data-act="del"]').addEventListener('click', function () { handleDelete(this); });
  sendBtn.addEventListener('click', send);
  micBtn.addEventListener('click', toggleRecording);
  textarea.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  shadow.appendChild; // no-op guard

  // ---- availability gate ----
  // GAP (MIGRATION.md): the unified API has NO availability-probe route
  // (the legacy /api/corporate-chat-status.php is gone), so the bubble is
  // always shown. The owner's balance is enforced at the first message:
  // the turn answers with the kind 402 message and the widget shows it.

  // ---- self-config de la voz (feature: embed-rag-config) ----
  // La DB manda por owner+heart: el snippet ya no lleva la voz. Best-effort
  // y sin bloquear: si un mensaje pide hablar antes de que resuelva, usa el
  // respaldo del snippet (o defaults) y la config aplica desde el SIGUIENTE
  // mensaje. Timeout corto con AbortController para nunca quedar colgados.
  (function () {
    if (typeof AbortController === 'undefined') return; // sin AbortController no hay timeout seguro; el fetch relativo (data-api-base vacío) funciona igual que el chat
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 2500);
    fetch(API_BASE + '/rag/embed-config?heart=' + encodeURIComponent(HEART) + (OWNER ? '&owner=' + encodeURIComponent(OWNER) : ''), {
      credentials: 'omit',
      signal: ctrl.signal
    }).then(function (r) { return r.json().catch(function () { return null; }); }).then(function (j) {
      clearTimeout(timer);
      if (j && j.success && j.data) {
        TTS_ON = j.data.tts_enabled !== false; // booleano; false apaga la voz
        VOICE_PREF = typeof j.data.voice === 'string' ? j.data.voice : ''; // '' = automática
        // Apariencia (feature T13): la DB manda; el atributo del snippet
        // queda de respaldo. Valores inválidos/ausentes = defaults actuales.
        if (typeof j.data.accent_color === 'string' && /^#[0-9a-fA-F]{6}$/.test(j.data.accent_color)) {
          ACCENT = j.data.accent_color;
        }
        if (j.data.position === 'left' || j.data.position === 'right') {
          SIDE = j.data.position;
        }
        if (typeof j.data.avatar_url === 'string' && j.data.avatar_url !== '') {
          // The API answers with a root-relative path on ITS host: prefix
          // the API origin so the image resolves from any page.
          AVATAR_URL = /^https?:\/\//i.test(j.data.avatar_url) || j.data.avatar_url.charAt(0) !== '/'
            ? j.data.avatar_url
            : API_BASE + j.data.avatar_url;
        }
        applyAppearance();
      }
    }).catch(function () {
      clearTimeout(timer); // respaldo: atributos del snippet o defaults
    });
  })();

  // Restaurar el estado de ventana: si estaba abierto (o maximizado)
  // antes del refresh, vuelve tal cual — no se reinicia minimizado.
  try {
    var savedWin = JSON.parse(localStorage.getItem(STATE_KEY) || 'null');
    if (savedWin && savedWin.open) {
      opened = true;
      panel.classList.add('open');
      bubble.setAttribute('aria-expanded', 'true');
      restoreOrWelcome();
      if (savedWin.max) { maximized = true; panel.classList.add('max'); panel.querySelector('[data-act="max"]').textContent = '⤡'; }
      textarea.focus();
    }
  } catch (_) { /* storage bloqueado: arranca minimizado, no es crítico */ }

  // Badge de invitación una vez por carga (suave, sin persistencia).
  setTimeout(function () { if (!opened) badge.classList.add('show'); }, 2500);
  setTimeout(function () { badge.classList.remove('show'); }, 12000);
})();
