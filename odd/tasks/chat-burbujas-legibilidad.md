# Chat: burbujas legibles en modo día (fin del bloque "botón" saturado)

## Objetivo

Que las burbujas del chat se lean como **burbujas** y no como botones: en modo día la
respuesta no debe gritar. La burbuja del usuario deja de ser un bloque dorado sólido con
texto grueso y las del asistente dejan de ser un lavado amarillo; el texto que las
respeta (encabezados y negritas del markdown) deja de llevar negro quemado hardcodeado.

## Problema

1. **La burbuja del usuario se lee como un botón.** `.bubble-user` usa `--c-accent` plano
   (dorado `#A68B4A` en la skin Fénix) **más** `-webkit-text-stroke: 0.5px` sobre el texto
   navy. El resultado medido en producción: fondo `rgb(166, 139, 74)`, texto `rgb(10, 26, 38)`,
   `text-stroke: 0.5px`. El trazo convierte la palabra en un trazo negro grueso y el bloque
   lleno de dorado satura la pantalla. Es el elemento más fuerte del chat y debería ser el
   más discreto de los dos.
2. **La burbuja del asistente es un lavado amarillo.** `.bubble-assistant` usa
   `--c-accent-soft` (`#F5EFDF`) sobre una tarjeta blanca: se ve manchado y no como papel.
3. **El markdown del asistente ignora el tema.** `renderChatMarkdown` emite los encabezados
   con `style="font-weight:700;color:#0f172a"` hardcodeado: casi negro, más pesado que el
   resto, y **de noche queda ilegible** (negro sobre burbuja navy). Los enlaces usan
   `#2563eb` hardcodeado, fuera de la paleta oro/navy.
4. **Arnés de QA con selector obsoleto.** `tests/cdp_chat_qa.mjs` sigue buscando la burbuja
   por `.bg-slate-100`, clase que ya no existe (ahora es `.bubble-assistant`). Por eso la QA
   reportaba "no aparece la burbuja del asistente" con la API respondiendo 200: el fallo era
   del arnés, no del chat.

## Por qué

El dueño revisó el chat en modo día y pidió explícitamente mejorar las burbujas: se ven
saturadas, sobre todo los bloques con texto negro grueso, como la burbuja del usuario. El
principio rector del proyecto manda que la interfaz sea clara y sin presión; un bloque de
color saturado con texto duro no es claro, distrae y empuja la mirada al mensaje en vez
de al contenido.

## Alcance

**Front (`asistentejudicial.djlabs.cl`):**
- B1 `css/tokens.css`: rediseñar `.bubble-user` y `.bubble-assistant` (día y noche) sobre
  los tokens existentes; eliminar el `-webkit-text-stroke` y el `filter: opacity(95%)` de
  noche.
- B2 `css/input.css` (+ rebuild de `css/tailwind.css`): clase `.chat-md-heading` para los
  encabezados del markdown (color del tema, peso 600) y peso 600 para `strong` dentro de las
  burbujas.
- B3 `js/chat-widget.js`: los encabezados del markdown pasan a usar la clase en vez del
  estilo inline; los enlaces dejan de llevar azul hardcodeado.
- B4 `tests/cdp_chat_qa.mjs`: selector de la burbuja del asistente corregido
  (`.bg-slate-100` → `.bubble-assistant`) para que la QA vuelva a ser evidencia válida.

## Restricciones

- **No se tocan los tokens de la paleta** (`--c-accent`, `--c-text`, etc.): el cambio es de
  aplicación, no de identidad visual. La skin Fénix sigue siendo oro/navy/marfil.
- **Contraste AA**: el texto de las burbujas se mide contra su propio fondo nuevo; el texto
  ya no usa el trazo como apology del contraste.
- **Modo noche**: el mismo criterio (lavado del acento sobre la superficie, nunca un color
  plano saturado) y el texto ivory de `--c-text`.
- Los artefactos técnicos van en el idioma del repo (español), el código y los
  identificadores en inglés.
- `css/tailwind.css` es artefacto compilado: se commitea junto a `css/input.css`
  (`npm run build:css`, build verificado reproducible).

## Tareas

- [x] B1 — Rediseñar las burbujas en `css/tokens.css` (día + noche), sin text-stroke.
- [x] B2 — `.chat-md-heading` y `strong` con peso 600 en `css/input.css` + rebuild.
- [x] B3 — `js/chat-widget.js`: encabezado por clase y enlaces con token del tema.
- [x] B4 — Corregir el selector obsoleto del arnés de QA.
- [x] B5 — Verificación visual antes/después con captura real (CDP, modo día y noche).
- [x] B6 — Commit por unidad de trabajo en rama de feature y publicación por fast-forward a `main` (`4ffa95a` → `65f2c5f`), verificada byte a byte en producción.

## Criterios de aceptación

1. La burbuja del usuario NO usa un color de acento plano: su fondo es un lavado del acento
   sobre la superficie (`rgb(var(--c-accent) / …)`) y su texto NO lleva `text-stroke`.
2. La burbuja del asistente se apoya en la superficie neutra, con borde fino y sombra
   sutil, no en el lavado dorado.
3. Los encabezados del markdown usan el color del tema (`--c-text`) y peso 600; de noche son
   legibles (antes eran `#0f172a` sobre fondo navy).
4. El texto de las burbujas mantiene contraste ≥ 4.5:1 contra su fondo en modo día y noche.
5. Captura real antes/después: la burbuja del usuario deja de leerse como un botón.
6. `tests/cdp_chat_qa.mjs` detecta la burbuja del asistente con el selector vigente.

## Ruta (ODD)

| Tarea | Ruta | Evidencia del disparo |
| --- | --- | --- |
| B1 | delegado (writer) | 2+ archivos no triviales (tokens.css, input.css, chat-widget.js) |
| B2 | delegado (writer) | mismo writer |
| B3 | delegado (writer) | mismo writer |
| B4 | delegado (writer) | mismo writer |
| B5 | delegado (writer) | verificación por acción, worker fresco |
| B6 | inline (orquestador) | git: estado y commit |

## Verificación

- `node --check` sobre copia `.mjs` de `js/chat-widget.js` (el `node --check` normal lo
  parsea como script *sloppy* y no detecta el error de módulo).
- `npm run build:css` exit 0 y `css/tailwind.css` commiteado con la fuente.
- Captura CDP real (producción + CSS local inyectado) antes/después en modo día, con los
  estilos computados de `.bubble-user`, `.bubble-assistant` y `.chat-action-btn`.
- Contraste calculado (WCAG) del texto de cada burbuja contra su fondo real.

## Progreso

### Diagnóstico previo (2026-11-26)

- Estilos medidos (día, skin Fénix): `.bubble-user` fondo `rgb(166,139,74)` + text-stroke
  `0.5px rgb(10,26,38)`; `.bubble-assistant` fondo `rgb(245,239,223)`;
  `.chat-action-btn` color `rgb(74,74,74)`.
- Capturas: `/tmp/opencode/shots/antes2-burbujas.png` y
  `/tmp/opencode/shots/antes2-completo.png`.

### Implementación y verificación (2026-11-26)

- Commits: `546ee37 fix(chat): soften the chat bubbles and restore themed markdown` y
  `2e0d7b2 test(chat): add visual bubble QA and fix the assistant selector`.
- `node --check` sobre una copia temporal `.mjs` de `js/chat-widget.js`: exit `0`; la copia
  se eliminó. `node --check tests/cdp_bubble_visual.mjs`: exit `0`.
- `npm run build:css`: exit `0`. Segunda ejecución idéntica byte a byte:
  `css/tailwind.css` SHA-256 `75de062f257a5e2f57a0e90a282b48edbb8a3ab002c3a1b60c08fc77f4a6d352`
  antes y después.
- Arnés visual contra `https://asisjud.djlabs.cl` con CSS local inyectado al final del
  `<head>` (`65.635` bytes; `isLastHeadChild: true`): exit `0`, login correcto en el primer
  intento. Capturas:
  - `/tmp/opencode/shots/despues-dia-burbujas.png`
  - `/tmp/opencode/shots/despues-dia-completo.png`
  - `/tmp/opencode/shots/despues-noche-burbujas.png`
  - `/tmp/opencode/shots/despues-noche-completo.png`
- Estilos computados después (skin Fénix):
  - Día, usuario: fondo `rgba(166, 139, 74, 0.13)`, fondo real
    `rgb(243.43, 239.92, 231.47)`, texto `rgb(10, 26, 38)`, text-stroke `0px`, borde
    `1px solid rgba(166, 139, 74, 0.35)`, sin sombra.
  - Día, asistente: fondo `rgb(255, 255, 255)`, texto `rgb(10, 26, 38)`, borde
    `1px solid rgb(236, 232, 220)`, sombra `rgba(10, 26, 38, 0.05) 0px 1px 2px 0px`.
  - Noche, usuario: fondo `rgba(217, 201, 138, 0.16)`, fondo real
    `rgb(56.56, 71.64, 75.84)`, texto `rgb(250, 250, 248)`, text-stroke `0px`, borde
    `1px solid rgba(217, 201, 138, 0.4)`, sin sombra.
  - Noche, asistente: fondo `rgb(26, 47, 64)`, texto `rgb(250, 250, 248)`, borde
    `1px solid rgb(32, 48, 64)`, `filter: none`.
- Contraste WCAG recalculado contra el fondo real, todos AA (`>= 4.5:1`):

  | Tema | Burbuja | Contraste |
  | --- | --- | ---: |
  | Día | Usuario | `15.51:1` |
  | Día | Asistente | `17.67:1` |
  | Noche | Usuario | `9.16:1` |
  | Noche | Asistente | `13.18:1` |

- La QA existente después de corregir el selector detectó la burbuja del asistente, pero la
  corrida completa terminó con exit `1`: la API de producción respondió `HTTP 403` y la
  consola registró dos `401` y un `403` porque la cuenta QA está pausada y necesita
  confirmar su correo. Error visible exacto de la API: «Necesitamos confirmar tu correo
  para seguir. Te enviamos un enlace de verificación: tu cuenta está en pausa, tu trabajo
  está guardado y nada se pierde — apenas confirmes, sigues donde quedaste.» La aserción
  «aparece una burbuja del asistente con respuesta no vacía» pasó, confirmando B4.

### Publicación (2026-11-26)

- Rama `feat/chat-burbujas-legibilidad`: 4 commits (`546ee37`, `2e0d7b2`, `04ca56b`, `65f2c5f`).
- `main` actualizado por fast-forward `4ffa95a` → `65f2c5f` y publicado en `origin/main`.
- Se añadieron cache-busters `?v=16` a los dos CSS (`css/tokens.css`, `css/tailwind.css`): antes no los
  tenían y el repo ya los usaba para los JS (`app.js?v=15`).
- Producción verificada tras el despliegue: `https://asisjud.djlabs.cl/index.html` responde HTTP 200 y
  sirve los enlaces con `?v=16`; los CSS coinciden byte a byte con el repo local
  (`tokens.css` md5 `5a31d4efd71042a586c9e5c57cd28967`, `tailwind.css` md5 `0db89f848733a52db115c7cd45495191`).
- Revisión nativa: RDD está desactivado globalmente (`receipt-driven development: off`), así que no
  corrió revisión por recibos; la entrega siguió la política normal del repo.

## Riesgos residuales / pendientes

- Safari/iOS no se probó (la verificación runtime es Chrome headless).
- La cuenta QA no está verificada: la API de producción respondió `HTTP 403`. La captura
  visual ejercitó el widget y el mensaje real de pausa, pero no una respuesta de IA con
  markdown; el cambio de `renderChatMarkdown` quedó verificado por revisión del diff y
  `node --check`.
- `color-mix()` se evita a propósito: el lavado se hace con alpha sobre la superficie, que
  ya es la base de la tarjeta del chat.
- Al inyectar CSS local sobre producción, las reglas nocturnas antiguas tienen mayor
  especificidad. Por eso el CSS nuevo neutraliza explícitamente `text-stroke` y `filter`
  en los selectores nocturnos; así el resultado computado no hereda artefactos del
  stylesheet desplegado.
- Fuera de alcance: la regla de Fénix que pinta de navy los botones `bg-blue-600`
  (`css/tokens.css`) y el constructor del embed `embed/corporate-chat.js`, que inyecta su
  propio CSS y no comparte estas reglas.
