# Front: biblioteca real de documentos y chat en su propia sección

## Objetivo

Que la sección **Documentos** del panel sea una biblioteca real de los documentos que el
usuario ya guardó (subir, listar, ver el texto, usarlo en el chat, eliminar) y que el
chat se mude a su propia sección **Consultas**. Todo contra los endpoints que la API
**ya tiene**, sin crear tablas, endpoints ni sistemas paralelos.

## Problema

1. **`Documentos` es un chat.** `#panel-documents` (index.html:1335) contiene el host
   `<div id="chat">`: la sección no es un gestor de documentos, es la ventana de chat.
   Medido con CDP en local y en `https://asisjud.djlabs.cl`: 1 chat, sin duplicación.
   No es un bug de montaje: nunca hubo otra cosa ahí.
2. **El backend de la biblioteca ya existe y el front no lo usa.** La API expone
   `GET /rag/sources` (app/Rest/RagController.php:33) cuyo comentario dice *"The panel
   renders them all with the same per-item actions"*, más `GET /rag/sources/text`,
   `POST /rag/sources/chat-enabled` y `DELETE /rag/sources`. El front no hace ninguna
   de esas cuatro llamadas.
3. **El panel no tiene UI de subida.** `ui.bindDropzone` y `ui.bindTextSubmit` esperan
   `#dropzone`, `#free-text` y `#text-submit`, que no existen en el markup: hoy la única
   subida real es el modal de adjuntos del propio chat.
4. **El pipeline pertenece al chat.** `app.js:766-776` mueve `#error`, `#progress-wrap`,
   `#result` y `#success` dentro del chat, así que la biblioteca no puede tener su
   propio feedback de subida.
5. **Montaje del chat con carrera.** `ensureChat()` marca `chatMounted = true` dentro del
   `.then()` del import dinámico (app.js:815): dos llamadas antes de resolver el import
   montan dos widgets, y `mountChat` **añade** al contenedor sin limpiarlo
   (chat-widget.js:850).
6. **Tres `#chat` en el documento** (index.html:1285, 1378, 2447): `$id('chat')` resuelve
   de forma ambigua. `tpl-chat` está huérfano (nadie lo monta) y la ruta pública
   `#/chat` no enruta a nada.
7. **Cache-buster sin subir.** index.html:2647 carga `./js/app.js?v=7` y el fix anterior
   (0eb4cde) cambió ese archivo sin subir la versión: quien tenga la respuesta cacheada
   sigue con el JS viejo.

## Por qué

El usuario pidió rehacer el panel porque "ahora es basura" yConcreteó que lo que hay que
hacer es la sección de documentos, que hoy muestra solo ventanas de chat. El alcance se
acordó: **biblioteca real + chat aparte**, sin desplegar la rama vieja
`feat/chat-legal-module`, cuyos módulos llaman endpoints inexistentes
(`/conversations/list`, `/cases/*`, `/documents/generate`, `/laws/search`) y producirían
un panel lleno de botones 404.

## Alcance

**Dentro:**
- `index.html`: nav con **Consultas**; `#panel-documents` como biblioteca; nuevo
  `#panel-chat`; fuera la plantilla huérfana `tpl-chat`; subir el cache-buster.
- `js/app.js`: registro de paneles, `ensureChat()` con host explícito y guardia
  sincrónica, ruta `#/chat`, panel por defecto, y dejar de mover el pipeline al chat.
- `js/documents-library.js` (nuevo): listado + acciones por documento.
- `js/documents.js`: emitir un evento tras una ingesta exitosa para refrescar la lista.
- `tests/`: arnés CDP de la biblioteca.

**Fuera:**
- Cambios en la API (no hacen falta: los endpoints existen).
- Módulos del requerimiento sin backend (leyes, causas, escritos, conversaciones).
- Edición de texto con Quill (`PUT /rag/sources/text` existe, no entra en este corte).
- Panel admin (`js/admin.js` no existe en el repo).
- T5/T6/T7 del tracker `menu-burger-contacto-heart.md` (heart del aviso y CSP).

## Contrato de la API (verificado en el código)

| Acción | Endpoint | Forma |
|---|---|---|
| Listar | `GET /rag/sources` | → `{success, data:{heart, sources:[{source_id,title,kind,chat_enabled,created_at,text_len}]}}`, `kind` ∈ `document\|site\|informe\|quotation\|atscv` |
| Ver texto | `GET /rag/sources/text?id=<source_id>` | → `{success, data:{source_id,title,text}}` |
| Usar en el chat | `POST /rag/sources/chat-enabled` | body `{source_id, enabled}` |
| Eliminar | `DELETE /rag/sources` | body `{sourceId}` |
| Guardar (subida) | `POST /documents/ingest` | `FormData` con `text`, `source_type`, `original_filename` |

## Heart

- La API sirve varios corazones y **no adivina**: un chat autenticado sin heart se rechaza
  con `HEART_REQUIRED` (HTTP 400). Verificado contra producción: la misma pregunta da 400
  sin heart y 200 con `heart: "default"` (cobra 8 créditos de la billetera correcta).
- El front resuelve el heart de la instalación (`js/heart.js`): `localStorage.heart_id` →
  `GET /ui/theme` (`data.heart`) → `'default'`. **No** se hardcodea `'default'`: en otra
  instalación sería adivinar y cobraría la billetera de otro corazón.
- El heart viaja en el chat (`extraBody`), en las cuatro llamadas de `/rag/sources*`
  (query o body) y en la ingesta (`FormData`), así biblioteca y chat leen el mismo corazón.

## Restricciones

- El front **siempre** habla con la API por `apiUrl()` → `https://api.djlabs.cl`, nunca
  por IP interna.
- Toda llamada de sesión con `credentials: 'include'`.
- Reutilizar: cero endpoints, cero tablas, cero sistemas de créditos nuevos.
- Código y comentarios en inglés; copy de UI en español neutro, empático y sin culpa.
- Sin URLs root-absolute (`src="/`, `fetch("/`).
- El front no cobra por listar; el cobro vive en la ingesta y en el chat.

## Ruta

- **Exploración delegada**: un `explore` mapeó el panel de `main` (DOM, módulos, API
  usada, ausencias) y otro mapеó la API. Búsqueda directa de rutas en `public/index.php`
  y en `app/Rest/RagController.php`.
- **Escritura delegada (writer trigger)**: tocan 4 archivos no triviales
  (`index.html`, `js/app.js`, `js/documents-library.js`, `js/documents.js`).
- **Verificación**: `node --check` + arnés CDP en local y en producción (acción por
  acción). RDD está **off** (global), así que no hay revisión nativa ni consentimiento.

## Tareas

- [x] **T1** — Mapear el panel, la API real y la rama vieja; decidir el alcance con el
      usuario. *Evidencia:* contratos de `/rag/sources*` verificados en
      `app/Rest/RagController.php`; `GET /rag/sources` existe y el front no lo llama.
- [x] **T2** — Markup: nav "Consultas", `#panel-documents` como biblioteca, `#panel-chat`
      con host único, fuera `tpl-chat`, cache-buster subido. *Evidencia:* `index.html`
      separa los hosts, conserva el pipeline de subida y sube `app.js` a `v=9`; verificado
      con `node --check` y el grep de URLs root-absolute vacío.
- [x] **T3** — `js/documents-library.js`: listar, ver texto, activar/desactivar para el
      chat, eliminar, estado vacío y estados de carga/error. *Evidencia:* el módulo usa los
      cuatro endpoints de `/rag/sources*`, renderiza con DOM APIs y muestra estados visibles;
      verificado con `node --check js/documents-library.js`.
- [x] **T4** — `js/app.js`: registro de paneles, `ensureChat()` con host explícito y
      guardia sincrónica, sin mover el pipeline al chat, ruta `#/chat`, panel por defecto.
      *Evidencia:* el chat monta solo en `#chat-consultas`, abre las rutas `#/chat` y
      `#/documentos` y refresca la biblioteca al mostrar Documentos; verificado con
      `node --check js/app.js`.
- [x] **T5** — `js/documents.js`: evento tras ingesta exitosa → la lista se refresca.
      *Evidencia:* `documents:ingested` se emite tras guardar y la biblioteca lo escucha;
      verificado con `node --check js/documents.js`.
- [ ] **T6** — Verificación local: `node --check` + arnés CDP (lista, acciones, un solo
      chat montado).
- [ ] **T7** — Commit + push a `main` + verificación en `https://asisjud.djlabs.cl`.
- [x] **T8** — El chat nombra el heart: resolver el heart de la instalación y enviarlo en el
      chat, la biblioteca y la ingesta. *Evidencia:* `js/heart.js` resuelve el heart
      (`localStorage.heart_id` → `GET /ui/theme` → `'default'`), `ensureChat()` lo pasa en
      `extraBody` y las cuatro llamadas de `/rag/sources*` y la ingesta lo envían; verificado
      con `node --check` y contra la API real (400 sin heart vs 200 con `heart: default`).

## Criterios de aceptación

1. El nav ofrece **Documentos** (biblioteca) y **Consultas** (chat) como secciones
   distintas.
2. La biblioteca lista lo que el usuario tiene, con estado vacío honesto; cada ítem
   muestra título, tipo, fecha y tamaño.
3. Por ítem: ver el texto, activar/desactivar su uso en el chat, y eliminar con
   confirmación.
4. Desde el panel se puede subir un documento: extracción → vista previa → confirmar →
   guardar, y el documento aparece en la lista sin recargar la página.
5. El chat conserva su propio flujo de adjuntos y se monta **una sola vez**.
6. Ninguna acción apunta a un endpoint inexistente; toda llamada va a
   `https://api.djlabs.cl` con `credentials: 'include'`.
7. `node --check` pasa en cada JS tocado y el arnés CDP pasa en local y en producción.

## Comandos de verificación

```bash
node --check js/app.js
node --check js/documents-library.js
node --check js/documents.js
node tests/cdp_panel_test.mjs --url http://127.0.0.1:8002
node tests/cdp_panel_test.mjs --url https://asisjud.djlabs.cl
```

## Próximo paso

T8 cerrado (el chat nombra el heart). Sigue T6 (arnés CDP local) y T7 (commit + push de la
rama de feature, sin tocar `main` directamente).

---

**File locator:** `odd/tasks/panel-documentos-biblioteca.md` (repository-relative)
**Engram mirror topic:** `odd/panel-documentos-biblioteca/tasks`
