# front-ui-header-chat-voz-tema — Arreglos de front (5 reportes + fuentes con enlace)

## Objetivo

Resolver los 5 detalles de UI reportados por el dueño y, de paso, dejar las
fuentes del chat con enlace visible (requisito de la feature
`precedentes-web` del API: "agrega de dónde se obtuvo la info en la pestaña
de chat donde indica las fuentes").

## Problema / Por qué

1. **Header**: el header autenticado (`tpl-app`) suma ~1230px de contenido en
   ~1104px disponibles (`max-w-6xl`) → `flex-wrap` manda el cluster derecho a
   una segunda línea en cualquier desktop < ~1300px.
2. **Voz**: NO existe auto-lectura de respuestas (solo TTS pago por mensaje
   "Escuchar" + selector de voz). El dueño quiere que las respuestas se lean
   solas, ON por defecto y desactivable.
3. **Input invisible**: en tema `noche`, al enfocar el composer,
   `focus-within:bg-white` pinta blanco literal (sin puente oscuro) y el texto
   `text-slate-800` = `--c-text` es casi blanco → tipeo invisible.
4. **Perfil**: wrapper `max-w-2xl` (672px) — el dueño lo quiere más ancho.
5. **Tema**: no hay toggle día/noche en el header de la app (solo en landing).
6. **Fuentes**: `renderSources` muestra solo `title` (+ scope user); leyes y
   precedentes traen `url` que no se renderiza.

## Alcance autorizado (rama nueva desde HEAD actual)

- `index.html`: header `tpl-app` (1305-1337), Perfil `tpl-settings`
  (1837-1976, switch de sonidos 1963-1975), wrapper 1838.
- `js/chat-widget.js`: composer (418-447), voz (1541-1560, 1646-1665),
  `renderSources` (1998), hook post-respuesta (2113).
- `js/app.js`: mount `tpl-app` (287), reflect/persist settings (376-381,
  498-503).
- `js/theme.js`: solo re-`initTheme()` tras mount (idempotente, 209-227).
- `css/tokens.css`: puente oscuro para `focus-within:bg-white` (tras 307,
  patrón de 305).
- `css/tailwind.css`: rebuild con `npm run build:css` cuando se agreguen
  utilidades nuevas.

**Fuera de alcance**: header del landing (55-134), `verificar.html`,
`ley-datos/*`, `embed/corporate-chat.js`, y el gemelo
`api-independent/public/js/chat-widget.js` (va con precedentes-web WU3).

## Diseño

1. **Header una línea**: container 1306 `flex-nowrap` + `gap-2`; nav 1315
   `flex-nowrap overflow-x-auto min-w-0 flex-1 gap-0.5`; pills
   `whitespace-nowrap px-2.5 sm:px-3 text-[13px] sm:text-sm`; cluster derecha
   `shrink-0`; `#mobile-balance` compacto pero **SIEMPRE en el DOM** (los
   tests lo leen: cdp_panel_test.mjs:844,992,1048). Labels sin cambios.
   En pantallas angostas el nav scrollea en vez de envolver.
2. **Auto-voz**: clave nueva `aj:tts_auto` (ausente = **ON**, patrón
   `sounds.js:19,132-138`). Switch en Perfil junto al de sonidos (patrón peer
   de 1971-1975), copia en español neutro. Wiring reflect/persist en
   `js/app.js` (376-381, 498-503). Hook en `chat-widget.js:2113`: si ON y hay
   `speechSynthesis` → `speakText()` **local y gratis** (1646-1665) con la voz
   de `pickTtsVoice` (1541-1560). JAMÁS tocar el TTS pago (`/tts`,
   1678-1700). `#tts-stop-btn` (1612-1644) también cancela la auto-lectura.
   Además: copia honesta del switch de sonidos (hoy dice "default OFF" y el
   comportamiento real es ON → corregir la copia a "Empieza encendido").
3. **Input legible**: puente en `css/tokens.css` tras 307 replicando el patrón
   de 305 (verificar orden de cascada tokens vs tailwind como los puentes
   existentes). Tema día sin cambios.
4. **Perfil ancho**: 1838 `max-w-2xl` → `max-w-4xl` (+ `sm:px-6`); los caps
   internos `max-w-md` (1883/1890/1901) quedan.
5. **Toggle día/noche en header**: botón `data-theme-toggle` en el cluster
   derecho (patrón bell 1327-1332 / clase `theme.js:163`), SVGs sun/moon del
   landing (81-84); `initTheme()` tras `mountView('tpl-app')` en
   `js/app.js:287` (verificar guard `dataset.themeWired` 150-157).
6. **Fuentes con enlace**: `renderSources` (1998): item con `url` →
   `<a target="_blank" rel="noopener noreferrer">` construido con
   `createElement`+`textContent` (nunca innerHTML con datos de la API);
   scope `precedent` → prefijo "Precedente — "; scope `law` igual con enlace;
   sufijo "(tus documentos)" sin cambios.

## Restricciones

- IDs/clases existentes sin cambios (`#mobile-balance`, `.nav-item[data-panel]`,
  aria-*); sin nuevas dependencias npm.
- Conventional Commits, sin atribución IA. Un commit por work unit (3).
- Sin rebuild innecesario de tailwind; rebuild obligatorio si se agregan
  utilidades nuevas (arbitrary values incluidas).

## Checklist

- [x] **FA** — Input legible en noche + Perfil `max-w-4xl` — commit `af2a662`
      (puente oscuro `:root[data-tema='noche']` para `focus-within:bg-white`
      en tokens.css:309-311; cascada verificada: tokens.css carga antes que
      tailwind.css y (0,4,0) vence a (0,2,0)).
- [x] **FB** — Header en una línea — commit `42b328e` (container
      `flex-nowrap gap-2 min-w-0`; nav `overflow-x-auto` con scrollbar
      oculto; 9 pills compactas `text-[13px] sm:text-sm`; cluster
      `shrink-0`; `#mobile-balance` íntegro; labels byte-idénticos;
      `css/tailwind.css` reconstruido).
- [x] **FC** — Auto-voz + toggle día/noche + fuentes con enlaces — commit
      `057233c` (`aj:tts_auto` ausente=ON; switch `#settings-voice-auto-toggle`
      en Perfil; hook post-respuesta con `speakText` local GRATIS — flujo
      pago `/tts` byte-intacto verificado en diff; `#tts-stop-btn` cancela;
      copia honesta de sonidos "Empieza encendido"; `data-theme-toggle` en
      header + `initTheme()` tras mount, idempotente por botón;
      `renderSources` con `createElement('a')`+`textContent`, URLs seguras
      http(s)/root-relative, prefijo `Precedente — `).

## Verificación independiente (2026-11-23)

- Verificador independiente (fresh context, read-only): **APPROVED** — los 6
  requisitos verificados contra los diffs reales; sin regresiones; flujo TTS
  pago y blob-download intactos; solo archivos permitidos tocados.
- `node --check` OK en los 3 JS; greps de hooks íntegros (menu-toggle,
  contact-form, nav-item[data-panel], mobile-balance, bell, logout, nav-admin).
- Assessment nativo: high/unassessable (runtime no elegible para revisión
  inmutable; RDD OFF) → verificación por writer + verificador independiente.
- CDP: no disponible en esta máquina (:9222 sin respuesta) — `cdp_front_test`
  NO corrido; verificación de runtime pendiente de Chrome CDP (riesgo
  declarado: comportamiento one-line del header y color nocturno verificados
  estructuralmente, no en navegador).

## Ruta de implementación

Un único writer delegado en serie (3 work units, 3 commits) sobre la rama
nueva `fix/front-ui-header-chat-voz-tema` desde HEAD
(`feat/verificacion-y-wallet`, clean y synced). El orquestador verifica
(structural + build) y registra los SHAs aquí.

## Verificación (TDD resuelto)

- TDD: **off** — sin framework; verificación funcional por comando.
- Por WU: `npm run build:css` (cuando aplique), `node --check` de cada JS
  tocado, greps estructurales. Si hay Chrome CDP en :9222:
  `node tests/cdp_front_test.mjs --url http://127.0.0.1:8002`
  (~15-60s, usa API live solo para /contact). `cdp_panel_test.mjs` NO corre
  en este WU (registra cuenta QA real y consume créditos — decisión del
  orquestador al cierre).

## Entrega

- Forecast: ~200-300 líneas < 400 → sin split de PR. Mismo criterio decidido
  por el dueño el 2026-11-23: commits en rama, el dueño arma PRs.
- Rama apilada sobre `feat/verificacion-y-wallet` (línea activa del dueño,
  ya pusheada) para evitar conflictos con `ef10b06`.

## Progreso

- 2026-11-23: doc creado; mapeo completo con line refs disponible
  (conversación). Writer WU-A/B/C delegado en serie.
