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
//   --email <correo>   cuenta QA (default qa.panel2@djlabs.cl)
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
const EMAIL = String(opcion('email', 'qa.panel2@djlabs.cl'));
const PASSWORD = String(opcion('password', 'Panel-QA-2026!x'));
const KEEP_OPEN = argv.includes('--keep-open');
const SKIP_CHAT = argv.includes('--skip-chat');
const SKIP_UPLOAD = argv.includes('--skip-upload');
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

async function iniciarSesion(cliente) {
  abrir('Autenticación real');

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
