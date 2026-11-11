# Front: menú burger, formulario de contacto y heart del aviso

## Objetivo

Que el front de `asisjud.djlabs.cl` (repo `asistentejudicial.djlabs.cl`) sirva un menú
burger funcional, un formulario de contacto que muestre el estado del envío sin recargar
la página, y que el aviso al administrador salga con la plantilla del producto (colores y
logo), no con la plantilla genérica.

## Problema

1. **Menú burger muerto.** El markup declara `#menu-toggle` y `#mobile-menu`, pero
   `js/app.js` cableaba `#mobile-menu-toggle`, `#mobile-nav`, `#mobile-nav-close` y
   `#mobile-nav-overlay` — IDs que no existen. Además el wiring vivía dentro de
   `wireDashboard()`, que solo corre con sesión iniciada: en la landing pública el
   botón jamás quedaba conectado.
2. **El formulario de contacto recargaba la página.** `#contact-form` no tenía handler
   JS: el navegador lo enviaba de forma nativa (navegación) y se perdía el estado del
   envío.
3. **Aviso con plantilla genérica.** El POST no viaja `heart`, así que el backend elige
   la plantilla por defecto en vez de la del producto.

## Por qué

Los tres fallos eran visibles para quien visita el sitio. Los dos primeros quedaron
probados con CDP (`tests/cdp_front_test.mjs`): antes del fix, el submit provocaba
navegación nativa (el marcador `window.__cdpVivo` desaparecía) y no se registraba ningún
POST a `/contact`.

## Alcance

- `js/app.js`: navegación móvil + handler del formulario de contacto.
- `js/inline/ley-datos/index-4.js`: el handler de contacto de esa superficie tampoco
  manda el `heart` (sí lo manda en registro/login).
- `tests/cdp_front_test.mjs`: arnés CDP (nuevo).
- CSP del front (`_headers` + meta en los HTML): permitir el beacon de Cloudflare
  Analytics, que hoy bloquea `script-src` y ensucia la consola.

Fuera de alcance: quitar `cdn.jsdelivr.net` y Google Fonts de la CSP. Los usan 23 y 21
archivos de este front respectivamente; retirarlos exige migrarlos a assets locales
primero.

## Ruta

- **Delegada (exploración):** un `explore` mapeó el front (IDs del markup, flujo de
  `boot()`, `apiUrl`, precedente de contacto en `ley-datos`) y el lado API (contrato de
  `/contact`, resolución heart→plantilla).
- **Inline (escritura):** un solo archivo no trivial por fix (`js/app.js`), sin diseño
  pendiente → no dispara el writer trigger (2+ archivos no triviales).
- **Delegada (verificación):** el arnés CDP corre como acción independiente; su resultado
  es el registro de verificación.

## Restricción dura

El front **siempre** habla con la API por su dominio público
(`apiUrl('/contact')` → `https://api.djlabs.cl`), nunca por una IP interna. La CSP de
producción (`connect-src`) y la allowlist de CORS solo conocen el dominio. El arnés CDP
lo verifica como aserción, no como convención.

## Tareas

- [x] **T1** — Mapear el front y localizar el origen real del deploy.
      *Evidencia:* el front desplegado coincide byte a byte con
      `controldecarroceria-worktrees/asistentejudicial-main/index.html`; Cloudflare Pages
      construye `main` del repo `jacktravolta/asistentejudicial.djlabs.cl`.
- [x] **T2** — Arnés CDP que reproduce ambos fallos.
      *Evidencia:* `tests/cdp_front_test.mjs`; corrida previa al fix → 5 ok / 6 fallos
      (submit con navegación nativa, cero POST a `/contact`).
- [x] **T3** — Arreglar el menú burger: JS alineado al markup (`#menu-toggle` /
      `#mobile-menu`), `aria-expanded` e iconos, cableado en `boot()`.
      *Evidencia:* commit `0eb4cde`; CDP 8/8 en el bloque del burger.
- [x] **T4** — Arreglar el formulario de contacto: `preventDefault()`, validación por
      campo, honeypot, POST por dominio, estado en línea.
      *Evidencia:* commit `0eb4cde`; CDP 9/9 en el bloque de contacto, sin recarga y con
      HTTP 200 desde `https://api.djlabs.cl/contact`.
- [ ] **T5** — Detectar el heart y mandar la plantilla del producto en el aviso.
      *Estado:* pendiente de cerrar el contrato exacto (ver "Heart" abajo).
- [x] **T6** — CSP: permitir el beacon de Cloudflare Analytics (`script-src` +
      `connect-src`) en `_headers` y en el meta CSP de los HTML.
      *Evidencia:* commit `9591018`; `script-src` += `https://static.cloudflareinsights.com`,
      `connect-src` += `https://cloudflareinsights.com https://static.cloudflareinsights.com`,
      en `_headers` y en las 21 meta-CSP (idénticas entre sí). Nada más cambió: el delta
      es append-only en esas dos directivas y revertirlo devuelve el archivo byte a byte.
      Verificado en Chrome real (CDP): el beacon pasa y un origen de control sigue
      bloqueado, así que la prueba tiene sensibilidad. En producción (desplegado)
      la CSP servida ya trae los dominios.
      *Pendiente del owner:* Cloudflare **no está inyectando** el script del beacon en
      el HTML servido (`beacon.min.js` / `cdn-cgi/rum` ausentes), así que la CSP ya no
      bloquea nada pero **todavía no hay datos de analytics**: falta activar Web
      Analytics en el panel de Cloudflare.
- [ ] **T7** — Verificación final contra el dominio desplegado, con la CSP de producción
      activa.
      *Hecho:* la CSP servida por `https://asisjud.djlabs.cl` incluye los dominios del
      beacon (verificado tras el deploy). *Pendiente:* confirmar el POST a
      `https://cloudflareinsights.com/beacon` cuando el beacon sea inyectado, y cerrar
      T5 (contrato del heart en el aviso al administrador).

## Heart: contexto gathered

- `heart_settings` tiene: `atscv`, `chatcorporativo`, `cotizaia`, `default`
  (skin `djlabs`, título `djlabs.cl`), `ley_datos_21719` (skin `teal`), `leylaboral`
  (skin `indigo`), `metalgym88` (declara `front_url`).
- **El heart `judicial` no existe** en la base (0 filas en `heart_settings` y
  `heart_personas`), aunque `js/inline/judicial/index-2.js` lo fija en `localStorage`.
- `GET /ui/theme` sin `heart` responde `default` + skin `djlabs`: ese es el heart de la
  instalación.
- `contact_messages` **no guarda el heart**: solo decide la plantilla del aviso.
- `ley_datos_21719` ya manda `heart` en registro/login pero no en el contacto.

## Criterios de aceptación

1. El botón hamburguesa abre y cierra el panel en viewport móvil, sin sesión.
2. El envío del formulario no navega, muestra el estado en línea y la API responde 2xx.
3. Todo request a la API va a `https://api.djlabs.cl`.
4. El aviso al administrador sale con la plantilla del producto.

## Comandos de verificación

```bash
node --check js/app.js
node tests/cdp_front_test.mjs --url http://127.0.0.1:8002      # front local + API por dominio
node tests/cdp_front_test.mjs --url https://asisjud.djlabs.cl  # producción, CSP activa
```

Servidor local del front: `python3 -m http.server 8002 --directory <repo>` (origen
`http://127.0.0.1:8002`, permitido explícitamente en la allowlist de CORS de la API).

## Próximo paso

Cerrar T5 (qué `heart` debe viajar y si el backend lo infiere del Origin) y ejecutar T6,
T7.
