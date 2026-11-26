#!/usr/bin/env node
// =============================================================================
// cdp_bubble_visual.mjs — QA visual reutilizable de las burbujas del chat.
//
// Abre el front real, inicia sesión, escribe en Consultas y captura las
// burbujas en modo día y noche. Con --local-css inyecta al final del <head>
// el CSS local de css/tokens.css y css/tailwind.css para verificar un cambio
// sin desplegar.
//
// Uso:
//   QA_EMAIL=<correo> QA_PASSWORD=<clave> \
//     node tests/cdp_bubble_visual.mjs --local-css --label despues
// =============================================================================

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cdpPort = Number(process.env.CDP_PORT || 9333);
const cdpBase = `http://127.0.0.1:${cdpPort}`;
const front = String(process.env.FRONT || 'https://asisjud.djlabs.cl').replace(/\/+$/, '');
const email = String(process.env.QA_EMAIL || '');
const password = String(process.env.QA_PASSWORD || '');
const question = String(process.env.QUESTION || 'dime más acerca de la ley de datos');
const useLocalCss = argv.includes('--local-css') || process.env.LOCAL_CSS === '1';
const labelIndex = argv.indexOf('--label');
const label = String(process.env.LABEL || (labelIndex >= 0 ? argv[labelIndex + 1] : '') || (useLocalCss ? 'despues' : 'antes'));
const shotsDir = '/tmp/opencode/shots';

if (!email || !password) {
  console.error('FALLO: define QA_EMAIL y QA_PASSWORD.');
  process.exit(1);
}

mkdirSync(shotsDir, { recursive: true });
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

const client = {
  id: 0,
  socket: null,
  sessionId: null,
  pending: new Map(),
};

async function connect() {
  const version = await (await fetch(`${cdpBase}/json/version`)).json();
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolvePromise, rejectPromise) => {
    socket.addEventListener('open', resolvePromise, { once: true });
    socket.addEventListener('error', () => rejectPromise(new Error('no se pudo conectar al CDP')), { once: true });
  });

  client.socket = socket;
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !client.pending.has(message.id)) return;
    const { resolve: resolvePromise, reject: rejectPromise } = client.pending.get(message.id);
    client.pending.delete(message.id);
    if (message.error) {
      rejectPromise(new Error(`${message.error.message} (${JSON.stringify(message.error.data || '')})`));
    } else {
      resolvePromise(message.result);
    }
  });

  const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
  client.sessionId = sessionId;
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Network.enable');
  await client.send('Network.setCacheDisabled', { cacheDisabled: true }).catch(() => {});
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

client.send = (method, params = {}) => new Promise((resolvePromise, rejectPromise) => {
  const id = ++client.id;
  client.pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
  const payload = { id, method, params };
  if (client.sessionId) payload.sessionId = client.sessionId;
  client.socket.send(JSON.stringify(payload));
});

async function evaluate(expression) {
  const result = await client.send('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
    throw new Error(detail || 'error de Runtime.evaluate');
  }
  return result.result?.value;
}

async function waitFor(expression, timeout = 30000, interval = 150) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const value = await evaluate(expression);
      if (value) return value;
    } catch (_) {
      // La navegación puede invalidar el contexto durante unos milisegundos.
    }
    await sleep(interval);
  }
  throw new Error(`timeout esperando: ${expression.slice(0, 100)}`);
}

async function navigate(url) {
  await client.send('Page.navigate', { url });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const ready = await evaluate('return document.readyState;').catch(() => null);
    if (ready === 'complete') return;
    await sleep(150);
  }
  throw new Error('la página no cargó');
}

async function click(selector) {
  const position = await evaluate(`
    const elements = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const visible = elements.find((element) => (
      element.getClientRects().length && !element.classList.contains('hidden')
    ));
    if (!visible) return null;
    visible.scrollIntoView({ block: 'center', behavior: 'instant' });
    const rect = visible.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  `);
  if (!position) throw new Error(`no existe visible: ${selector}`);
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: position.x, y: position.y, button: 'left', buttons: 1, clickCount: 1,
  });
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: position.x, y: position.y, button: 'left', buttons: 0, clickCount: 1,
  });
  await sleep(300);
}

async function type(selector, text) {
  const found = await evaluate(`
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    element.focus();
    element.value = '';
    element.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `);
  if (!found) throw new Error(`no existe: ${selector}`);
  await client.send('Input.insertText', { text });
  await evaluate(`
    document.querySelector(${JSON.stringify(selector)})
      .dispatchEvent(new Event('input', { bubbles: true }));
  `);
}

async function injectLocalCss() {
  const files = [
    join(repoRoot, 'css', 'tokens.css'),
    join(repoRoot, 'css', 'tailwind.css'),
  ];
  const css = files.map((file) => readFileSync(file, 'utf8')).join('\n');
  const details = await evaluate(`
    const previous = document.getElementById('local-qa-css');
    if (previous) previous.remove();
    const style = document.createElement('style');
    style.id = 'local-qa-css';
    style.textContent = ${JSON.stringify(css)};
    document.head.appendChild(style);
    return {
      bytes: style.textContent.length,
      files: ${JSON.stringify(files)},
      isLastHeadChild: document.head.lastElementChild === style,
    };
  `);
  console.log('CSS local inyectado:', JSON.stringify(details));
}

async function login() {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await waitFor(`return !!document.querySelector('#login-form');`, 20000);
      await type('#login-email', email);
      await type('#login-password', password);
      await click('#login-form button[type="submit"]');
      await waitFor(`
        const dashboard = document.querySelector('#view-dashboard');
        return !!(dashboard && !dashboard.classList.contains('hidden'));
      `, 30000);
      console.log(`login OK (intento ${attempt})`);
      return;
    } catch (error) {
      lastError = error;
      console.error(`login intento ${attempt}/2 falló: ${error.message}`);
      if (attempt === 1) {
        await navigate(front);
        await sleep(500);
      }
    }
  }
  throw new Error(`login falló tras 2 intentos; último error exacto: ${lastError?.message || 'desconocido'}`);
}

async function askQuestion() {
  const before = await evaluate(`
    return [...document.querySelectorAll('.chat-messages > div')]
      .filter((row) => row.querySelector('.bubble-assistant')).length;
  `);
  await type('.chat-widget textarea', question);
  await click('.chat-widget button[type="submit"]');
  console.log('pregunta enviada:', question);

  const bubble = await waitFor(`
    const rows = [...document.querySelectorAll('.chat-messages > div')];
    const assistantRows = rows.filter((row) => row.querySelector('.bubble-assistant'));
    if (assistantRows.length <= ${before}) return null;
    const element = assistantRows[assistantRows.length - 1].querySelector('.bubble-assistant');
    const text = (element?.textContent || '').trim();
    if (text.replace(/[.\\s]/g, '').length < 20) return null;
    return { text, html: element.innerHTML.slice(0, 600) };
  `, 120000, 300);
  console.log('\n=== RESPUESTA VISIBLE ===\n' + bubble.text.slice(0, 1200));
  console.log('\n=== HTML BURBUJA ===\n' + bubble.html);
}

async function collectStyles() {
  return evaluate(`
    const parse = (value) => {
      const numbers = String(value).match(/[\\d.]+/g)?.map(Number) || [];
      return { r: numbers[0] || 0, g: numbers[1] || 0, b: numbers[2] || 0, a: numbers[3] ?? 1 };
    };
    const blend = (front, back) => {
      const alpha = front.a + back.a * (1 - front.a);
      return {
        r: (front.r * front.a + back.r * back.a * (1 - front.a)) / alpha,
        g: (front.g * front.a + back.g * back.a * (1 - front.a)) / alpha,
        b: (front.b * front.a + back.b * back.a * (1 - front.a)) / alpha,
        a: alpha,
      };
    };
    const realBackground = (element) => {
      const layers = [];
      let node = element;
      while (node) {
        const color = parse(getComputedStyle(node).backgroundColor);
        if (color.a > 0) layers.push(color);
        if (color.a >= 1) break;
        node = node.parentElement;
      }
      let result = { r: 255, g: 255, b: 255, a: 1 };
      for (let index = layers.length - 1; index >= 0; index -= 1) result = blend(layers[index], result);
      return result;
    };
    const luminance = (color) => {
      const channel = (value) => {
        const normalized = value / 255;
        return normalized <= 0.04045
          ? normalized / 12.92
          : Math.pow((normalized + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
    };
    const contrast = (front, back) => {
      const light = Math.max(luminance(front), luminance(back));
      const dark = Math.min(luminance(front), luminance(back));
      return (light + 0.05) / (dark + 0.05);
    };
    const round = (value) => Math.round(value * 100) / 100;
    const read = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const style = getComputedStyle(element);
      const background = realBackground(element);
      const foreground = blend(parse(style.color), background);
      const ratio = contrast(foreground, background);
      return {
        selector,
        background: style.backgroundColor,
        realBackground: 'rgb(' + [background.r, background.g, background.b].map(round).join(', ') + ')',
        color: style.color,
        fontWeight: style.fontWeight,
        fontSize: style.fontSize,
        textStroke: style.webkitTextStrokeWidth + ' ' + style.webkitTextStrokeColor,
        border: style.borderTopWidth + ' ' + style.borderTopStyle + ' ' + style.borderTopColor,
        boxShadow: style.boxShadow === 'none' ? 'none' : style.boxShadow,
        filter: style.filter,
        contrast: round(ratio),
        passesAA: ratio >= 4.5,
      };
    };
    const root = getComputedStyle(document.documentElement);
    return {
      theme: document.documentElement.getAttribute('data-tema'),
      skin: document.documentElement.getAttribute('data-skin'),
      tokens: {
        accent: root.getPropertyValue('--c-accent').trim(),
        accentSoft: root.getPropertyValue('--c-accent-soft').trim(),
        accentStrong: root.getPropertyValue('--c-accent-strong').trim(),
        text: root.getPropertyValue('--c-text').trim(),
        surface: root.getPropertyValue('--c-surface').trim(),
        borderSoft: root.getPropertyValue('--c-border-soft').trim(),
      },
      bubbles: [read('.bubble-user'), read('.bubble-assistant'), read('.chat-action-btn')],
    };
  `);
}

async function capture(name, clip) {
  const { data } = await client.send('Page.captureScreenshot', {
    format: 'png',
    ...(clip ? { clip: { ...clip, scale: 1 }, captureBeyondViewport: true } : {}),
  });
  const path = join(shotsDir, `${name}.png`);
  writeFileSync(path, Buffer.from(data, 'base64'));
  console.log('captura:', path);
  return path;
}

async function captureTheme(theme) {
  await evaluate(`
    document.documentElement.setAttribute('data-tema', ${JSON.stringify(theme)});
    document.documentElement.setAttribute('data-skin', 'fenix');
    return true;
  `);
  await sleep(500);
  const styles = await collectStyles();
  console.log(`\nESTILOS (${theme}):`, JSON.stringify(styles, null, 2));
  await capture(`${label}-${theme}-completo`);

  const clip = await evaluate(`
    const widget = document.querySelector('.chat-widget');
    const messages = document.querySelector('.chat-messages');
    const rect = (messages || widget).getBoundingClientRect();
    return {
      x: Math.max(0, rect.left - 8),
      y: Math.max(0, rect.top - 8),
      width: Math.min(1440, rect.width + 16),
      height: Math.min(1000, rect.height + 16),
    };
  `);
  await capture(`${label}-${theme}-burbujas`, clip);
}

async function main() {
  await connect();
  await navigate(front);
  console.log('página lista:', front);
  if (useLocalCss) await injectLocalCss();
  await login();
  await click('[data-panel="chat"]');
  await waitFor(`return !!document.querySelector('.chat-widget textarea');`, 25000);
  console.log('chat montado');
  await askQuestion();
  await captureTheme('dia');
  await captureTheme('noche');
}

main()
  .catch((error) => {
    console.error('FALLO:', error.message);
    process.exitCode = 1;
  })
  .finally(() => {
    if (client.socket) client.socket.close();
  });
