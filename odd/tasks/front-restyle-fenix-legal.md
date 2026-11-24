# front-restyle-fenix-legal — Homologación visual del front al estilo Fénix Legal

## Objetivo

Migrar la identidad **visual** del front principal de asisjud (landing + SPA en
`index.html`, stubs `login/wallet/chat/landing/preguntas`, `verificar.html` y
fuentes del chat) al sistema de diseño de **FÉNIX LEGAL**
(`/home/test/test/feixlegal.cl/FENIX-LEGAL-Solo-Archivo.html`), **sin perder
nunca funcionalidad**.

## Decisiones del dueño (2026-11-23)

- Alcance: **solo front principal asisjud** (no ley-datos, no url-analyzer,
  no corporativo/cv/judicial, no embed, no gemelo de la API).
- Identidad: **solo visual** — colores, logo y tipografía de Fénix Legal; el
  producto sigue llamándose "Asistente Judicial" (copy, títulos, emails y PDFs
  intactos).

## Sistema de diseño de referencia (extraído del mockup)

- **Paleta**: navy `#0a1a26` (dominante) y `#1a2f40` (medio); dorado acento
  `#a68b4a` con highlight `#d9c98a` y sombra `#8c7340`; marfil/crema
  `#fafaf8`, `#f1efe9`, `#e6e1d5`; texto secundario `#4a4a4a`; error `#b00020`.
- **Tipografía**: Cormorant Garamond 500/600 (display, títulos, marca) +
  Inter 400/500/600/700 (cuerpo/UI) — Google Fonts, `display=swap`.
- **Logo**: `img/fenix-logo.jpg` (extraído del mockup, 720×720 JPEG: fénix
  dorado + balanza sobre navy, wordmark FÉNIX LEGAL). Original con
  `alt="Logo Fénix Legal"` en `.hero-logo-card`.
- **Componentes**: topbar/nav claro, hero con logo-card, secciones alternas
  claro/gris/oscuro, botones y detalles en dorado.

## Estrategia (tokens primero, cero lógica nueva)

1. **`css/tokens.css`**: re-mapear las paletas `dia` y `noche` del skin por
   defecto a Fénix:
   - Día: fondos marfil `#fafaf8`/`#f1efe9`, texto navy `#0a1a26`/`#1a2f40`,
     acentos dorado `#a68b4a`, bordes `#e2ddd0`.
   - Noche: superficies navy `#0a1a26`/`#1a2f40`, texto marfil
     `#e6e1d5`/`#fafaf8`, acentos dorado `#d9c98a`/`#a68b4a`.
   - TODAS las variables existentes se mantienen (ningún hook desaparece).
2. **Skins**: el mecanismo por corazón queda intacto; el skin **default** pasa
   a identidad Fénix. Los demás skins (teal/indigo/…) se conservan para otros
   corazones. El toggle día/noche del header (feature en curso) sigue.
3. **Tipografía**: `<link>` Google Fonts con `preconnect`; headings y marca en
   Cormorant Garamond; cuerpo/UI en Inter. Fallbacks serif/system-ui.
4. **Logo**: header landing (index.html:55-134), logo del header app
   (tpl-app 1305-1337), favicon si aplica, `<meta name="theme-color">` →
   `#0a1a26`.
5. **Superficies del SPA**: header sticky, pills de nav, cards/paneles,
   botones primarios (dorado), inputs, chat composer, footer. Ajustes de
   clases Tailwind + puentes oscuros nuevos en tokens.css donde un color
   literal rompa en noche (patrón del bug del input: 293-311).
6. **Landing**: hero y secciones con estilo Fénix (serif en h1/h2, botones
   dorados, alternancia claro/gris/oscuro) SIN cambiar estructura, ids ni
   copy.

## Restricciones

- Cero cambios funcionales: mismos ids, `data-*`, aria-*, flujos JS, rutas;
  hooks leídos por tests intactos (`#mobile-balance`, `.nav-item[data-panel]`,
  `#menu-toggle`, `#contact-form`).
- Copy legal y nombre del producto: intactos.
- Contraste accesible (AA) en ambas paletas: el dorado `#a68b4a` va como
  acento/borde/fondo de botón con texto navy o marfil; no como texto pequeño
  sobre marfil.
- Conventional Commits, un commit por unidad; rebuild `npm run build:css`
  cuando cambien utilidades.

## Checklist

- [x] **R1** — tokens.css: paletas día/noche Fénix + puentes oscuros nuevos.
      Commit `7d7d5b8` (skin `fenix` nuevo, no override de la base: los 6
      skins anteriores intactos; el bloque `fenix` define un superconjunto de
      variables del skin `teal`).
- [x] **R2** — Tipografías: Google Fonts (Cormorant + Inter) + jerarquía.
      Commit `7d7d5b8` (link con `display=swap` + 2 preconnect en index y
      verificar; `.font-display` en el build, aplicado 14 veces).
- [x] **R3** — Logo: `img/fenix-logo.jpg` en headers + favicon + theme-color.
      Commit `f276f63` (favicon + header landing + header app + atribución en
      `img/CREDITS.md` + `theme-color` `#0a1a26`).
- [x] **R4** — Landing al estilo Fénix (solo clases/markup visual).
      Commit `796a5cf`.
- [x] **R5** — SPA: header, pills, cards, botones, inputs, composer.
      Commit `796a5cf`.
- [x] **R6** — Verificación: build css (`npm run build:css` exit 0),
      `node --check` en los 5 JS tocados, greps de hooks intactos
      (`#mobile-balance` 1, `#menu-toggle` 1, `#contact-form` 1,
      `data-theme-toggle` 7, `data-panel` 11, `aj:tts_auto` y `renderSources`
      presentes), contraste AA recalculado de forma independiente y
      **verificador independiente: APPROVED (7/7, sin regresiones)**.
      CDP no estuvo disponible (`:9222` sin respuesta): no se fingió esa
      verificación; el contraste se comprobó con la fórmula de luminancia
      relativa (navy/oro 5.40:1, navy/oro-hover 4.62:1, mockup gold 3.90:1
      —justifica el cambio de hover—, marfil/navy 16.91:1).

## Ruta de implementación

Writer delegado único (serie) sobre rama nueva
`feat/restyle-fenix-legal` **apilada sobre**
`fix/front-ui-header-chat-voz-tema` (mismos archivos — evitar conflictos).
**Bloqueada hasta que el writer de arreglos front termine.**

## Verificación (TDD resuelto)

- TDD: **off** — sin framework; verificación funcional por comando.
- `npm run build:css`, `node --check` de JS tocado, greps estructurales,
  `node tests/cdp_front_test.mjs` si hay Chrome CDP (:9222). `cdp_panel_test`
  fuera de esta feature.

## Entrega

- Forecast: ~300-500 líneas (tokens + clases) → sobre 400 → mismo criterio del
  dueño (2026-11-23): commits en rama, el dueño arma PRs.

## Progreso

- 2026-11-24: verificación independiente -> **APPROVED** (7/7 ítems, sin
  regresiones). Única observación no bloqueante: `tailwind.build.config.js`
  fija las stacks de fuentes en vez de `var(--font-body)`/`var(--font-display)`,
  así que las utilidades generadas no seguirían a los tokens si cambian
  (hoy coinciden exactamente).
- 2026-11-24: **publicado**. `main` avanzado `085125b -> 796a5cf` (fast-forward)
  y el HTML servido por `asisjud.djlabs.cl` quedó **byte-idéntico** al commit
  `796a5cf` (verificado por `diff` contra `git show 796a5cf:index.html`), con
  `fenix-logo.jpg` ×3, `Cormorant+Garamond` y `theme-color #0a1a26`.
  El mirror de GitHub Pages (`gh-pages` / `feat/chat-legal-module`) NO se
  actualizó: es otra fuente de publicación.
- 2026-11-23: decisiones registradas; logo extraído del mockup y validado
  (720×720), colocado en `img/fenix-logo.jpg` (untracked hasta el primer
  commit de esta feature); doc creado. Esperando disponibilidad del writer
  de `fix/front-ui-header-chat-voz-tema`.
