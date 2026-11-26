#!/usr/bin/env node
// =============================================================================
// cdp_chat_qa.mjs — QA end-to-end del chat web con evidencia de la respuesta.
//
// A diferencia de cdp_panel_test.mjs (que afirma que "aparece una burbuja"),
// este arnés imprime la TRANSCRIPCIÓN REAL de la conversación: lo que se
// escribió, lo que la IA respondió y qué se le envió a la API. Sale con
// código 0 solo si la IA respondió con texto no vacío.
//
// Uso:
//   node tests/cdp_chat_qa.mjs [opciones]
//
//   --url <base>       front a probar (default https://asisjud.djlabs.cl)
//   --cdp <puerto>     puerto de Chrome con CDP (default 9333)
//   --email <correo>   cuenta QA existente; sin este argumento el arnés
//                      REGISTRA una cuenta QA nueva en cada corrida
//   --password <clave> contraseña QA
//   --question <texto> pregunta que se envía al chat
//   --keep-open        no cierra la pestaña al terminar
//   --shots <dir>      guarda capturas PNG en ese directorio
//
// Salida: 0 si la IA respondió con texto no vacío, 1 si no.
// =============================================================================

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);

function opcion(nombre, porDefecto) {
  const i = argv.indexOf(`--${nombre}`);
  if (i === -1) return porDefecto;
  const valor = argv[i + 1];
  if (valor === undefined || valor.startsWith('--')) return true;
  return valor;
}

const URL_BASE = String(opcion('url', 'https://asisjud.djlabs.cl')).replace(/\/+$/, '');
const API_ESPERADA = 'https://api.djlabs.cl';
const PUERTO_CDP = Number(opcion('cdp', 9333));
const EMAIL_ARG = opcion('email', '');
const EMAIL = EMAIL_ARG ? String(EMAIL_ARG) : `qa.chat.${Date.now().toString(36)}@djlabs.cl`;
const PASSWORD = String(opcion('password', 'Chat-QA-2026!x'));
const PREGUNTA = String(opcion('question', 'Hola, responde en una sola frase breve: ¿qué es un contrato de arrendamiento en Chile?'));
const KEEP_OPEN = argv.includes('--keep-open');
const DIR_SHOTS = opcion('shots', '');

if (DIR_SHOTS) mkdirSync(DIR_SHOTS, { recursive: true });

const dormir = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ----- Cliente CDP mínimo ----------------------------------------------------

class Cliente {
  constructor(socket) {
    this.socket = socket;
    this.id = 0;
    this.pendientes = new Map();
    this.consola = [];
    this.peticiones = [];
    this.respuestas = [];
    this.parseosFallidos = [];
    this.guiones = [];

    socket.addEventListener('message', (evento) => {
      const mensaje = JSON.parse(evento.data);

      if (mensaje.id && this.pendientes.has(mensaje.id)) {
        const { resolver, rechazar } = this.pendientes.get(mensaje.id);
        this.pendientes.delete(mensaje.id);
        if (mensaje.error) {
          rechazar(new Error(`${mensaje.error.message} ${JSON.stringify(mensaje.error.data ?? {})}`));
        } else {
          resolver(mensaje.result);
        }
        return;
      }

      if (!mensaje.method) return;

      switch (mensaje.method) {
        case 'Runtime.consoleAPICalled':
          this.consola.push({
            nivel: mensaje.params.type,
            texto: mensaje.params.args.map((a) => a.description ?? a.value ?? a.type).join(' '),
            url: '',
            source: 'console-api',
          });
          break;
        case 'Runtime.exceptionThrown': {
          const d = mensaje.params.exceptionDetails || {};
          this.consola.push({
            nivel: 'exception',
            texto: (d.exception && (d.exception.description || d.exception.value)) || d.text || 'excepción sin detalle',
            url: d.url || '',
            source: 'exception',
          });
          break;
        }
        case 'Log.entryAdded':
          this.consola.push({
            nivel: mensaje.params.entry.level,
            texto: mensaje.params.entry.text || '',
            url: mensaje.params.entry.url || '',
            source: mensaje.params.entry.source || 'log',
          });
          break;
        case 'Network.requestWillBeSent':
          this.peticiones.push({
            id: mensaje.params.requestId,
            metodo: mensaje.params.request.method,
            url: mensaje.params.request.url,
            postData: String(mensaje.params.request.postData || '').slice(0, 12000),
          });
          break;
        case 'Network.responseReceived': {
          const previa = this.peticiones.find((p) => p.id === mensaje.params.requestId);
          this.respuestas.push({
            url: mensaje.params.response.url,
            status: mensaje.params.response.status,
            metodo: previa ? previa.metodo : mensaje.params.response.requestMethod || '?',
          });
          break;
        }
        // El dominio Debugger entrega el fallo de parseo con URL, línea y
        // columna exactas. Un SyntaxError de un módulo importado se reporta
        // aquí aunque el módulo que lo importa se quede en un catch.
        case 'Debugger.scriptFailedToParse':
          this.parseosFallidos.push({
            url: mensaje.params.url || '',
            linea: mensaje.params.startLine ?? -1,
            columna: mensaje.params.startColumn ?? -1,
            error: mensaje.params.errorMessage || '',
          });
          break;
        case 'Debugger.scriptParsed':
          this.guiones.push(mensaje.params.url || '');
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
        resolver: (valor) => {
          clearTimeout(timer);
          resolver(valor);
        },
        rechazar: (error) => {
          clearTimeout(timer);
          rechazar(error);
        },
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
        (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text),
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
  await cliente.enviar('DOM.enable');
  await cliente.enviar('Log.enable').catch(() => {});
  // Debugger.enable DEBE ir antes de navegar: el fallo de parseo ocurre
  // durante la carga del módulo y solo se reporta en ese momento.
  await cliente.enviar('Debugger.enable').catch(() => {});

  // El arnés debe medir el código que está en producción AHORA, no el que
  // Chrome guardó en una corrida anterior.
  await cliente.enviar('Network.setCacheDisabled', { cacheDisabled: true }).catch(() => {});
  await cliente.enviar('Network.clearBrowserCookies').catch(() => {});

  await cliente.enviar('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1000,
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

async function posicion(cliente, selector) {
  return cliente.evaluar(`
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  `);
}

async function clic(cliente, selector) {
  const pos = await posicion(cliente, selector);
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

const registro = { ok: 0, fallos: [] };

function check(condicion, etiqueta, extra = '') {
  if (condicion) {
    registro.ok += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${etiqueta}${extra ? ' — ' + extra : ''}`);
  } else {
    registro.fallos.push({ etiqueta, extra });
    console.log(`  \x1b[31m✗\x1b[0m ${etiqueta}${extra ? ' — observado: ' + extra : ''}`);
  }
}

// ----- Comprobaciones --------------------------------------------------------

async function registrarCuentaQA() {
  if (EMAIL_ARG) return true;
  try {
    const response = await fetch(`${API_ESPERADA}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        name: 'QA Chat',
        email: EMAIL,
        password: PASSWORD,
        terms_accepted: true,
      }),
    });
    const payload = await response.json().catch(() => null);
    const ok = response.ok && payload && payload.success === true;
    check(ok, 'la cuenta QA de prueba queda registrada', ok ? EMAIL : `HTTP ${response.status}`);
    return ok;
  } catch (error) {
    check(false, 'la cuenta QA de prueba queda registrada', error.message);
    return false;
  }
}

async function iniciarSesion(cliente) {
  console.log('\n\x1b[1mAutenticación real\x1b[0m');
  if (!(await registrarCuentaQA())) return false;

  const estructura = await cliente.evaluar(`
    return {
      form: !!document.querySelector('#login-form'),
      email: !!document.querySelector('#login-email'),
      password: !!document.querySelector('#login-password'),
      submit: !!document.querySelector('#login-form button[type="submit"]'),
    };
  `);
  check(
    estructura.form && estructura.email && estructura.password && estructura.submit,
    'el formulario de login está disponible',
  );
  if (!estructura.form) return false;

  await escribir(cliente, '#login-email', EMAIL);
  await escribir(cliente, '#login-password', PASSWORD);
  await clic(cliente, '#login-form button[type="submit"]');

  let dashboard = false;
  try {
    dashboard = await cliente.esperar(
      `(() => {
        const el = document.querySelector('#view-dashboard');
        return !!(el && !el.classList.contains('hidden'));
      })()`,
      { timeout: 30000, etiqueta: 'el panel autenticado aparece' },
    );
  } catch (error) {
    const loginError = await cliente.evaluar(`
      const el = document.querySelector('#login-error');
      return el ? (el.textContent || '').trim() : '';
    `);
    check(false, 'el panel autenticado aparece tras iniciar sesión', loginError || error.message);
    return false;
  }
  check(dashboard, 'el panel autenticado aparece tras iniciar sesión', EMAIL);
  return dashboard;
}

async function abrirConsultas(cliente) {
  console.log('\n\x1b[1mMontaje del chat\x1b[0m');

  // La navegación puede tener varias entradas para el mismo panel (menú
  // lateral y barra inferior). Se usa la primera visible.
  const hayBoton = await cliente.evaluar(`
    const botones = [...document.querySelectorAll('[data-panel="chat"]')];
    const visible = (el) => !!(el && el.getClientRects().length && !el.classList.contains('hidden'));
    return botones.some(visible);
  `);
  check(hayBoton, 'la navegación expone Consultas (data-panel="chat")');
  if (!hayBoton) return false;

  await cliente.evaluar(`
    const botones = [...document.querySelectorAll('[data-panel="chat"]')];
    const visible = (el) => !!(el && el.getClientRects().length && !el.classList.contains('hidden'));
    const el = botones.find(visible);
    if (el) el.click();
    return !!el;
  `);
  await dormir(600);

  let montado = false;
  try {
    montado = await cliente.esperar(
      `(() => {
        const widgets = [...document.querySelectorAll('.chat-widget')];
        return widgets.some((w) => !!w.querySelector('textarea'));
      })()`,
      { timeout: 25000, etiqueta: 'el widget de Consultas monta' },
    );
  } catch (error) {
    const sintaxis = cliente.consola.filter((c) => /SyntaxError|Unexpected token/i.test(c.texto));
    check(false, 'el widget de Consultas monta sin errores de sintaxis',
      sintaxis.length ? sintaxis[0].texto : error.message);
    await diagnosticarMount(cliente);
    return false;
  }
  check(montado, 'el widget de Consultas monta sin errores de sintaxis');
  return montado;
}

// Cuando el montaje falla, el catch de app.js solo muestra el error caught.
// Este diagnóstico vuelve a invocar mountChat aislado para obtener el stack
// real dentro de chat-widget.js.
async function diagnosticarMount(cliente) {
  console.log('\n  \x1b[33mDiagnóstico del montaje:\x1b[0m');
  const diag = await cliente.evaluar(`
    try {
      const mod = await import('/js/chat-widget.js?v=11');
      const host = document.querySelector('#chat-consultas')
        || document.querySelector('#panel-chat')
        || document.createElement('div');
      mod.mountChat(host, {});
      return { ok: true };
    } catch (e) {
      return { ok: false, name: e && e.name, message: e && e.message, stack: e && e.stack };
    }
  `).catch((error) => ({ ok: false, message: error.message }));
  console.log(`    ${JSON.stringify(diag, null, 2).split('\n').join('\n    ')}`);
}

async function chatear(cliente) {
  console.log('\n\x1b[1mConversación real\x1b[0m');

  const antes = await cliente.evaluar(`
    return [...document.querySelectorAll('.chat-messages > div')]
      .filter((row) => row.querySelector('.bubble-assistant, .bg-slate-100')).length;
  `);
  const peticionesAntes = cliente.peticiones.length;
  const respuestasAntes = cliente.respuestas.length;

  const input = '.chat-widget textarea';
  await escribir(cliente, input, PREGUNTA);
  await clic(cliente, '.chat-widget button[type="submit"]');

  console.log(`  \x1b[36mTú:\x1b[0m ${PREGUNTA}`);

  let peticion = null;
  try {
    const limite = Date.now() + 20000;
    while (Date.now() < limite && !peticion) {
      peticion = cliente.peticiones.slice(peticionesAntes).find(
        (item) => item.metodo === 'POST' && item.url.includes('/chat/completions'),
      ) || null;
      if (!peticion) await dormir(100);
    }
  } catch (_) { /* sin peticion */ }
  check(!!peticion, 'la página envía POST /chat/completions');
  if (!peticion) return null;

  let cuerpo = {};
  try {
    cuerpo = JSON.parse(peticion.postData || '{}');
  } catch (_) {
    cuerpo = {};
  }
  console.log(`  \x1b[2m→ API:\x1b[0m ${peticion.url}`);
  console.log(`  \x1b[2m→ cuerpo:\x1b[0m ${JSON.stringify(cuerpo).slice(0, 300)}`);

  let respuesta = null;
  const limite = Date.now() + 90000;
  while (Date.now() < limite && !respuesta) {
    // Solo la respuesta del POST: el preflight CORS (OPTIONS) también coincide
    // por URL y devuelve 204 sin cuerpo.
    respuesta = cliente.respuestas.slice(respuestasAntes).find(
      (item) => item.url.includes('/chat/completions') && item.metodo === 'POST',
    ) || null;
    if (!respuesta) await dormir(150);
  }
  check(!!respuesta, 'la API responde POST /chat/completions');
  if (respuesta) {
    check(
      respuesta.status >= 200 && respuesta.status < 300,
      'la API responde 2xx a la consulta',
      `HTTP ${respuesta.status}`,
    );
  }

  let burbuja = null;
  try {
    burbuja = await cliente.esperar(
      `(() => {
        const rows = [...document.querySelectorAll('.chat-messages > div')]
          .filter((row) => row.querySelector('.bg-slate-100'));
        if (rows.length <= ${antes}) return null;
        const row = rows[rows.length - 1];
        const bubble = row.querySelector('.bg-slate-100');
        const text = (row.dataset.messageText || '').trim();
        const visibleText = (bubble && bubble.textContent || '').trim();
        return text && visibleText ? { text, visibleText } : null;
      })()`,
      { timeout: 60000, etiqueta: 'aparece una burbuja de respuesta' },
    );
  } catch (error) {
    check(false, 'aparece una burbuja del asistente con respuesta no vacía', error.message);
    return null;
  }

  console.log(`\n  \x1b[1;32mIA:\x1b[0m ${burbuja.visibleText}\n`);
  check(burbuja.visibleText.length > 0, 'aparece una burbuja del asistente con respuesta no vacía');
  check(
    !/no pudimos cargar|error al cargar|no se pudo completar/i.test(burbuja.visibleText),
    'la respuesta del asistente no es un mensaje de error de la aplicación',
    burbuja.visibleText.slice(0, 120),
  );

  await captura(cliente, 'chat-qa-respuesta');
  return burbuja;
}

function revisarConsola(cliente) {
  console.log('\n\x1b[1mConsola del navegador\x1b[0m');

  if (cliente.parseosFallidos.length) {
    console.log('\n  \x1b[31mMódulos que NO parsearon:\x1b[0m');
    for (const p of cliente.parseosFallidos) {
      console.log(`    · ${p.url}:${p.linea}:${p.columna} — ${p.error}`);
    }
  }
  check(
    cliente.parseosFallidos.length === 0,
    'todos los módulos cargados parsearon sin errores',
    cliente.parseosFallidos.length
      ? cliente.parseosFallidos.map((p) => `${p.url}:${p.linea}:${p.columna}`).join(' | ')
      : '',
  );

  const ruido = (texto) =>
    /favicon|ERR_BLOCKED_BY_CLIENT|inject\.js|net::ERR_|DevTools|Autofill/i.test(texto);

  const errores = cliente.consola.filter(
    (c) => ['error', 'exception'].includes(c.nivel) && !ruido(c.texto),
  );
  const sintaxis = errores.filter((c) => /SyntaxError|Unexpected token/i.test(c.texto));

  check(sintaxis.length === 0, 'no hay errores de sintaxis en la consola',
    sintaxis.length ? sintaxis.map((c) => c.texto).join(' | ').slice(0, 200) : '');

  const otros = errores.filter((c) => !/SyntaxError|Unexpected token/i.test(c.texto));
  check(otros.length === 0, 'no hay otros errores de consola de la aplicación',
    otros.length ? otros.map((c) => c.texto).join(' | ').slice(0, 300) : '');

  // Los 404 sin URL en el texto de consola se localizan por red.
  const faltantes = cliente.respuestas.filter((r) => r.status === 404);
  if (faltantes.length) {
    console.log('\n  \x1b[33mRecursos 404:\x1b[0m');
    for (const r of [...new Set(faltantes.map((x) => x.url))]) console.log(`    · ${r}`);
  }

  if (errores.length) {
    console.log('\n  \x1b[2mErrores registrados:\x1b[0m');
    for (const e of errores.slice(0, 12)) console.log(`    · [${e.nivel}] ${e.texto.slice(0, 220)}`);
  }
}

// ----- Corriente principal ----------------------------------------------------

console.log(`\n\x1b[1mcdp_chat_qa\x1b[0m — front: ${URL_BASE}  ·  api: ${API_ESPERADA}  ·  cuenta: ${EMAIL}`);

let cliente = null;
let targetId = null;
let socket = null;

try {
  ({ cliente, targetId, socket } = await conectar());
  await ir(cliente, `${URL_BASE}/`);
  await dormir(900);

  const autenticado = await iniciarSesion(cliente);
  if (autenticado) {
    const montado = await abrirConsultas(cliente);
    if (montado) await chatear(cliente);
  }
  revisarConsola(cliente);
} catch (error) {
  registro.fallos.push({ etiqueta: 'error fatal', extra: error.message });
  console.log(`\n\x1b[31merror fatal\x1b[0m ${error.message}`);
} finally {
  if (cliente && targetId && !KEEP_OPEN) {
    await cliente.enviar('Target.closeTarget', { targetId }).catch(() => {});
  }
  if (socket) socket.close();
}

const total = registro.ok + registro.fallos.length;
console.log(`\n\x1b[1mResumen\x1b[0m: ${total} assertions, ${registro.ok} passed, ${registro.fallos.length} failed`);
for (const fallo of registro.fallos) {
  console.log(`  \x1b[31m✗\x1b[0m ${fallo.etiqueta}${fallo.extra ? ' — observado: ' + fallo.extra : ''}`);
}

process.exit(registro.fallos.length === 0 ? 0 : 1);
