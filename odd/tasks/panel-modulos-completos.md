# Front + API: módulos faltantes del panel (conversaciones, causas, clientes, leyes, escritos, documentos)

## Objetivo

Completar `requerimiento.txt` cerrando el hueco de backend: crear los endpoints que faltan
para que el panel central muestre **Mis conversaciones**, **Mis documentos generados**,
**Mis causas y plazos** y **Mis clientes**, más los módulos de **Buscador de leyes (BCN
on demand)**, **Redactor de escritos** y **Analizador de documentos**, y extender el front
con esas secciones — sin crear un panel nuevo ni sistemas paralelos de créditos.

## Problema

1. **El front llama endpoints que no existen.** La rama vieja `feat/chat-legal-module`
   invoca `/conversations/list`, `/cases/add`, `/cases/list`, `/documents/generate`,
   `/documents/analyze` y `/laws/search`: ninguno está registrado en `public/index.php`.
   Desplegarla tal cual daría un panel lleno de botones 404.
2. **La API sí tiene piezas reutilizables, sin exponer por HTTP.** `BcnClient` (resuelve
   leyes por número exacto), `SourceChain`, `LegalCache` (tabla `legal_cache`), `TemplateRenderer`,
   `Generator`, `DocumentExporter` (PDF/DOCX/TXT con pie legal), `conversations`/`messages`
   (conversaciones del usuario) y `documents` (con `stored_path` hoy siempre NULL) no tienen
   ruta para el dueño.
3. **No existe ruta de listado para el dueño.** `GET /admin/conversations` es admin-only;
   `GET /rag/visitor-conversations` es de visitantes del heart, no del usuario. La tabla
   `documents` solo se lista vía `GET /admin/users/{id}`.
4. **Causas y clientes no existen** (ni tabla, ni ruta, ni servicio). `requerimiento.txt` los
   pide: son dominios nuevos, no deriva de nombres.
5. **Falta el panel.** El nav del front hoy ofrece Inicio, Documentos, Consultas, Billetera y
   Perfil; faltan las secciones del módulo 6.

## Por qué

El usuario pidió explícitamente crear los endpoints faltantes, commitear y completar el
front. La Regla Madre manda reutilizar: la backend de casi todo existe y solo falta la
ruta de acceso del dueño.

## Alcance

**API (`api-independent`, rama `feat/panel-modulos`):**
- A1 `GET /conversations` + `GET /conversations/{id}/messages` (owner-scoped).
- A2 `GET /laws/search?numero=` (BCN on demand vía `BcnClient`/`SourceChain`/`legal_cache`, gratis).
- A3 Tabla `cases` + `GET/POST/PATCH/DELETE /cases` (ROL/RIT/RUC, tribunal, estado, plazos).
- A4 Tabla `clients` + `GET/POST/PATCH/DELETE /clients`.
- A5 `GET /documents` (listar documentos del dueño) + `GET /documents/{id}/download` +
  persistir los bytes generados en `documents.stored_path`.
- A6 `GET /documents/templates` + `POST /documents/generate` (plantillas chilenas + pie legal).
- A7 `POST /documents/analyze` (extracción estructurada por LLM).

**Front (`asistentejudicial.djlabs.cl`, rama `feat/panel-modulos-completos`):**
- F1 Panel *Conversaciones* (listar y abrir en el chat).
- F2 Panel *Causas y plazos*.
- F3 Panel *Clientes*.
- F4 Panel *Buscador de leyes*.
- F5 Panel *Escritos* (plantillas → formulario → generar → descargar).
- F6 Panel *Analizador de documentos*.
- F7 *Documentos generados* dentro de la sección Documentos.

## Restricciones (del requerimiento, módulo 7 y Regla Madre)

- **Créditos: mismo sistema.** Nada de tablas ni saldos nuevos. Costos como tarifas del
  `tariffs` existente (escritos 5, análisis 4, ley 0 gratis), y el front **muestra el costo
  real de la API antes de cobrar** (modal "Esta acción costará X créditos. Tienes Y") y
  bloquea con "Comprar créditos" si el saldo es 0.
- **BCN on demand:** nunca descargar ni indexar todo BCN; solo por número ya consultado, con
  caché puntual y TTL. Si BCN falla, avisar y reintentar; nunca inventar texto.
- **Heart:** se mantiene la resolución vigente (body → query → `X-Heart-Id`), no se inventa
  un header nuevo.
- **Aislamiento:** toda query filtra `user_id` del dueño; toda descarga valida
  `user_id == owner_id`.
- **Sin panel nuevo:** se extiende el panel existente, respetando su diseño y navegación.
- Código y comentarios en inglés; copy de UI en español neutro; el front siempre habla con
  la API por `https://api.djlabs.cl`.

## Tareas

- [x] **T0** — Mapear las piezas a reutilizar y detectar qué endpoint falta de verdad.
      *Evidencia:* `explore` sobre `api-independent` (contratos de `conversations`/`messages`,
      `BcnClient`/`SourceChain`/`legal_cache`, `TemplateRenderer`/`Generator`/`DocumentExporter`,
      almacenamiento de bytes, ruta de LLM con el rotador, convenciones de router y
      migraciones) y sobre el front (secciones faltantes, patrón de módulos).
- [x] **A1** — Conversaciones del dueño (API) + **F1** (front).
      *API:* `feat(conversations): expose the owner's conversation history` (`d383622`)
      + `fix(conversations): return the newest turns of a long thread` (`33d644e`).
      `GET /conversations` y `GET /conversations/{id}/messages`, owner-scoped
      (`user_id`) + aislamiento por corazón (`heart_id = :heart OR heart_id IS NULL`),
      paginación acotada, 404 idéntico para "no es tuya" / "otro corazón" / "no existe",
      401 sin sesión. Batería `tests/test_conversations_owner.php`: **18/18 ALL PASS**.
      *Front:* `feat(front): add the conversations section to the panel` (`9173b8b`).
      Sección "Conversaciones" (listar, ver la transcripción, abrir en el chat
      continuando esa conversación), arnés CDP **42/42** en local y **42/42** en
      `https://asisjud.djlabs.cl`. Entregado en `main`.
- [x] **A2** — Búsqueda de leyes (API) + **F4** (front).
      *API:* `feat(laws): search a law by number on demand from BCN` (`2df2eeb`) +
      `fix(laws): tell an outage apart from a missing law` (`fcb9d4c`).
      `GET /laws/search?numero=` sobre `SourceChain::withDefaults()` + `LegalCache`
      (TTL `legal.cache_ttl_days`), gratis, nunca inventa texto, 404 = la ley no
      existe, 503 = la fuente oficial no respondió (se puede reintentar).
      Baterías `tests/test_laws_search.php` (hermética) y
      `tests/test_laws_search_live.php` (BCN real): **12/12 ALL PASS**.
      *Front:* `feat(front): add the law search section to the panel` (`eac77d0`).
      Sección "Leyes" (buscador BCN on demand, artículo opcional, ventana de
      artículos, enlace a la fuente oficial). Arnés CDP **70/70** local y las 28
      aserciones nuevas en verde contra `https://asisjud.djlabs.cl`. Entregado en `main`.
      Verifica que la consulta **no cobra**: saldo 92 → 92, 0 llamadas a la billetera,
      0 modales de costo.
- [x] **A2b** — El caché legal perdía artículos repetidos (API).
      `LegalCache::put()` deduplicaba por número de artículo: en una ley refundida
      (cuerpo + Disposiciones Finales) la última aparición pisaba a la primera.
      **8 de las 10 leyes cacheadas estaban dañadas**: la 19.628 guardaba el texto
      de las disposiciones finales donde va el artículo 1 principal; la 18.883
      perdía 17 artículos. El chat ya citaba ese texto equivocado.
      Corrección: `fix(legal): keep every article occurrence in the legal cache`
      (`7723f7a`) — columna `article_occurrence`, clave única con la ocurrencia y
      reparación por expiración de las filas dañadas (la cadena las reescribe).
      Migración `075` aplicada y verificada idempotente; **72 artículos recuperados**
      y las 10 leyes cacheadas quedan con `filas == max_orden` (0 colapsos).
      Batería `tests/test_legal_cache_occurrence.php`: **9/9 ALL PASS**.
      Verificado E2E: `GET /laws/search?numero=19628&articulo=1` devuelve ahora el
      artículo 1 **principal**, no el de las disposiciones finales.
- [ ] **A3** — Causas y plazos (API + migración) + **F2** (front).
- [ ] **A4** — Clientes (API + migración) + **F3** (front).
- [ ] **A5** — Documentos del dueño + bytes persistidos (API) + **F7** (front).
- [ ] **A6** — Plantillas y generación de escritos (API) + **F5** (front).
- [ ] **A7** — Analizador de documentos (API) + **F6** (front).
- [ ] **V1** — Verificación final: arnés CDP en producción con todas las secciones y
      pruebas de API para los endpoints nuevos (owner y no-owner).

## Criterios de aceptación

1. Cada sección nueva del panel carga datos reales de la API y ninguna acción apunta a un
   endpoint inexistente.
2. Un usuario solo ve sus conversaciones, documentos, causas y clientes; otro usuario no
   puede leerlos (verificado con dos cuentas).
3. Buscar una ley por número devuelve texto vigente desde BCN con caché puntual; si BCN
   falla, avisa y reintenta, nunca inventa.
4. Las acciones con costo (escritos, análisis) muestran el costo real y el saldo antes de
   cobrar, cobran con el sistema de créditos existente y bloquean con "Comprar créditos"
   cuando el saldo es 0.
5. Los documentos generados se pueden volver a descargar desde el panel.
6. Migraciones numeradas a continuación (074, 075…), estilo del repo, sin duplicar tablas
   existentes.
7. `node --check` en cada JS tocado, `php -l` en cada PHP tocado, pruebas de API nuevas y
   arnés CDP verde en local y en `https://asisjud.djlabs.cl`.

## Comandos de verificación

```bash
# API
php -l app/Rest/<nuevo>.php
php -l public/index.php
bash tests/<nuevo>_test.php        # estilo del repo

# Front
node --check js/<nuevo>.js
node tests/cdp_panel_test.mjs --url http://127.0.0.1:8002
node tests/cdp_panel_test.mjs --url https://asisjud.djlabs.cl
```

### Baterías nuevas de la API

| Batería | Qué prueba | Estado |
| --- | --- | --- |
| `tests/test_conversations_owner.php` | A1: owner + corazón + 401 + 404 + tope de turnos | **18/18 ALL PASS** |
| `tests/test_laws_search.php` | A2: validación y 401 (hermética, sin red) | **4/4 ALL PASS** |
| `tests/test_laws_search_live.php` | A2: BCN real, caché TTL, artículo único, 404 y 503 | **12/12 ALL PASS** |
| `tests/test_legal_cache_occurrence.php` | A2b: cada ocurrencia de artículo conserva su texto | **9/9 ALL PASS** |
| `tests/test_clients_owner.php` | A4: owner + corazón + validación + saldo intacto | en curso |
| `tests/test_cases_owner.php` | A3: owner + corazón + filtro por cliente + saldo intacto | en curso |
| `tests/cdp_panel_test.mjs` | Front: sesión real, secciones, chat con heart, biblioteca | **42/42** local y producción |

## Notas de implementación

- **A1** — `conversations.heart_id` es NULLABLE (migración 044): las filas anteriores a los
  corazones llevan NULL y se tratan explícitamente como "de quien las posee". Las filas de
  OTRO corazón nunca aparecen. El tope de 200 mensajes devuelve los turnos MÁS NUEVOS
  (igual que `ChatService::loadHistory`), no el comienzo del hilo.
- **A1** — Migración `074_conversations_owner_activity.sql` (archivo, no aplicada): índice
  `(user_id, created_at)` para el listado del dueño. **La 075 la tomó el arreglo del
  caché legal (A2b)**, así que clientes = `076` y causas = `077`.
- **A2** — El TTL de la caché ya existe (`legal_cache.expires_at`, `legal.cache_ttl_days`
  = 30 días por defecto): primero se sirve la caché vigente y solo después se va a la red.
- **A2b** — `api.djlabs.cl` es ESTE working copy a través de un túnel: cada commit sirve
  tráfico de producción al instante, así que hay que pushear la rama apenas se commitea
  (el repositorio tiene que contar lo que está sirviendo).
- **A2b** — Una ley refundida puede repetir números de artículo (cuerpo + disposiciones
  finales). El texto legal se guarda por **ocurrencia**, no solo por número: el artículo
  "1" principal y el "1" de las disposiciones finales son textos distintos y ambos se
  conservan. `LawDocument::article('1')` responde con la primera ocurrencia (el cuerpo).
- **M7 / costos** — Los `tariffs` reales NO coinciden con la tabla del requerimiento
  (global: `chat_simple` 8, `chat_doc` 15, `draft_prepare` 180, `doc_analysis_standard`
  50). `TariffService::current($op, $heart)` prioriza la fila **por corazón** sobre la
  global, así que los costos del requerimiento (1, 3, 5, 4) se aplican creando filas
  con `heart_id = 'default'` — sin tocar el precio de los demás corazones.
- **Módulo 5 / pjud.cl** — La consulta a Poder Judicial NO se automatiza en este corte:
  el requerimiento lo permite ("si no se puede automatizar 100%, permitir carga manual").
  La tabla `cases` guarda `fuente_estado` ('manual' | 'pjud') y los campos que pjud
  devolvería, para que la integración sea honesta cuando exista.


## Próximo paso

A1 + F1 (conversaciones): es el corte más barato y desbloquea el patrón de "listar +
abrir en el chat" que las demás secciones copian.

---

**File locator:** `odd/tasks/panel-modulos-completos.md` (repository-relative)
**Engram mirror topic:** `odd/panel-modulos-completos/tasks`
