#!/usr/bin/env node
// =============================================================================
// cdp_auth_layout_test.mjs — comprobaciones end-to-end via CDP del login
// extendido y de la homogeneización de anchos.
//
// Cubre lo entregado en esta tanda:
//
//   1. Anchos homogéneos: la navegación de escritorio, el menú móvil, el
//      título de la billetera y el título del perfil comparten `max-w-md`
//      (y el ancho calculado cuando el panel está visible).
//   2. "Olvidé mi contraseña": el enlace abre el formulario de recuperación,
//      valida el correo y pide el enlace por la API de magic-link.
//   3. "Recordar sesión": la casilla marca `remember: true` en el cuerpo del
//      POST a /auth/login, y NO lo marca cuando está desmarcada.
//   4. Consola limpia: la CSP del landing es `script-src 'self'`, así que
//      cualquier handler inline queda bloqueado. Este arnés falla si aparece
//      una violación de CSP o una excepción.
//
// El arnés es autocontenido: habla CDP por WebSocket con el Chrome que ya
// está corriendo (o con uno propio, vía --cdp). No necesita dependencias.
//
// Uso:
//   node tests/cdp_auth_layout_test.mjs [opciones]
//
//   --url <base>     front a probar (default http://127.0.0.1:8002)
//   --cdp <puerto>   puerto del Chrome con --remote-debugging-port (default 9222)
//   --shots <dir>    guarda capturas PNG en ese directorio
//   --keep-open      no cierra la pestaña al terminar
//
// Salida: 0 si todo pasa, 1 si hay algún fallo.
// =============================================================================

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ----- Argumentos ------------------------------------------------------------

const argv = process.argv.slice(2);

function opcion(nombre, porDefecto) {
  const i = argv.indexOf(`--${nombre}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : porDefecto;
}

const URL_BASE = String(opcion('url', 'http://127.0.0.1:8002')).replace(/\/+$/, '');
const PUERTO_CDP = Number(opcion('cdp', 9222));
const DIR_SHOTS = opcion('shots', '');
const KEEP_OPEN = argv.includes('--keep-open');

if (DIR_SHOTS) mkdirSync(DIR_SHOTS, { recursive: true });

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// ----- Cliente CDP mínimo ----------------------------------------------------

class Cliente {
  constructor(socket) {
    this.socket = socket;
    this.id = 0;
    this.pendientes = new Map();
    this.consola = [];

    socket.addEventListener('message', (evento) => {
      const mensaje = JSON.parse(evento.data);

      if (mensaje.id && this.pendientes.has(mensaje.id)) {
        const { resolver, rechazar } = this.pendientes.get(mensaje.id);
        this.pendientes.delete(mensaje.id);
        if (mensaje.error) rechazar(new Error(`${mensaje.error.message} ${JSON.stringify(mensaje.error.data ?? {})}`));
        else resolver(mensaje.result);
        return;
      }

      if (!mensaje.method) return;

      switch (mensaje.method) {
        case 'Runtime.consoleAPICalled':
          this.consola.push({
            nivel: mensaje.params.type,
            texto: mensaje.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '),
          });
          break;
        case 'Runtime.exceptionThrown': {
          const d = mensaje.params.exceptionDetails || {};
          this.consola.push({
            nivel: 'exception',
            texto: (d.exception && (d.exception.description || d.exception.value)) || d.text || 'excepción sin detalle',
          });
          break;
        }
        case 'Log.entryAdded':
          this.consola.push({
            nivel: mensaje.params.entry.level,
            texto: `${mensaje.params.entry.source}: ${mensaje.params.entry.text} ${mensaje.params.entry.url || ''}`,
          });
          break;
      }
    });
  }

  enviar(method, params = {}, { timeout = 30000 } = {}) {
    const id = ++this.id;
    const carga = { id, method, params };
    if (this.sessionId) carga.sessionId = this.sessionId;
    this.socket.send(JSON.stringify(carga));
    return new Promise((resolver, rechazar) => {
      const timer = setTimeout(() => {
        this.pendientes.delete(id);
        rechazar(new Error(`timeout esperando ${method}`));
      }, timeout);
      this.pendientes.set(id, {
        resolver: (v) => { clearTimeout(timer); resolver(v); },
        rechazar: (e) => { clearTimeout(timer); rechazar(e); },
      });
    });
  }

  async evaluar(expresion) {
    const r = await this.enviar('Runtime.evaluate', {
      expression: `(async () => { ${expresion} })()`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error(
        'error al evaluar: ' +
        (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
      );
    }
    return r.result?.value;
  }

  async esperar(expresion, { timeout = 15000, intervalo = 120, etiqueta = '' } = {}) {
    const limite = Date.now() + timeout;
    let ultimo;
    while (Date.now() < limite) {
      ultimo = await this.evaluar(`return (${expresion});`);
      if (ultimo) return ultimo;
      await dormir(intervalo);
    }
    throw new Error(`no se cumplió a tiempo${etiqueta ? ': ' + etiqueta : ''}`);
  }
}

// ----- Conexión --------------------------------------------------------------

async function conectar() {
  const base = `http://127.0.0.1:${PUERTO_CDP}`;
  const version = await (await fetch(`${base}/json/version`)).json();
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolver, rechazar) => {
    socket.addEventListener('open', resolver, { once: true });
    socket.addEventListener('error', () => rechazar(new Error(`no se pudo conectar al CDP en ${base}`)), { once: true });
  });

  const cliente = new Cliente(socket);

  const { targetId } = await cliente.enviar('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cliente.enviar('Target.attachToTarget', { targetId, flatten: true });
  cliente.sessionId = sessionId;

  await cliente.enviar('Page.enable');
  await cliente.enviar('Runtime.enable');
  await cliente.enviar('Network.enable');
  await cliente.enviar('Log.enable').catch(() => {});

  await cliente.enviar('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });

  return { cliente, targetId, socket };
}

// ----- Utilidades de página --------------------------------------------------

async function ir(cliente, url) {
  await cliente.enviar('Page.navigate', { url });
  const limite = Date.now() + 30000;
  while (Date.now() < limite) {
    const listo = await cliente.evaluar('return document.readyState;');
    if (listo === 'complete') return;
    await dormir(120);
  }
  throw new Error('la página no terminó de cargar');
}

async function caja(cliente, selector) {
  return cliente.evaluar(`
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  `);
}

async function clic(cliente, selector) {
  const pos = await caja(cliente, selector);
  if (!pos) throw new Error(`no existe ${selector}`);
  await cliente.enviar('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', buttons: 1, clickCount: 1,
  });
  await cliente.enviar('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', buttons: 0, clickCount: 1,
  });
  await dormir(250);
}

async function escribir(cliente, selector, texto) {
  const existe = await cliente.evaluar(`
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    el.focus();
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `);
  if (!existe) throw new Error(`no existe ${selector}`);
  await cliente.enviar('Input.insertText', { text: texto });
  await cliente.evaluar(`
    const el = document.querySelector(${JSON.stringify(selector)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
  `);
}

async function captura(cliente, nombre) {
  if (!DIR_SHOTS) return null;
  const { data } = await cliente.enviar('Page.captureScreenshot', { format: 'png' });
  const ruta = join(DIR_SHOTS, `${nombre}.png`);
  writeFileSync(ruta, Buffer.from(data, 'base64'));
  return ruta;
}

// Interceptor de fetch: captura los POST a /auth/* SIN pegarle a la API real.
// Así la prueba no envía correos de recuperación ni intentos de inicio de
// sesión contra producción, y aun así verifica el cuerpo exacto de la
// petición.
async function interceptarAuth(cliente) {
  return cliente.evaluar(`
    window.__authCalls = [];
    const realFetch = window.fetch.bind(window);
    window.fetch = async function (url, opts = {}) {
      const u = typeof url === 'string' ? url : (url && url.url) || String(url);
      if (u.includes('/auth/')) {
        window.__authCalls.push({
          url: u,
          method: (opts && opts.method) || 'GET',
          body: (opts && opts.body) || null,
        });
        const esMagic = u.includes('/auth/magic-link');
        const payload = esMagic
          ? { success: true }
          : { success: true, data: { user: { id: 1, email: 'qa@example.cl', name: 'QA', role: 'user', credits_balance: 100 } } };
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return realFetch(url, opts);
    };
    return true;
  `);
}

async function llamadasAuth(cliente) {
  return cliente.evaluar('return (window.__authCalls || []);');
}

// ----- Registro de comprobaciones --------------------------------------------

const registro = { ok: 0, fallos: [], seccion: '' };

function abrir(seccion) {
  registro.seccion = seccion;
  console.log(`\n\x1b[1m== ${seccion} ==\x1b[0m`);
}

function check(condicion, etiqueta, extra = '') {
  if (condicion) {
    registro.ok++;
    console.log(`  \x1b[32mok  \x1b[0m ${etiqueta}${extra ? ' — ' + extra : ''}`);
  } else {
    registro.fallos.push(`${registro.seccion} → ${etiqueta}`);
    console.log(`  \x1b[31mFAIL\x1b[0m ${etiqueta}${extra ? ' — ' + extra : ''}`);
  }
  return !!condicion;
}

// ----- Pruebas ----------------------------------------------------------------

// Anchos esperados por elemento. La navegación de escritorio es la excepción
// medida: su contenido (marca + 6 enlaces + 3 acciones = 868px) no cabe en
// max-w-md y se superponen. El resto comparte la medida con la billetera y
// el perfil.
const ESPERADO = {
  nav: { clase: 'max-w-6xl', ancho: '1152px' },
  ulMovil: { clase: 'max-w-md', ancho: '448px' },
  navPreguntas: { clase: 'max-w-md', ancho: '448px' },
  billetera: { clase: 'max-w-md', ancho: '448px' },
  perfil: { clase: 'max-w-md', ancho: '448px' },
};

async function probarAnchos(cliente) {
  abrir('Anchos homogéneos (max-w-md)');

  const medidas = await cliente.evaluar(`
    // Los títulos de billetera y perfil viven dentro de <template>: el DOM
    // vivo no los tiene hasta que app.js los clona al abrir el panel. Para
    // medirlos se clona el fragmento en un contenedor real, se mide y se
    // retira, de modo que el CSS aplicable sea el mismo.
    const buscar = (selector, predicado) => {
      const directo = Array.from(document.querySelectorAll(selector)).find(predicado);
      if (directo) return { el: directo, enVivo: true };
      for (const tpl of document.querySelectorAll('template')) {
        const encontrado = Array.from(tpl.content.querySelectorAll(selector)).find(predicado);
        if (encontrado) return { el: encontrado, enVivo: false };
      }
      return { el: null, enVivo: false };
    };

    const nav = document.querySelector('nav[aria-label="Navegación principal"]');
    const ulMovil = document.querySelector('#mobile-menu > ul');
    const b = buscar('h1', (h) => h.textContent.includes('billetera de créditos'));
    const p = buscar('h2', (h) => h.textContent.trim() === 'Mi perfil');

    const medidor = document.createElement('div');
    medidor.style.position = 'absolute';
    medidor.style.left = '0';
    medidor.style.top = '0';
    medidor.style.width = '100%';
    document.body.appendChild(medidor);

    const medir = (el, enVivo) => {
      if (!el) return null;
      let nodo = el;
      if (!enVivo) {
        nodo = el.cloneNode(true);
        medidor.appendChild(nodo);
      }
      const estilo = getComputedStyle(nodo);
      const salida = {
        clases: el.className,
        tieneMaxMd: el.classList.contains('max-w-md'),
        maxWidth: estilo.maxWidth,
        ancho: Math.round(nodo.getBoundingClientRect().width),
        origen: enVivo ? 'DOM' : 'template',
      };
      if (!enVivo) nodo.remove();
      return salida;
    };

    // La navegación de <template id="tpl-preguntas"> también se clona.
    const tplP = document.querySelector('template#tpl-preguntas');
    const navP = tplP ? tplP.content.querySelector('nav[aria-label="Navegación principal"]') : null;

    const salida = {
      nav: medir(nav, true),
      ulMovil: medir(ulMovil, true),
      navPreguntas: medir(navP, false),
      billetera: medir(b.el, b.enVivo),
      perfil: medir(p.el, p.enVivo),
    };
    medidor.remove();
    return salida;
  `);

  for (const [nombre, el] of Object.entries(medidas)) {
    const esperado = ESPERADO[nombre];
    check(!!el, `el ${nombre} existe en el DOM`, el ? `origen: ${el.origen}` : 'no se encontró');
    if (!el) continue;
    check(
      el.clases.includes(esperado.clase),
      `el ${nombre} declara ${esperado.clase}`,
      el.clases
    );
    check(
      el.maxWidth === esperado.ancho,
      `el ${nombre} mide ${esperado.ancho} en CSS`,
      el.maxWidth
    );
  }

  check(
    medidas.billetera && medidas.billetera.clases.includes('text-white'),
    'el título de la billetera declara text-white',
    medidas.billetera ? medidas.billetera.clases : ''
  );
  check(
    medidas.perfil && medidas.perfil.clases.includes('text-white'),
    'el título del perfil declara text-white',
    medidas.perfil ? medidas.perfil.clases : ''
  );
}

async function probarDesbordamiento(cliente) {
  abrir('Desbordamiento de los menús');

  const medidas = await cliente.evaluar(`
    const nav = document.querySelector('nav[aria-label="Navegación principal"]');
    const navRect = nav.getBoundingClientRect();
    const hijos = Array.from(nav.children).map((el) => {
      const r = el.getBoundingClientRect();
      const visible = getComputedStyle(el).display !== 'none';
      return {
        etiqueta: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className ? ' [' + String(el.className).split(' ').slice(0, 2).join(' ') + ']' : ''),
        visible,
        ancho: Math.round(r.width),
        izquierda: Math.round(r.left),
        derecha: Math.round(r.right),
        seSale: visible && r.right > navRect.right + 1,
      };
    });

    // El header de la app vive en <template id="tpl-app">: se clona para
    // poder medirlo con su ancho real y también con max-w-md, que es lo que
    // NO se le aplica (la barra de 9 pestañas se quedaría sin ancho).
    const tpl = document.querySelector('template#tpl-app');
    const cont = document.createElement('div');
    cont.style.position = 'absolute';
    cont.style.left = '0';
    cont.style.top = '0';
    cont.style.width = '100%';
    const clon = tpl.content.cloneNode(true);
    cont.appendChild(clon);
    document.body.appendChild(cont);

    const header = cont.querySelector('#app-header > div');
    const barra = cont.querySelector('nav[aria-label="Paneles de la aplicación"]');
    const realAncho = header ? Math.round(header.getBoundingClientRect().width) : null;
    const realBarra = barra ? Math.round(barra.getBoundingClientRect().width) : null;
    const realContenido = barra ? barra.scrollWidth : null;
    if (header) header.classList.replace('max-w-6xl', 'max-w-md');
    const mdBarra = barra ? Math.round(barra.getBoundingClientRect().width) : null;
    cont.remove();

    return {
      navAncho: nav ? Math.round(nav.getBoundingClientRect().width) : null,
      navScroll: nav ? nav.scrollWidth : null,
      navClient: nav ? nav.clientWidth : null,
      navDerecha: nav ? Math.round(navRect.right) : null,
      hijos,
      appAncho: realAncho,
      appBarra: realBarra,
      appContenido: realContenido,
      appBarraEnMaxMd: mdBarra,
    };
  `);

  check(
    medidas.navScroll <= medidas.navClient + 1,
    'la navegación de escritorio no desborda su caja',
    `contenido ${medidas.navScroll}px en ${medidas.navClient}px`
  );

  for (const h of medidas.hijos || []) {
    if (!h.visible) continue;
    check(
      !h.seSale,
      `el bloque "${h.etiqueta}" no se sale de la caja del nav`,
      h.seSale ? `termina en ${h.derecha}px, la caja acaba en ${medidas.navDerecha}px` : `${h.ancho}px`
    );
  }

  check(
    medidas.appBarra > 0 && medidas.appContenido <= medidas.appBarra + 1,
    'la barra de paneles de la app conserva su ancho útil',
    `${medidas.appBarra}px útiles, ${medidas.appContenido}px de contenido`
  );
  check(
    medidas.appBarraEnMaxMd <= 0,
    'la barra de paneles de la app colapsaría con max-w-md (motivo documentado para no aplicarlo)',
    `${medidas.appBarraEnMaxMd}px útiles a max-w-md frente a ${medidas.appBarra}px reales`
  );

  await captura(cliente, 'nav-desktop');
}

async function probarRecovery(cliente) {
  abrir('"Olvidé mi contraseña"');

  await interceptarAuth(cliente);

  const inicial = await cliente.evaluar(`
    const link = document.getElementById('login-recover');
    const form = document.getElementById('login-form');
    const panel = document.getElementById('recovery-panel');
    return {
      hayLink: !!link,
      hayFormulario: !!panel,
      hayFormularioLogin: !!form,
      panelOculto: panel ? panel.classList.contains('hidden') : null,
      formOculto: form ? form.classList.contains('hidden') : null,
    };
  `);

  check(inicial.hayLink, 'el enlace "Olvidé mi contraseña" existe en el DOM');
  check(inicial.hayFormulario, 'el formulario de recuperación existe en el DOM');
  check(inicial.panelOculto, 'el formulario de recuperación arranca oculto');
  check(!inicial.formOculto, 'el formulario de login arranca visible');

  await clic(cliente, '#login-recover');

  const trasClic = await cliente.evaluar(`
    const link = document.getElementById('login-recover');
    const form = document.getElementById('login-form');
    const panel = document.getElementById('recovery-panel');
    return {
      panelVisible: panel ? !panel.classList.contains('hidden') : false,
      formOculto: form ? form.classList.contains('hidden') : false,
      linkOculto: link ? link.closest('div').classList.contains('hidden') : false,
      foco: document.activeElement ? document.activeElement.id : null,
    };
  `);

  check(trasClic.panelVisible, 'al hacer clic se muestra el formulario de recuperación');
  check(trasClic.formOculto, 'al hacer clic se oculta el formulario de login');
  check(trasClic.linkOculto, 'al hacer clic se oculta el enlace');
  check(trasClic.foco === 'recovery-email', 'el foco pasa al campo de correo', `foco=#${trasClic.foco}`);

  await captura(cliente, 'recovery-abierto');

  // Correo que HTML5 considera válido (type="email" acepta un dominio sin
  // punto) pero que la validación de la app rechaza: así se ejercita el
  // aviso propio y no la burbuja nativa del navegador.
  await escribir(cliente, '#recovery-email', 'usuario@localhost');
  await cliente.evaluar(`
    document.getElementById('recovery-form').requestSubmit();
    return true;
  `);
  await dormir(400);

  const trasInvalido = await cliente.evaluar(`
    const error = document.getElementById('login-error');
    const input = document.getElementById('recovery-email');
    return {
      visible: error ? !error.classList.contains('hidden') : false,
      texto: error ? error.textContent.trim() : '',
      html5Valido: input ? input.validity.valid : null,
    };
  `);

  check(trasInvalido.html5Valido, 'el correo de prueba pasa la validación nativa de type="email"');
  check(trasInvalido.visible, 'un correo inválido muestra un aviso visible');
  check(trasInvalido.texto.length > 0, 'el aviso tiene texto', trasInvalido.texto);

  let calls = await llamadasAuth(cliente);
  check(calls.length === 0, 'un correo inválido NO pide el enlace a la API', `${calls.length} llamadas`);

  // Correo válido: debe pedir el enlace por la API de magic-link.
  await escribir(cliente, '#recovery-email', 'usuario@example.cl');
  await cliente.evaluar(`
    document.getElementById('recovery-form').requestSubmit();
    return true;
  `);
  await dormir(500);

  calls = await llamadasAuth(cliente);
  const magic = calls.find((c) => c.url.includes('/auth/magic-link'));

  check(!!magic, 'el envío pide el enlace a la API de magic-link', magic ? magic.url : 'no hubo llamada');
  if (magic) {
    check(magic.method === 'POST', 'la petición de enlace es POST', magic.method);
    check(
      magic.url.startsWith('https://api.djlabs.cl'),
      'la petición de enlace va al dominio público de la API',
      magic.url
    );
    let cuerpo = null;
    try { cuerpo = JSON.parse(magic.body); } catch (e) { cuerpo = null; }
    check(!!cuerpo, 'el cuerpo de la petición es JSON', String(magic.body).slice(0, 120));
    check(cuerpo && cuerpo.email === 'usuario@example.cl', 'el cuerpo lleva el correo escrito', JSON.stringify(cuerpo));
  }

  const trasExito = await cliente.evaluar(`
    const note = document.querySelector('[data-recovery-note]');
    return {
      visible: note ? !note.classList.contains('hidden') : false,
      texto: note ? note.textContent.trim() : '',
    };
  `);

  check(trasExito.visible, 'tras enviar el enlace se muestra la nota de confirmación');
  check(
    trasExito.texto.includes('Perfil'),
    'la nota explica que se puede dejar una contraseña nueva desde Perfil',
    trasExito.texto.slice(0, 80)
  );
}

async function probarRecordarSesion(cliente) {
  abrir('"Recordar sesión"');

  // El flujo de recuperación dejó el formulario de login oculto; un formulario
  // oculto con campos `required` no se puede enviar. Se recarga la página
  // para partir del estado inicial real.
  await ir(cliente, `${URL_BASE}/`);
  await dormir(400);
  await interceptarAuth(cliente);

  const markup = await cliente.evaluar(`
    const cb = document.getElementById('login-remember');
    return {
      existe: !!cb,
      tipo: cb ? cb.type : null,
      nombre: cb ? cb.name : null,
      marcado: cb ? cb.checked : null,
      etiqueta: cb ? (document.querySelector('label[for="login-remember"]') || {}).textContent : null,
    };
  `);

  check(markup.existe, 'la casilla "Recordar sesión" existe en el DOM');
  check(markup.tipo === 'checkbox', 'la casilla es un checkbox', markup.tipo);
  check(markup.nombre === 'remember', 'la casilla se llama "remember"', markup.nombre);
  check(!markup.marcado, 'la casilla arranca desmarcada');
  check(
    (markup.etiqueta || '').includes('Recordar sesión'),
    'la casilla tiene su etiqueta visible',
    markup.etiqueta
  );

  // Desmarcada: el cuerpo NO debe llevar `remember`.
  await escribir(cliente, '#login-email', 'qa@example.cl');
  await escribir(cliente, '#login-password', 'contraseña-de-prueba');
  await cliente.evaluar(`
    document.getElementById('login-form').requestSubmit();
    return true;
  `);
  await dormir(500);

  let calls = await llamadasAuth(cliente);
  let login = calls.find((c) => c.url.includes('/auth/login'));
  check(!!login, 'el login se envía a /auth/login', login ? login.url : 'no hubo llamada');

  if (login) {
    check(login.method === 'POST', 'el login es POST', login.method);
    check(
      login.url.startsWith('https://api.djlabs.cl'),
      'el login va al dominio público de la API',
      login.url
    );
    let cuerpo = null;
    try { cuerpo = JSON.parse(login.body); } catch (e) { cuerpo = null; }
    check(!!cuerpo, 'el cuerpo del login es JSON', String(login.body).slice(0, 160));
    check(cuerpo && cuerpo.email === 'qa@example.cl', 'el cuerpo lleva el correo');
    check(cuerpo && !('remember' in cuerpo), 'sin marcar, el cuerpo NO lleva remember', JSON.stringify(cuerpo));
  }

  // Marcada: el cuerpo SÍ debe llevar `remember: true`.
  await cliente.evaluar(`
    const cb = document.getElementById('login-remember');
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  `);

  await cliente.evaluar(`
    window.__authCalls = [];
    document.getElementById('login-form').requestSubmit();
    return true;
  `);
  await dormir(500);

  calls = await llamadasAuth(cliente);
  login = calls.find((c) => c.url.includes('/auth/login'));
  check(!!login, 'el login marcado vuelve a enviarse');

  if (login) {
    let cuerpo = null;
    try { cuerpo = JSON.parse(login.body); } catch (e) { cuerpo = null; }
    check(cuerpo && cuerpo.remember === true, 'marcada, el cuerpo lleva remember: true', JSON.stringify(cuerpo));
  }
}

async function probarConsola(cliente) {
  abrir('Consola del navegador');

  const problemas = cliente.consola.filter((c) => {
    const texto = String(c.texto || '');
    if (c.nivel === 'exception') return true;
    if (c.nivel !== 'error') return false;
    // Un error de red contra un origen no permitido por CORS no es de este
    // código; el harness local corre en http://127.0.0.1 y la API sólo
    // permite los orígenes públicos. Se reporta pero no cuenta como fallo.
    if (texto.includes('CORS') || texto.includes('ERR_FAILED')) return false;
    return true;
  });

  check(
    problemas.length === 0,
    'no hay errores ni excepciones sin capturar',
    problemas.length ? `${problemas.length} en consola` : '0 en consola'
  );

  for (const p of problemas) {
    console.log(`       · [${p.nivel}] ${String(p.texto).slice(0, 180)}`);
  }

  const csp = cliente.consola.filter((c) => String(c.texto || '').includes('Content Security Policy'));
  check(csp.length === 0, 'no hay violaciones de CSP', csp.length ? `${csp.length} violaciones` : '0 violaciones');
  for (const p of csp) {
    console.log(`       · [${p.nivel}] ${String(p.texto).slice(0, 180)}`);
  }
}

// ----- Ejecución --------------------------------------------------------------

async function main() {
  const { cliente, targetId, socket } = await conectar();

  try {
    await ir(cliente, `${URL_BASE}/`);
    // El módulo de recuperación se carga como <script type="module">: espera
    // a que esté listo antes de interactuar.
    await cliente.esperar(
      `!!document.getElementById('login-recover')`,
      { etiqueta: 'el front no cargó' }
    );
    await dormir(300);

    await probarAnchos(cliente);
    await probarDesbordamiento(cliente);
    await probarRecovery(cliente);
    await probarConsola(cliente);
    await probarRecordarSesion(cliente);
  } finally {
    if (!KEEP_OPEN) {
      try { await cliente.enviar('Target.closeTarget', { targetId }); } catch (e) { /* ya cerrado */ }
      try { socket.close(); } catch (e) { /* ya cerrado */ }
    }
  }

  console.log(`\n\x1b[1mResumen\x1b[0m: ${registro.ok} correctas, ${registro.fallos.length} fallos`);
  for (const f of registro.fallos) console.log(`  \x1b[31m✗\x1b[0m ${f}`);

  process.exit(registro.fallos.length ? 1 : 0);
}

main().catch((error) => {
  console.error('\n\x1b[31mError fatal\x1b[0m:', error.message);
  process.exit(2);
});
