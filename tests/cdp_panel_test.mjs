#!/usr/bin/env node
// =============================================================================
// cdp_panel_test.mjs — verificación end-to-end del panel de documentos y chat.
//
// Usa Chrome DevTools Protocol sin dependencias externas. El flujo prueba:
//   1. login real mediante el formulario;
//   2. navegación entre Documentos y Consultas sin montar dos widgets;
//   3. envío de una sola pregunta, incluyendo el heart en /chat/completions;
//   4. biblioteca vacía, carga de un TXT, lectura, autorización y borrado;
//   5. ausencia de errores de página y errores de consola de la aplicación.
//
// Uso:
//   node tests/cdp_panel_test.mjs [opciones]
//
//   --url <base>       front a probar (default http://127.0.0.1:8002)
//   --cdp <puerto>     puerto de Chrome con CDP (default 9222)
//   --email <correo>   cuenta QA existente; sin este argumento el arnés
//                      REGISTRA una cuenta QA nueva en cada corrida
//   --password <clave> contraseña QA
//   --keep-open        no cierra la pestaña al terminar
//   --skip-chat        omite el envío (solo para depurar el arnés)
//   --skip-upload      omite la carga (solo para depurar el arnés)
//
// Salida: 0 si todas las comprobaciones pasan, 1 si hay algún fallo.
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

const URL_BASE = String(opcion('url', 'http://127.0.0.1:8002')).replace(/\/+$/, '');
const API_ESPERADA = 'https://api.djlabs.cl';
const PUERTO_CDP = Number(opcion('cdp', 9222));
const EMAIL_ARG = opcion('email', '');
// Sin --email el arnés registra una cuenta QA nueva en cada corrida. La cuenta
// fija se bloquea (EMAIL_REVERIFY_REQUIRED) al cruzar el umbral de uso, y un
// arnés repetible necesita una cuenta con saldo para probar el chat.
const EMAIL = EMAIL_ARG ? String(EMAIL_ARG) : `qa.panel.${Date.now().toString(36)}@djlabs.cl`;
const PASSWORD = String(opcion('password', 'Panel-QA-2026!x'));
const KEEP_OPEN = argv.includes('--keep-open');
const SKIP_CHAT = argv.includes('--skip-chat');
const SKIP_UPLOAD = argv.includes('--skip-upload');
const DIR_SHOTS = opcion('shots', '');

// The heart the chat used in this run. The conversations API asks for the same
// heart, so the harness reads the list with the very same installation.
let HEART_CHAT = '';

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
    this.fallosRed = [];
    this.dialogos = [];

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
            texto: mensaje.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '),
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
        case 'Network.responseReceived':
          this.respuestas.push({
            url: mensaje.params.response.url,
            status: mensaje.params.response.status,
          });
          break;
        case 'Network.loadingFailed':
          this.fallosRed.push({
            requestId: mensaje.params.requestId,
            error: mensaje.params.errorText,
          });
          break;
        case 'Page.javascriptDialogOpening':
          this.dialogos.push({
            type: mensaje.params.type,
            message: mensaje.params.message || '',
            url: mensaje.params.url || '',
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

  async esperarDialogo(indiceBase = 0, timeout = 10000) {
    const limite = Date.now() + timeout;
    while (Date.now() < limite) {
      if (this.dialogos.length > indiceBase) return this.dialogos[indiceBase];
      await dormir(40);
    }
    throw new Error('no se abrió el diálogo esperado');
  }

  async esperarPeticion(indiceBase = 0, timeout = 15000) {
    const limite = Date.now() + timeout;
    while (Date.now() < limite) {
      const peticion = this.peticiones.slice(indiceBase).find(
        (item) => item.metodo === 'POST' && item.url.includes('/chat/completions'),
      );
      if (peticion) return peticion;
      await dormir(80);
    }
    throw new Error('no se registró POST /chat/completions');
  }

  async esperarRespuesta(indiceBase = 0, timeout = 60000) {
    const limite = Date.now() + timeout;
    while (Date.now() < limite) {
      const respuesta = this.respuestas.slice(indiceBase).find(
        (item) => item.url.includes('/chat/completions'),
      );
      if (respuesta) return respuesta;
      await dormir(120);
    }
    throw new Error('la API no respondió /chat/completions');
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

  // La sesión de la API viaja en una cookie httpOnly. Sin limpiarla, el
  // arnés hereda la sesión de una corrida anterior (o de otra cuenta) y las
  // comprobaciones miden la cuenta equivocada.
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

async function posicionPorTexto(cliente, texto, raiz = 'document') {
  return cliente.evaluar(`
    const scope = ${raiz === 'document' ? 'document' : `document.querySelector(${JSON.stringify(raiz)})`};
    if (!scope) return null;
    const botones = [...scope.querySelectorAll('button')];
    const el = botones.find((b) => (b.textContent || '').trim() === ${JSON.stringify(texto)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  `);
}

async function clicPorTexto(cliente, texto, raiz = 'document') {
  const pos = await posicionPorTexto(cliente, texto, raiz);
  if (!pos) throw new Error(`no existe un botón con el texto "${texto}"`);
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

async function establecerArchivo(cliente, selector, archivos) {
  const { root } = await cliente.enviar('DOM.getDocument', { depth: -1, pierce: true });
  const { nodeId } = await cliente.enviar('DOM.querySelector', {
    nodeId: root.nodeId,
    selector,
  });
  if (!nodeId) throw new Error(`DOM.setFileInputFiles: no existe ${selector}`);
  await cliente.enviar('DOM.setFileInputFiles', { nodeId, files: archivos });
}

async function clicConDialogo(cliente, texto, raiz, aceptar) {
  const dialogoBase = cliente.dialogos.length;
  const clickPromise = clicPorTexto(cliente, texto, raiz).catch((error) => {
    throw error;
  });
  let dialogo;
  try {
    dialogo = await cliente.esperarDialogo(dialogoBase, 10000);
  } catch (error) {
    await clickPromise.catch(() => {});
    throw error;
  }
  await cliente.enviar('Page.handleJavaScriptDialog', { accept: aceptar });
  await clickPromise;
  return dialogo;
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
    registro.fallos.push({ seccion: registro.seccion, etiqueta, extra: String(extra || '') });
    console.log(`  \x1b[31mFAIL\x1b[0m ${etiqueta}${extra ? ' — ' + extra : ''}`);
  }
  return !!condicion;
}

// ----- Comprobaciones --------------------------------------------------------

// Registra una cuenta QA nueva contra la API pública. Devuelve true si la
// cuenta quedó lista para el login del formulario.
async function registrarCuentaQA() {
  if (EMAIL_ARG) return true;
  try {
    const response = await fetch(`${API_ESPERADA}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        name: 'QA Panel',
        email: EMAIL,
        password: PASSWORD,
        terms_accepted: true,
      }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || payload.success !== true) {
      const motivo = payload && payload.error && payload.error.message
        ? payload.error.message
        : `HTTP ${response.status}`;
      check(false, 'la cuenta QA de prueba queda registrada', motivo);
      return false;
    }
    check(true, 'la cuenta QA de prueba queda registrada', EMAIL);
    return true;
  } catch (error) {
    check(false, 'la cuenta QA de prueba queda registrada', error.message);
    return false;
  }
}

async function iniciarSesion(cliente) {
  abrir('Autenticación real');

  if (!(await registrarCuentaQA())) return false;

  const estructura = await cliente.evaluar(`
    return {
      form: !!document.querySelector('#login-form'),
      email: !!document.querySelector('#login-email'),
      password: !!document.querySelector('#login-password'),
      submit: !!document.querySelector('#login-form button[type="submit"]'),
    };
  `);
  check(estructura.form, 'existe el formulario real #login-form');
  check(estructura.email && estructura.password && estructura.submit, 'el formulario tiene correo, contraseña y envío');
  if (!estructura.form || !estructura.email || !estructura.password || !estructura.submit) return false;

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

async function comprobarNavegacion(cliente) {
  abrir('Documentos y Consultas');

  const nav = await cliente.evaluar(`
    const docs = [...document.querySelectorAll('[data-panel="documents"]')];
    const chats = [...document.querySelectorAll('[data-panel="chat"]')];
    const visible = (el) => !!(el && el.getClientRects().length && !el.classList.contains('hidden'));
    return {
      docs: docs.length,
      chats: chats.length,
      docsVisible: docs.some(visible),
      chatsVisible: chats.some(visible),
      docText: docs.map((el) => (el.textContent || '').trim()),
      chatText: chats.map((el) => (el.textContent || '').trim()),
    };
  `);
  check(nav.docsVisible, 'la navegación autenticada expone Documentos', `data-panel="documents" x${nav.docs}`);
  check(nav.chatsVisible, 'la navegación autenticada expone Consultas', `data-panel="chat" x${nav.chats}`);

  const inicial = await cliente.evaluar(`
    const docs = document.querySelector('#panel-documents');
    const chat = document.querySelector('#panel-chat');
    const widgets = document.querySelectorAll('.chat-widget');
    return {
      docsHidden: !docs || docs.classList.contains('hidden'),
      chatHidden: !chat || chat.classList.contains('hidden'),
      widgets: widgets.length,
      inside: [...document.querySelectorAll('.chat-widget')]
        .filter((el) => el.id === 'chat-consultas' || el.closest('#chat-consultas')).length,
    };
  `);
  check(inicial.docsHidden && !inicial.chatHidden, 'el panel inicial es Consultas y no Documentos', JSON.stringify(inicial));
  check(inicial.widgets === 1 && inicial.inside === 1, 'existe exactamente un widget y está dentro de #chat-consultas', `widgets=${inicial.widgets}, inside=${inicial.inside}`);

  const conteos = [];
  for (let ciclo = 0; ciclo < 3; ciclo++) {
    await clic(cliente, '[data-panel="documents"]');
    await dormir(250);
    conteos.push(await cliente.evaluar('return document.querySelectorAll(\'.chat-widget\').length;'));

    await clic(cliente, '[data-panel="chat"]');
    await dormir(250);
    conteos.push(await cliente.evaluar('return document.querySelectorAll(\'.chat-widget\').length;'));
  }
  check(
    conteos.every((n) => n === 1),
    'Documentos ↔ Consultas conserva un único widget (3 ciclos)',
    `conteos=${conteos.join(',')}`,
  );

  const finalWidget = await cliente.evaluar(`
    return {
      widgets: document.querySelectorAll('.chat-widget').length,
      inside: [...document.querySelectorAll('.chat-widget')]
        .filter((el) => el.id === 'chat-consultas' || el.closest('#chat-consultas')).length,
    };
  `);
  check(finalWidget.widgets === 1 && finalWidget.inside === 1, 'el widget final sigue montado exactamente una vez', JSON.stringify(finalWidget));
}

async function enviarUnaConsulta(cliente) {
  abrir('Una consulta real con heart');

  const antes = await cliente.evaluar(`
    return [...document.querySelectorAll('.chat-messages > div')]
      .filter((row) => row.querySelector('.bg-slate-100')).length;
  `);
  const peticionesAntes = cliente.peticiones.length;
  const respuestasAntes = cliente.respuestas.length;

  const input = '.chat-widget textarea';
  if (!await cliente.evaluar(`return !!document.querySelector(${JSON.stringify(input)});`)) {
    check(false, 'el chat ofrece un campo de escritura');
    return;
  }
  check(true, 'el chat ofrece un campo de escritura');

  await escribir(cliente, input, 'Hola, responde brevemente con una frase de prueba para verificar el chat.');
  await clic(cliente, '.chat-widget button[type="submit"]');

  let peticion = null;
  try {
    peticion = await cliente.esperarPeticion(peticionesAntes, 15000);
  } catch (error) {
    check(false, 'la página envía POST /chat/completions', error.message);
    return;
  }

  check(peticion.url.startsWith(API_ESPERADA), 'la consulta va al dominio público de la API', peticion.url);

  let cuerpo = {};
  try {
    cuerpo = JSON.parse(peticion.postData || '{}');
  } catch (_) {
    cuerpo = {};
  }
  check(
    typeof cuerpo.heart === 'string' && cuerpo.heart.trim() !== '',
    'el cuerpo de /chat/completions incluye un heart no vacío',
    `heart=${JSON.stringify(cuerpo.heart)}`,
  );
  if (typeof cuerpo.heart === 'string' && cuerpo.heart.trim() !== '') {
    HEART_CHAT = cuerpo.heart.trim();
  }
  check(
    typeof cuerpo.question === 'string' && cuerpo.question.trim() !== '',
    'el cuerpo de /chat/completions incluye la pregunta',
    `question=${JSON.stringify(cuerpo.question || '').slice(0, 100)}`,
  );

  let respuesta = null;
  try {
    respuesta = await cliente.esperarRespuesta(respuestasAntes, 60000);
  } catch (error) {
    check(false, 'la API responde la consulta dentro del timeout generoso', error.message);
  }
  if (respuesta) {
    check(respuesta.status >= 200 && respuesta.status < 300, 'la API responde 2xx a la consulta', `HTTP ${respuesta.status}`);
  }

  let respuestaUI = null;
  try {
    respuestaUI = await cliente.esperar(
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
    return;
  }
  check(true, 'aparece una burbuja del asistente con respuesta no vacía', `${respuestaUI.visibleText.slice(0, 120)}`);
  await captura(cliente, 'consultas-chat');
}

async function comprobarConversaciones(cliente) {
  abrir('Mis conversaciones');

  const nav = await cliente.evaluar(`
    const botones = [...document.querySelectorAll('[data-panel="conversations"]')];
    return {
      count: botones.length,
      label: (botones[0]?.textContent || '').trim(),
    };
  `);
  check(nav.count === 1, 'la navegación autenticada expone Conversaciones', `data-panel="conversations" x${nav.count}`);
  check(nav.label === 'Conversaciones', 'la sección se llama "Conversaciones"', nav.label);

  // Un front que todavía no tiene la sección no debe abortar el resto del
  // arnés: se informa del fallo y se sigue con las demás comprobaciones.
  if (!nav.count) {
    return;
  }

  await clic(cliente, '[data-panel="conversations"]');
  await dormir(400);

  let fila = null;
  try {
    fila = await cliente.esperar(
      `(() => {
        const row = document.querySelector('#conversations-list article');
        if (!row) return null;
        const title = (row.querySelector('h2')?.textContent || '').trim();
        const id = row.dataset.conversationId || '';
        return title && id ? { title, id } : null;
      })()`,
      { timeout: 30000, etiqueta: 'la lista muestra una fila de conversación' },
    );
  } catch (error) {
    const observed = await cliente.evaluar(`
      const list = document.querySelector('#conversations-list');
      return list ? (list.textContent || '').trim().slice(0, 300) : 'sin lista';
    `);
    check(false, 'la lista de conversaciones muestra al menos una fila', observed);
    return;
  }
  check(true, 'la lista de conversaciones muestra al menos una fila', fila.title);

  // La fila debe traer el título y el conteo que devuelve la API, no texto
  // inventado por el front.
  const comparacion = await cliente.evaluar(`
    const base = (typeof window.__API_BASE__ === 'string' ? window.__API_BASE__ : '') || '';
    const heart = ${JSON.stringify(HEART_CHAT || 'default')};
    const row = document.querySelector('#conversations-list article');
    if (!row) return { error: 'sin fila' };

    const response = await fetch(base + '/conversations?heart=' + encodeURIComponent(heart) + '&limit=20', {
      headers: { Accept: 'application/json' },
      credentials: 'include',
    });
    const payload = await response.json().catch(() => null);
    const data = payload && payload.data ? payload.data : {};
    const list = Array.isArray(data.conversations) ? data.conversations : [];
    const first = list[0] || null;

    const rowId = row.dataset.conversationId || '';
    const rowTitle = (row.querySelector('h2')?.textContent || '').trim();
    const rowText = (row.textContent || '').trim();
    const expectedTitle = first ? (String(first.title || '').trim() || 'Conversación sin título') : '';
    const expectedCount = first
      ? new Intl.NumberFormat('es-CL').format(Number(first.message_count) || 0) + ' mensajes'
      : '';

    return {
      status: response.status,
      total: list.length,
      apiId: first ? String(first.id || '') : '',
      apiTitle: first ? String(first.title || '') : '',
      rowId,
      rowTitle,
      expectedTitle,
      expectedCount,
      idMatches: first ? rowId === String(first.id || '') : false,
      titleMatches: expectedTitle ? rowTitle === expectedTitle : false,
      countMatches: expectedCount ? rowText.includes(expectedCount) : false,
      meta: (row.querySelector('p')?.textContent || '').trim(),
    };
  `);

  check(
    comparacion.status === 200 && comparacion.total >= 1,
    'la API lista las conversaciones de la cuenta autenticada',
    `HTTP ${comparacion.status}, total=${comparacion.total}`,
  );
  check(comparacion.idMatches, 'la fila corresponde a la conversación que devuelve la API', `fila=${comparacion.rowId}, api=${comparacion.apiId}`);
  check(comparacion.titleMatches, 'la fila muestra el título real de la conversación', `fila=${comparacion.rowTitle}`);
  check(comparacion.countMatches, 'la fila muestra el conteo de mensajes', `fila=${comparacion.meta}`);

  try {
    await clicPorTexto(cliente, 'Ver conversación', '#conversations-list article');
  } catch (error) {
    check(false, '"Ver conversación" expande la fila con la transcripción', error.message);
    return;
  }
  const transcripcion = await cliente.esperar(
    `(() => {
      const row = document.querySelector('#conversations-list article');
      const panel = row?.querySelector('[data-transcript]');
      if (!panel || panel.classList.contains('hidden')) return null;
      const text = (panel.textContent || '').trim();
      if (!text || text.includes('Cargando la conversación')) return null;
      return {
        text,
        user: [...panel.querySelectorAll('[data-role="user"]')].map((n) => (n.textContent || '').trim()),
        assistant: [...panel.querySelectorAll('[data-role="assistant"]')].map((n) => (n.textContent || '').trim()),
      };
    })()`,
    { timeout: 30000, etiqueta: 'la transcripción se muestra dentro de la fila' },
  ).catch(() => null);

  check(!!transcripcion, '"Ver conversación" expande la fila con la transcripción', transcripcion ? transcripcion.text.slice(0, 120) : 'no apareció la transcripción');

  if (transcripcion) {
    const usuario = transcripcion.user.join(' ');
    const asistente = transcripcion.assistant.join(' ');
    check(usuario.includes('frase de prueba'), 'la transcripción muestra la pregunta del usuario', usuario.slice(0, 140));
    check(asistente.trim().length > 0, 'la transcripción muestra la respuesta del asistente', asistente.slice(0, 140));
  }

  const idAbierto = await cliente.evaluar(`
    return document.querySelector('#conversations-list article')?.dataset.conversationId || '';
  `);
  try {
    await clicPorTexto(cliente, 'Abrir en el chat', '#conversations-list article');
  } catch (error) {
    check(false, '"Abrir en el chat" lleva al panel Consultas', error.message);
    return;
  }
  await dormir(600);

  const destino = await cliente.evaluar(`
    const chat = document.querySelector('#panel-chat');
    const conv = document.querySelector('#panel-conversations');
    let stored = '';
    try { stored = sessionStorage.getItem('chat_conversation_id') || ''; } catch (_) { stored = ''; }
    return {
      chatVisible: !!(chat && !chat.classList.contains('hidden') && chat.getClientRects().length),
      convHidden: !!(conv && (conv.classList.contains('hidden') || !conv.getClientRects().length)),
      widgetId: window.chatWidget ? window.chatWidget.conversationId : null,
      stored,
    };
  `);

  check(destino.chatVisible && destino.convHidden, '"Abrir en el chat" lleva al panel Consultas', JSON.stringify(destino));
  check(destino.widgetId === idAbierto, 'el chat continúa la conversación abierta', `widget=${destino.widgetId}, fila=${idAbierto}`);
  check(destino.stored === idAbierto, 'la conversación abierta queda guardada para la pestaña', `sessionStorage=${destino.stored}, fila=${idAbierto}`);
}

// Busca una ley real por su número y comprueba que el panel muestra el texto
// oficial tal como lo devuelve la API: el encabezado, los estados de vigencia
// y verificación, el enlace a la fuente y los artículos (incluido el artículo
// 1 del cuerpo, que el caché legal solía mostrar con el texto equivocado).
//
// Consultar una ley es gratis: la comprobación final verifica que el saldo
// no se movió y que no se llamó a la billetera ni a los créditos.
async function comprobarLeyes(cliente) {
  abrir('Buscador de leyes');

  const nav = await cliente.evaluar(`
    const botones = [...document.querySelectorAll('[data-panel="laws"]')];
    return {
      count: botones.length,
      label: (botones[0]?.textContent || '').trim(),
    };
  `);
  check(nav.count === 1, 'la navegación autenticada expone Leyes', `data-panel="laws" x${nav.count}`);
  check(nav.label === 'Leyes', 'la sección se llama "Leyes"', nav.label);

  // Un front que todavía no tiene la sección no debe abortar el resto del
  // arnés: se informa del fallo y se sigue con las demás comprobaciones.
  if (!nav.count) {
    return;
  }

  await clic(cliente, '[data-panel="laws"]');
  await dormir(400);

  const seccion = await cliente.evaluar(`
    const panel = document.querySelector('#panel-laws');
    const numero = document.querySelector('#laws-numero');
    const articulo = document.querySelector('#laws-articulo');
    const submit = document.querySelector('#laws-submit');
    const copy = (document.querySelector('#panel-laws header p')?.textContent || '').replace(/\\s+/g, ' ').trim();
    return {
      visible: !!(panel && !panel.classList.contains('hidden') && panel.getClientRects().length),
      titulo: (document.querySelector('#panel-laws h1')?.textContent || '').trim(),
      copy,
      numero: !!numero,
      articulo: !!articulo,
      submit: !!submit,
      numeroLabel: (document.querySelector('label[for="laws-numero"]')?.textContent || '').trim(),
      articuloLabel: (document.querySelector('label[for="laws-articulo"]')?.textContent || '').trim(),
      numeroPlaceholder: numero ? (numero.getAttribute('placeholder') || '') : '',
      articuloPlaceholder: articulo ? (articulo.getAttribute('placeholder') || '') : '',
      submitLabel: submit ? (submit.textContent || '').trim() : '',
    };
  `);
  check(seccion.visible && seccion.numero && seccion.articulo && seccion.submit, 'el panel Leyes muestra el formulario de búsqueda', JSON.stringify({ visible: seccion.visible, numero: seccion.numero, articulo: seccion.articulo, submit: seccion.submit }));
  check(seccion.titulo === 'Buscador de leyes', 'el panel se titula "Buscador de leyes"', seccion.titulo);
  check(seccion.numeroLabel === 'Número de la ley', 'el número de la ley tiene su etiqueta', seccion.numeroLabel);
  check(seccion.articuloLabel === 'Artículo (opcional)', 'el artículo es un campo opcional con etiqueta', seccion.articuloLabel);
  check(seccion.numeroPlaceholder === 'Por ejemplo: 19.628', 'el campo del número sugiere el ejemplo 19.628', seccion.numeroPlaceholder);
  check(seccion.articuloPlaceholder === 'Artículo (opcional)', 'el campo del artículo se declara opcional', seccion.articuloPlaceholder);
  check(seccion.submitLabel === 'Buscar', 'el formulario tiene el botón "Buscar"', seccion.submitLabel);
  check(seccion.copy.includes('Consultar una ley es gratis: no usa créditos.'), 'el panel dice que consultar una ley es gratis', seccion.copy);

  // El saldo se lee DESPUÉS de entrar al panel: así cualquier refresco de la
  // sesión que el chat deja en vuelo ya terminó y la comparación mide sólo
  // el efecto de la consulta legal.
  const saldoAntes = await cliente.evaluar(`
    return (document.querySelector('#mobile-balance')?.textContent || '').trim();
  `);
  const peticionesAntes = cliente.peticiones.length;

  await escribir(cliente, '#laws-numero', '19628');
  await clic(cliente, '#laws-submit');

  let busqueda = null;
  try {
    busqueda = await cliente.esperar(
      `(() => {
        const card = document.querySelector('#laws-results article[data-law-numero]');
        if (!card) return null;
        const articulos = [...card.querySelectorAll('[data-article-numero]')];
        if (!articulos.length) return null;
        return {
          titulo: (card.querySelector('h2')?.textContent || '').trim(),
          articulos: articulos.length,
        };
      })()`,
      { timeout: 60000, etiqueta: 'la ley 19.628 aparece con sus artículos' },
    );
  } catch (error) {
    const observed = await cliente.evaluar(`
      const results = document.querySelector('#laws-results');
      return results ? (results.textContent || '').trim().slice(0, 300) : 'sin resultados';
    `);
    check(false, 'la búsqueda muestra la ley 19.628 con sus artículos', observed);
    return;
  }
  check(true, 'la búsqueda muestra la ley 19.628 con sus artículos', `${busqueda.articulos} artículos · ${busqueda.titulo}`);

  // La API es la autoridad: se vuelve a consultar en la página y se compara
  // con lo que el panel muestra.
  const comparacion = await cliente.evaluar(`
    const base = (typeof window.__API_BASE__ === 'string' ? window.__API_BASE__ : '') || '';
    const heart = ${JSON.stringify(HEART_CHAT || 'default')};
    const response = await fetch(base + '/laws/search?numero=19628&heart=' + encodeURIComponent(heart), {
      headers: { Accept: 'application/json' },
      credentials: 'include',
    });
    const payload = await response.json().catch(() => null);
    const data = payload && payload.data ? payload.data : {};
    const card = document.querySelector('#laws-results article[data-law-numero]');
    const articulos = card ? [...card.querySelectorAll('[data-article-numero]')] : [];
    return {
      status: response.status,
      titulo: String(data.titulo || ''),
      total: Number(data.total_articulos),
      totalTexto: new Intl.NumberFormat('es-CL').format(Number(data.total_articulos) || 0) + ' artículos en total',
      cardTitulo: card ? String(card.querySelector('h2')?.textContent || '').trim() : '',
      cardTexto: card ? String(card.textContent || '') : '',
      articulos: articulos.length,
      primeroNumero: articulos[0] ? String(articulos[0].dataset.articleNumero || '') : '',
      primeroTexto: articulos[0] ? String(articulos[0].querySelector('p')?.textContent || '').trim() : '',
      repeticiones: articulos.filter((item) => item.dataset.articleNumero === '1').length,
      textosUno: articulos
        .filter((item) => item.dataset.articleNumero === '1')
        .map((item) => String(item.querySelector('p')?.textContent || '').trim()),
      href: card ? String(card.querySelector('a[href]')?.href || '') : '',
    };
  `);

  check(comparacion.status === 200, 'la API responde la búsqueda de la ley 19.628', `HTTP ${comparacion.status}`);
  check(comparacion.cardTitulo === comparacion.titulo && comparacion.titulo !== '', 'el panel muestra el título real de la ley', `panel=${comparacion.cardTitulo}`);
  check(comparacion.cardTexto.includes(comparacion.totalTexto), 'el panel muestra el total de artículos de la ley', comparacion.totalTexto);
  check(comparacion.articulos >= 1 && comparacion.primeroTexto.length > 0, 'el panel muestra el texto de al menos un artículo', `${comparacion.articulos} artículos`);
  check(
    comparacion.primeroNumero === '1' && comparacion.primeroTexto.startsWith('El tratamiento de los datos de carácter personal'),
    'el artículo 1 mostrado es el del cuerpo de la ley',
    comparacion.primeroTexto.slice(0, 90),
  );
  check(
    comparacion.textosUno.length >= 2 && comparacion.textosUno[0] !== comparacion.textosUno[1],
    'la ley refundida muestra las repeticiones sin ocultarlas',
    `repeticiones del artículo 1=${comparacion.repeticiones}`,
  );
  check(
    comparacion.cardTexto.includes('repite algunos números de artículo'),
    'el panel explica por qué se repiten los números de artículo',
  );
  check(comparacion.cardTexto.includes('Vigente'), 'el panel muestra el estado de vigencia "Vigente"');
  check(comparacion.cardTexto.includes('Texto oficial verificado'), 'el panel muestra que el texto oficial está verificado');
  check(
    comparacion.href !== '' && /^https?:\/\//.test(comparacion.href),
    'el panel enlaza a la fuente oficial',
    comparacion.href,
  );

  // Una ley que no existe: el mensaje honesto del servidor, sin romper el panel.
  await escribir(cliente, '#laws-numero', '999999999');
  await clic(cliente, '#laws-submit');

  let inexistente = null;
  try {
    inexistente = await cliente.esperar(
      `(() => {
        const results = document.querySelector('#laws-results');
        const text = results ? (results.textContent || '') : '';
        return text.includes('No encontramos una ley con ese número.') ? text.trim() : null;
      })()`,
      { timeout: 30000, etiqueta: 'aparece el mensaje de ley inexistente' },
    );
  } catch (error) {
    check(false, 'una ley inexistente muestra el mensaje honesto de la API', error.message);
  }
  if (inexistente) {
    check(true, 'una ley inexistente muestra el mensaje honesto de la API', inexistente.slice(0, 120));
  }

  // Un artículo puntual: exactamente uno, y el del cuerpo de la ley.
  await escribir(cliente, '#laws-numero', '19628');
  await escribir(cliente, '#laws-articulo', '1');
  await clic(cliente, '#laws-submit');

  let articulo = null;
  try {
    articulo = await cliente.esperar(
      `(() => {
        const card = document.querySelector('#laws-results article[data-law-numero]');
        if (!card) return null;
        const articulos = [...card.querySelectorAll('[data-article-numero]')];
        if (!articulos.length) return null;
        return {
          count: articulos.length,
          numero: articulos[0].dataset.articleNumero || '',
          texto: (articulos[0].querySelector('p')?.textContent || '').trim(),
          titulo: (card.querySelector('h2')?.textContent || '').trim(),
          textoPanel: (card.textContent || '').trim(),
        };
      })()`,
      { timeout: 60000, etiqueta: 'el artículo pedido aparece' },
    );
  } catch (error) {
    const observed = await cliente.evaluar(`
      const results = document.querySelector('#laws-results');
      return results ? (results.textContent || '').trim().slice(0, 300) : 'sin resultados';
    `);
    check(false, 'buscar un artículo muestra exactamente un artículo', observed);
    return;
  }
  check(articulo.count === 1, 'buscar un artículo muestra exactamente un artículo', `${articulo.count} artículos`);
  check(articulo.numero === '1' && articulo.texto.startsWith('El tratamiento de los datos de carácter personal'), 'el artículo pedido es el del cuerpo de la ley', articulo.texto.slice(0, 90));
  check(!articulo.textoPanel.includes('No encontramos ese artículo'), 'el artículo pedido existe en la ley');

  // Consultar una ley es gratis: el saldo no se mueve y no se llama a la
  // billetera, a los créditos ni al chat.
  const saldoDespues = await cliente.evaluar(`
    return (document.querySelector('#mobile-balance')?.textContent || '').trim();
  `);
  check(saldoDespues === saldoAntes, 'consultar una ley no cambia el saldo', `antes=${saldoAntes}, después=${saldoDespues}`);

  const llamadas = cliente.peticiones.slice(peticionesAntes).filter((peticion) => (
    /\/(credits|payments|wallet)\//.test(peticion.url) || peticion.url.includes('/chat/completions')
  ));
  check(llamadas.length === 0, 'consultar una ley no llama a la billetera ni a los créditos', llamadas.length ? llamadas.map((p) => p.url).join(', ') : '0 llamadas');

  const modal = await cliente.evaluar(`
    const texto = document.body.innerText || '';
    const overlays = [...document.querySelectorAll('[role="dialog"], [id*="modal" i], [class*="modal" i]')]
      .filter((el) => el.getClientRects().length);
    return {
      costo: texto.includes('costará') || texto.includes('Esta acción cuesta'),
      overlays: overlays.length,
    };
  `);
  check(!modal.costo && modal.overlays === 0, 'consultar una ley no muestra un modal de costo', JSON.stringify(modal));

  await captura(cliente, 'leyes-buscador');
}

async function comprobarDocumentos(cliente) {
  abrir('Biblioteca de documentos');

  await clic(cliente, '[data-panel="documents"]');
  await dormir(350);

  const vacio = await cliente.esperar(
    `(() => {
      const list = document.querySelector('#documents-list');
      const text = list ? (list.textContent || '') : '';
      return text.includes('Todavía no tienes documentos guardados') ? text : null;
    })()`,
    { timeout: 20000, etiqueta: 'aparece el estado vacío' },
  ).catch(() => null);
  check(!!vacio, 'la biblioteca muestra el estado vacío para una cuenta nueva', vacio ? 'texto encontrado' : 'no apareció "Todavía no tienes documentos guardados"');

  if (SKIP_UPLOAD) return;

  const ruta = '/tmp/opencode/qa-documento.txt';
  const frase = 'Este documento de prueba describe un acuerdo de mediación familiar.';
  mkdirSync('/tmp/opencode', { recursive: true });
  writeFileSync(ruta, `${frase}\nLa fecha de referencia es el 10 de noviembre de 2026.\n`, 'utf8');

  await cliente.evaluar(`window.__cdpPanelVivo = ${Date.now()}; return true;`);
  await establecerArchivo(cliente, '#file-input', [ruta]);

  let preview = null;
  try {
    preview = await cliente.esperar(
      `(() => {
        const result = document.querySelector('#result');
        const text = document.querySelector('#result-text');
        if (!result || result.classList.contains('hidden')) return null;
        const value = text ? (text.textContent || '') : '';
        return value.includes(${JSON.stringify(frase)}) ? value : null;
      })()`,
      { timeout: 20000, etiqueta: 'aparece la vista previa de extracción' },
    );
  } catch (error) {
    check(false, 'la extracción muestra la vista previa con el texto leído', error.message);
    return;
  }
  check(true, 'la extracción muestra la vista previa con el texto leído', preview.slice(0, 120));

  await clic(cliente, '#confirm-btn');

  let exito = null;
  try {
    exito = await cliente.esperar(
      `(() => {
        const el = document.querySelector('#success');
        if (!el || el.classList.contains('hidden')) return null;
        const text = (el.textContent || '').trim();
        return text || null;
      })()`,
      { timeout: 30000, etiqueta: 'aparece el estado de éxito' },
    );
  } catch (error) {
    check(false, 'confirmar el documento muestra el estado de éxito', error.message);
    return;
  }
  check(true, 'confirmar el documento muestra el estado de éxito', exito.slice(0, 140));

  let fila = null;
  try {
    fila = await cliente.esperar(
      `(() => {
        const rows = document.querySelectorAll('#documents-list article');
        if (rows.length !== 1) return null;
        const row = rows[0];
        const title = (row.querySelector('h2')?.textContent || '').trim();
        return title.includes('qa-documento.txt') ? { title, text: row.textContent || '' } : null;
      })()`,
      { timeout: 30000, etiqueta: 'la biblioteca muestra una fila con el título' },
    );
  } catch (error) {
    const observed = await cliente.evaluar(`
      const rows = [...document.querySelectorAll('#documents-list article')];
      return JSON.stringify(rows.map((row) => ({
        title: (row.querySelector('h2')?.textContent || '').trim(),
        text: (row.textContent || '').trim().slice(0, 300),
      })));
    `);
    check(false, 'la biblioteca muestra exactamente una fila con el título del archivo', observed);
    return;
  }
  check(true, 'la biblioteca muestra exactamente una fila con el título del archivo', fila.title);
  await captura(cliente, 'documentos-biblioteca');

  const sinRecarga = await cliente.evaluar(`
    return {
      marker: typeof window.__cdpPanelVivo !== 'undefined' ? window.__cdpPanelVivo : null,
      navigations: performance.getEntriesByType('navigation').length,
    };
  `);
  check(
    sinRecarga.marker !== null && sinRecarga.navigations === 1,
    'la biblioteca se actualizó sin recargar la página',
    JSON.stringify(sinRecarga),
  );

  await clicPorTexto(cliente, 'Ver texto', '#documents-list article');
  let textoGuardado = null;
  try {
    textoGuardado = await cliente.esperar(
      `(() => {
        const row = document.querySelector('#documents-list article');
        if (!row) return null;
        const panel = [...row.querySelectorAll('div')].find((el) => el.classList.contains('rounded-xl') && !el.classList.contains('hidden'));
        const pre = panel?.querySelector('pre');
        const text = pre ? (pre.textContent || '') : '';
        return text.includes(${JSON.stringify(frase)}) ? text : null;
      })()`,
      { timeout: 15000, etiqueta: 'el texto guardado se muestra' },
    );
  } catch (error) {
    const observed = await cliente.evaluar(`
      const row = document.querySelector('#documents-list article');
      return row ? (row.textContent || '').slice(0, 500) : 'sin fila';
    `);
    check(false, 'Ver texto muestra el contenido almacenado', observed);
    return;
  }
  check(true, 'Ver texto muestra el contenido almacenado', textoGuardado.slice(0, 140));

  const antesToggle = await cliente.evaluar(`
    const row = document.querySelector('#documents-list article');
    const button = row?.querySelector('button[aria-pressed]');
    const states = [...(row?.querySelectorAll('span') || [])]
      .map((el) => (el.textContent || '').trim())
      .filter((text) => text.includes('chat'));
    return {
      label: (button?.textContent || '').trim(),
      pressed: button?.getAttribute('aria-pressed') || null,
      state: states[0] || '',
    };
  `);
  await clic(cliente, '#documents-list article button[aria-pressed]');
  let despuesToggle = null;
  try {
    despuesToggle = await cliente.esperar(
      `(() => {
        const row = document.querySelector('#documents-list article');
        const button = row?.querySelector('button[aria-pressed]');
        const states = [...(row?.querySelectorAll('span') || [])]
          .map((el) => (el.textContent || '').trim())
          .filter((text) => text.includes('chat'));
        const current = {
          label: (button?.textContent || '').trim(),
          pressed: button?.getAttribute('aria-pressed') || null,
          state: states[0] || '',
        };
        return current.label !== ${JSON.stringify(antesToggle.label)} ? current : null;
      })()`,
      { timeout: 15000, etiqueta: 'el toggle de chat cambia' },
    );
  } catch (error) {
    check(false, 'el toggle cambia la etiqueta y el estado de uso en el chat', `antes=${JSON.stringify(antesToggle)}`);
    return;
  }
  check(
    despuesToggle.label !== antesToggle.label &&
      despuesToggle.pressed !== antesToggle.pressed &&
      despuesToggle.state !== antesToggle.state,
    'el toggle cambia la etiqueta y el estado de uso en el chat',
    `antes=${JSON.stringify(antesToggle)} después=${JSON.stringify(despuesToggle)}`,
  );

  const deletesAntes = cliente.peticiones.filter((p) => p.metodo === 'DELETE' && p.url.includes('/rag/sources')).length;
  const dialogo = await clicConDialogo(cliente, 'Eliminar', '#documents-list article', false);
  check(dialogo.type === 'confirm', 'Eliminar abre un diálogo de confirmación', `tipo=${dialogo.type}, mensaje=${dialogo.message}`);
  await dormir(500);

  const trasCancelar = await cliente.evaluar(`
    return {
      rows: document.querySelectorAll('#documents-list article').length,
      empty: (document.querySelector('#documents-list')?.textContent || '').includes('Todavía no tienes documentos guardados'),
    };
  `);
  const deletesTrasCancelar = cliente.peticiones.filter((p) => p.metodo === 'DELETE' && p.url.includes('/rag/sources')).length;
  check(trasCancelar.rows === 1 && !trasCancelar.empty, 'dismiss del diálogo conserva la fila', JSON.stringify(trasCancelar));
  check(deletesTrasCancelar === deletesAntes, 'dismiss del diálogo no llama DELETE /rag/sources', `deletes=${deletesTrasCancelar}`);

  await clicConDialogo(cliente, 'Eliminar', '#documents-list article', true);
  let eliminado = null;
  try {
    eliminado = await cliente.esperar(
      `(() => {
        const list = document.querySelector('#documents-list');
        const rows = document.querySelectorAll('#documents-list article').length;
        const empty = list ? (list.textContent || '').includes('Todavía no tienes documentos guardados') : false;
        return rows === 0 && empty ? { rows, empty } : null;
      })()`,
      { timeout: 30000, etiqueta: 'la fila se elimina y vuelve el estado vacío' },
    );
  } catch (error) {
    const observed = await cliente.evaluar(`
      const list = document.querySelector('#documents-list');
      return JSON.stringify({ rows: document.querySelectorAll('#documents-list article').length, text: (list?.textContent || '').trim().slice(0, 300) });
    `);
    check(false, 'aceptar el diálogo elimina la fila y devuelve el estado vacío', observed);
    return;
  }
  check(true, 'aceptar el diálogo elimina la fila y devuelve el estado vacío', JSON.stringify(eliminado));
}

function esRuidoDeTerceros(entrada) {
  const texto = `${entrada.url || ''} ${entrada.texto || ''}`.toLowerCase();
  if (texto.includes('favicon.ico')) return true;
  // La detección inicial de sesión responde 401 cuando todavía no hay cookie;
  // es el flujo esperado del login, no un error de la aplicación.
  if (
    entrada.source === 'network' &&
    texto.includes('/auth/me') &&
    texto.includes('401')
  ) {
    return true;
  }
  // La prueba del buscador pide A PROPÓSITO una ley que no existe: el 404 del
  // servidor es la respuesta esperada, no un error de la aplicación.
  if (
    entrada.source === 'network' &&
    texto.includes('/laws/search') &&
    texto.includes('999999999') &&
    texto.includes('404')
  ) {
    return true;
  }
  if (
    texto.includes('cloudflareinsights') ||
    texto.includes('static.cloudflareinsights.com') ||
    texto.includes('cdn-cgi/rum') ||
    texto.includes('beacon.min.js') ||
    texto.includes('google-analytics') ||
    texto.includes('googletagmanager') ||
    texto.includes('doubleclick.net')
  ) {
    return true;
  }
  return false;
}

function revisarConsola(cliente) {
  abrir('Errores de página y consola');

  const excepciones = cliente.consola.filter((entrada) => entrada.nivel === 'exception');
  check(excepciones.length === 0, 'no hay excepciones de página sin capturar', excepciones.length ? `${excepciones.length} excepciones` : '');
  for (const entrada of excepciones.slice(0, 8)) {
    console.log(`       · [exception] ${String(entrada.texto).slice(0, 240)}`);
  }

  const errores = cliente.consola.filter((entrada) => {
    if (!['error', 'exception'].includes(entrada.nivel)) return false;
    return !esRuidoDeTerceros(entrada);
  });
  check(errores.length === 0, 'no hay errores de consola causados por la aplicación', errores.length ? `${errores.length} errores` : '');
  for (const entrada of errores.slice(0, 10)) {
    console.log(`       · [${entrada.nivel}/${entrada.source}] ${String(entrada.texto).slice(0, 240)} ${entrada.url || ''}`);
  }
}

// ----- Corriente principal ----------------------------------------------------

const { cliente, targetId, socket } = await conectar();

try {
  console.log(`\n\x1b[1mcdp_panel_test\x1b[0m — front: ${URL_BASE}  ·  api: ${API_ESPERADA}  ·  cuenta: ${EMAIL}`);
  if (SKIP_CHAT || SKIP_UPLOAD) {
    console.log(`\x1b[33mmodo depuración\x1b[0m — skip-chat=${SKIP_CHAT}, skip-upload=${SKIP_UPLOAD}`);
  }

  await ir(cliente, `${URL_BASE}/`);
  await dormir(900);

  const autenticado = await iniciarSesion(cliente);
  if (autenticado) {
    await cliente.esperar(
      `(() => {
        const widgets = [...document.querySelectorAll('.chat-widget')];
        return widgets.length === 1 &&
          (widgets[0].id === 'chat-consultas' || !!widgets[0].closest('#chat-consultas'));
      })()`,
      { timeout: 15000, etiqueta: 'el widget de Consultas monta' },
    ).catch(() => {});

    await comprobarNavegacion(cliente);
    if (!SKIP_CHAT) await enviarUnaConsulta(cliente);
    if (!SKIP_CHAT) await comprobarConversaciones(cliente);
    await comprobarLeyes(cliente);
    await comprobarDocumentos(cliente);
  }

  revisarConsola(cliente);
} catch (error) {
  registro.fallos.push({ seccion: 'ejecución', etiqueta: 'error fatal', extra: error.message });
  console.log(`\n\x1b[31merror fatal\x1b[0m ${error.message}`);
} finally {
  if (!KEEP_OPEN) {
    await cliente.enviar('Target.closeTarget', { targetId }).catch(() => {});
  }
  socket.close();
}

const total = registro.ok + registro.fallos.length;
console.log(`\n\x1b[1mResumen\x1b[0m: ${total} assertions, ${registro.ok} passed, ${registro.fallos.length} failed`);
for (const fallo of registro.fallos) {
  console.log(`  \x1b[31m✗\x1b[0m ${fallo.seccion} → ${fallo.etiqueta}${fallo.extra ? ' — observado: ' + fallo.extra : ''}`);
}

process.exit(registro.fallos.length === 0 ? 0 : 1);
