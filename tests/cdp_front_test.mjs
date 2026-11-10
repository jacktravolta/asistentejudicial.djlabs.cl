#!/usr/bin/env node
// =============================================================================
// cdp_front_test.mjs — comprobaciones end-to-end del front via CDP.
//
// Verifica sobre un navegador real (Chrome DevTools Protocol) los dos
// comportamientos que el usuario reporta:
//
//   1. Menú burger: el botón hamburguesa abre y cierra el panel móvil.
//   2. Formulario de contacto: envía a la API y muestra el estado del envío
//      SIN recargar la página.
//
// El arnés es autocontenido: habla CDP por WebSocket con el Chrome que ya
// está corriendo (o con uno propio, vía --cdp). No necesita dependencias.
//
// Uso:
//   node tests/cdp_front_test.mjs [opciones]
//
//   --url <base>     front a probar (default http://127.0.0.1:8002)
//   --cdp <puerto>   puerto del Chrome con --remote-debugging-port (default 9222)
//   --shots <dir>    guarda capturas PNG en ese directorio
//   --email <correo> correo usado en la prueba de contacto
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
  if (i === -1) return porDefecto;
  const valor = argv[i + 1];
  if (valor === undefined || valor.startsWith('--')) return true;
  return valor;
}

const URL_BASE = String(opcion('url', 'http://127.0.0.1:8002')).replace(/\/+$/, '');

// El front SIEMPRE habla con la API por su dominio público. Ni el arnés ni
// el código del front pueden apuntar a una IP interna: el dominio es lo que
// está en la allowlist de CORS y en la CSP de producción.
const API_ESPERADA = 'https://api.djlabs.cl';
const PUERTO_CDP = Number(opcion('cdp', 9222));
const DIR_SHOTS = opcion('shots', '');
const EMAIL = String(opcion('email', 'qa.asisjud@djlabs.cl'));
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
    this.peticiones = [];
    this.respuestas = [];
    this.fallos = [];

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
        case 'Network.requestWillBeSent':
          if (mensaje.params.request.method === 'POST') {
            this.peticiones.push({
              url: mensaje.params.request.url,
              postData: String(mensaje.params.request.postData || '').slice(0, 4000),
            });
          }
          break;
        case 'Network.responseReceived':
          this.respuestas.push({
            url: mensaje.params.response.url,
            status: mensaje.params.response.status,
          });
          break;
        case 'Network.loadingFailed':
          this.fallos.push({
            url: mensaje.params.requestId,
            error: mensaje.params.errorText,
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

  // Viewport de teléfono: por debajo del breakpoint `lg` de Tailwind, que es
  // lo que hace visible el botón hamburguesa.
  await cliente.enviar('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: false,
  });

  // Sin override del origen de la API: el front usa SIEMPRE su api-config.js,
  // que apunta al dominio público. La prueba verifica eso, no lo cambia.

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

async function probarBurger(cliente) {
  abrir('Menú burger (móvil)');

  // El front declara el botón y el panel en index.html: #menu-toggle abre
  // #mobile-menu. Se aceptan los dos juegos de IDs para que la prueba
  // detecte una regresión en cualquiera de los dos.
  const SEL_TOGGLE = '#menu-toggle, #mobile-menu-toggle';
  const SEL_PANEL = '#mobile-menu, #mobile-nav';

  const html = await cliente.evaluar(`
    const btn = document.querySelector(${JSON.stringify(SEL_TOGGLE)});
    const nav = document.querySelector(${JSON.stringify(SEL_PANEL)});
    return {
      boton: btn ? btn.id : null,
      hayBoton: !!btn,
      hayNav: !!nav,
      navId: nav ? nav.id : null,
      navInicial: nav ? nav.className : null,
      navOculto: nav ? nav.classList.contains('hidden') || nav.classList.contains('translate-x-full') : null,
    };
  `);

  check(html.hayBoton, 'el botón hamburguesa existe en el DOM', html.boton ? `id="${html.boton}"` : 'no se encontró');
  check(html.hayNav, 'el panel del menú existe en el DOM', html.navId ? `#${html.navId}` : 'no se encontró');
  if (!html.hayBoton || !html.hayNav) return;

  check(html.navOculto, 'el panel arranca cerrado', `clases: ${html.navInicial}`);

  await clic(cliente, `#${html.boton}`);

  const trasAbrir = await cliente.evaluar(`
    const nav = document.querySelector(${JSON.stringify(SEL_PANEL)});
    const btn = document.querySelector(${JSON.stringify(SEL_TOGGLE)});
    return {
      oculto: nav.classList.contains('hidden'),
      desplazado: nav.classList.contains('translate-x-full'),
      aria: btn.getAttribute('aria-expanded'),
      clases: nav.className,
    };
  `);

  check(!trasAbrir.oculto, 'al hacer clic el panel deja de estar oculto', `clases: ${trasAbrir.clases}`);
  check(!trasAbrir.desplazado, 'al hacer clic el panel entra en pantalla (translate-x-full fuera)');
  check(trasAbrir.aria === 'true', 'el botón queda con aria-expanded="true"', `aria-expanded=${trasAbrir.aria}`);

  await captura(cliente, 'burger-abierto');

  // Este front cierra el panel con el mismo botón (es un desplegable bajo la
  // barra, no un cajón lateral con botón de cerrar).
  await clic(cliente, `#${html.boton}`);

  const trasCerrar = await cliente.evaluar(`
    const nav = document.querySelector(${JSON.stringify(SEL_PANEL)});
    const btn = document.querySelector(${JSON.stringify(SEL_TOGGLE)});
    return {
      oculto: nav.classList.contains('hidden'),
      aria: btn.getAttribute('aria-expanded'),
    };
  `);

  check(trasCerrar.oculto, 'al volver a pulsar el botón el panel se cierra');
  check(trasCerrar.aria === 'false', 'el botón vuelve a aria-expanded="false"', `aria-expanded=${trasCerrar.aria}`);
}

async function probarContacto(cliente) {
  abrir('Formulario de contacto');

  const estructura = await cliente.evaluar(`
    const form = document.querySelector('#contact-form');
    return {
      hayForm: !!form,
      action: form ? form.getAttribute('action') : null,
      hayEstado: !!document.querySelector('#contact-status'),
      hayBoton: !!document.querySelector('#contact-submit'),
    };
  `);

  check(estructura.hayForm, 'el formulario #contact-form existe');
  check(estructura.hayBoton, 'el botón #contact-submit existe');
  check(estructura.hayEstado, 'el contenedor #contact-status existe');
  if (!estructura.hayForm || !estructura.hayBoton || !estructura.hayEstado) return;

  const baseApi = await cliente.evaluar(
    'return typeof window.__API_BASE__ === "string" ? window.__API_BASE__ : "";'
  );
  check(
    baseApi === API_ESPERADA,
    'el front resuelve la API por DOMINIO, no por IP interna',
    `__API_BASE__=${baseApi || '(vacío)'}`
  );

  // Marcador de vida: si la página se recarga, desaparece.
  await cliente.evaluar(`window.__cdpVivo = ${Date.now()}; return true;`);

  await escribir(cliente, '#contact-name', 'Prueba CDP');
  await escribir(cliente, '#contact-email', EMAIL);
  await escribir(cliente, '#contact-message', 'Mensaje de prueba automática vía CDP.');

  const peticionesAntes = cliente.peticiones.length;

  await clic(cliente, '#contact-submit');

  let estado = null;
  try {
    estado = await cliente.esperar(
      `(() => {
        const s = document.querySelector('#contact-status');
        if (!s || s.classList.contains('hidden')) return null;
        const t = (s.textContent || '').trim();
        return t ? { texto: t, clases: s.className } : null;
      })()`,
      { timeout: 20000, etiqueta: 'el estado del envío aparece' }
    );
  } catch (e) {
    check(false, 'el estado del envío aparece tras enviar', e.message);
  }

  const vivo = await cliente.evaluar(`return typeof window.__cdpVivo !== 'undefined' ? window.__cdpVivo : null;`);
  check(vivo !== null, 'la página NO se recargó al enviar', vivo === null ? 'window.__cdpVivo desapareció: hubo navegación' : 'marcador intacto');

  if (estado) {
    check(true, 'el estado del envío aparece tras enviar', estado.texto.slice(0, 90));
    check(estado.texto.length > 10, 'el estado tiene un mensaje visible');
  }

  const nuevas = cliente.peticiones.slice(peticionesAntes);
  const post = nuevas.find((p) => p.url.includes('/contact'));
  check(!!post, 'la página hizo un POST al endpoint de contacto', post ? post.url : 'no se registró ningún POST /contact');
  if (post) {
    check(post.url.startsWith(API_ESPERADA), 'el POST va al dominio público de la API', post.url);
    let cuerpo = {};
    try { cuerpo = JSON.parse(post.postData); } catch { cuerpo = {}; }
    check(!!cuerpo.name && !!cuerpo.email && !!cuerpo.message, 'el POST lleva name, email y message', Object.keys(cuerpo).join(','));
  }

  const respuesta = cliente.respuestas.filter((r) => r.url.includes('/contact')).pop();
  if (respuesta) {
    check(respuesta.status >= 200 && respuesta.status < 300, 'la API respondió 2xx al envío', `HTTP ${respuesta.status}`);
  } else {
    check(false, 'la API respondió al envío');
  }

  await captura(cliente, 'contacto-enviado');
}

function revisarConsola(cliente) {
  abrir('Consola del navegador');

  const ruido = ['favicon', '/auth/me', 'auth/refresh', 'Download the React DevTools'];
  const errores = cliente.consola.filter((c) => {
    if (!['error', 'exception'].includes(c.nivel)) return false;
    const texto = c.texto || '';
    return !ruido.some((patron) => texto.includes(patron));
  });

  check(errores.length === 0, 'no hay errores ni excepciones sin capturar', errores.length ? `${errores.length} en consola` : '');
  for (const e of errores.slice(0, 8)) {
    console.log(`       · [${e.nivel}] ${String(e.texto).slice(0, 200)}`);
  }
}

// ----- Corriente principal ----------------------------------------------------

const { cliente, targetId, socket } = await conectar();

try {
  console.log(`\n\x1b[1mcdp_front_test\x1b[0m — front: ${URL_BASE}  ·  api: ${API_ESPERADA} (dominio público)`);

  await ir(cliente, `${URL_BASE}/`);
  await dormir(800);

  await probarBurger(cliente);
  await probarContacto(cliente);
  revisarConsola(cliente);
} catch (e) {
  registro.fallos.push(`ejecución → ${e.message}`);
  console.log(`\n\x1b[31merror fatal\x1b[0m ${e.message}`);
} finally {
  if (!KEEP_OPEN) {
    await cliente.enviar('Target.closeTarget', { targetId }).catch(() => {});
  }
  socket.close();
}

console.log(`\n\x1b[1mResumen\x1b[0m: ${registro.ok} correctas, ${registro.fallos.length} fallos`);
for (const f of registro.fallos) console.log(`  \x1b[31m✗\x1b[0m ${f}`);

process.exit(registro.fallos.length === 0 ? 0 : 1);
