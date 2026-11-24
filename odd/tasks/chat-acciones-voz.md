# chat-acciones-voz — Iconos de acción alineados + switch maestro de voz

## Objetivo

Dos cosas que el dueño pidió en el chat del front principal de asisjud:

1. **Alinear los iconos** de las acciones del mensaje del asistente (sonido,
   descarga, eliminar): hoy no comparten caja ni línea base.
2. **Un switch para desactivar la voz** por completo: existe el control de
   auto-lectura, pero no hay una forma de apagar toda la voz desde el chat.

## Problema / Por qué

- **Iconos**: el mensaje del asistente se componía como columna flex y el
  botón de altavoz y el contenedor de acciones eran **hijos separados**
  (`content.append(bubble, audioBtn, actions)`), así que el altavoz caía en
  una fila y las acciones en otra. Además los botones usaban solo
  `rounded p-1`, sin caja fija ni área táctil uniforme. Los SVG no eran el
  problema (todos tenían `viewBox="0 0 24 24"` y el mismo tamaño).
- **Voz**: `aj:tts_auto` (auto-lectura, default ON) no es un interruptor
  maestro: apagar la auto-lectura no impide leer a mano, y viceversa.

## Alcance autorizado

- Front principal asisjud: `js/chat-widget.js`, `css/input.css` (+ build
  `css/tailwind.css`), `index.html`, `js/app.js`,
  `js/inline/ley-datos/app-4.js`, `ley-datos/app.html`.
- Gemelo del API (`api-independent`, `public/js/chat-widget.js`): se sincroniza
  en su propia rama (ver "Fuera de alcance" abajo).
- **Sin tocar** el endpoint `/tts`, su cobro, ni el backend.

## Decisiones

- **Fila única de acciones**: `.chat-action-row` (flex) con clases
  compartidas `.chat-action-btn` (40×40, `inline-flex`, icono centrado,
  área táctil uniforme) y `.chat-action-icon` (18×18 fijo). Se structuraliza
  con clases comunes, no con ajustes píxel a píxel.
- **Switch maestro**: `#chat-voice-toggle`, clave `aj:tts_enabled`,
  **default ON** (la voz está disponible; el auto-read sigue siendo otro
  control). Cuando está apagado: no hay auto-lectura, el botón manual queda
  deshabilitado con etiqueta "Voz desactivada" e icono de altavoz tachado,
  se cancela la lectura en curso y se retira el control flotante de parada.
- **Gates en los 4 puntos de entrada al TTS**: `ttsQuote()`, `ttsCharge()`,
  `speakText()` y la auto-lectura.
- **Independencia**: `aj:tts_auto` y `aj:tts_enabled` no se pisan en ninguna
  dirección (quien apague uno no apaga el otro).
- **Accesibilidad**: `aria-pressed`, `aria-label`/`title` dinámicos, foco
  visible, hit area ≥ 40×40.

## Work units

| WU | Commit | Qué |
| --- | --- | --- |
| WU1 | `7382efa` | `fix(chat): align action icons in the assistant message toolbar` |
| WU2 | `f2ba0e4` | `feat(chat): add a master switch to disable voice entirely` |
| WU3 | `e8f99f0` (repo `api-independent`) | `feat(chat): align action icons and add a master voice switch to the API widget` |

Fuera de alcance de este repo (pero parte del mismo entregable): el gemelo
del API vive en `api-independent` y se resolvió por **portar** los cambios (no
copiar el archivo), porque ese archivo además trae el render de precedentes
(`isSafeSourceUrl`, `renderSources`, prefijo "Precedente — ") que el front no
tiene. Como las páginas embebidas no cargan el Tailwind del front, el widget
del API inyecta su propio CSS (un `<style>` por documento, scope
`.chat-widget`).

## Verificación

- `node --check` en los 3 JS tocados: exit 0.
- `npm run build:css`: exit 0; `css/tailwind.css` commiteado junto a la fuente.
- Integridad de hooks: `#settings-voice-auto-toggle` (1), `aj:tts_auto` (3),
  `#mobile-balance` (1), `#menu-toggle` (1), `#contact-form` (2),
  `data-theme-toggle` (16), `renderSources` (4) — ningún `id`/`data-*`/`aria-*`
  eliminado o renombrado (las dos líneas removidas son etiquetas reemplazadas
  por equivalentes).
- **Chrome headless** (front): 24 aserciones, tema día y noche — los 3
  botones miden 40×40 en el mismo `top` (237) y los iconos 18×18 en el mismo
  `top` (248); switch default ON; apagado → botón manual deshabilitado, icono
  tachado, sin request a `/tts`; encendido → request restaurado;
  `aj:tts_auto` independiente.
- **Chrome headless** (gemelo del API, sin Tailwind): 30/30 aserciones en día
  y noche.
- **Producción**: `asisjud.djlabs.cl` sirve `index.html` y
  `js/chat-widget.js` **byte-idénticos** al commit publicado.

## Progreso

- 2026-11-24: WU1 + WU2 + WU3 entregados y verificados.
- 2026-11-24: **publicado** — `main` `796a5cf → 641bd53` (fast-forward) con
  la rama `feat/chat-acciones-voz`; verificado byte a byte en vivo.

## Riesgos residuales / pendientes

- Safari/iOS no se probó (la verificación runtime fue Chrome headless).
- El camino real de `/tts` (audio y cobro) no se ejercitó: el arnés usa
  `fetch` simulado. Lo verificado es el lado front: sin request cuando la voz
  está apagada.
- El gemelo del API no tenía auto-lectura (`aj:tts_auto`): se restauró desde
  el front, así que **las páginas embebidas ahora leen en voz alta por
  default** (igual que el front). El switch maestro las silencia. Si el dueño
  prefiere que el gemelo arranque en silencio, es un cambio de default en
  `aj:tts_auto`.
