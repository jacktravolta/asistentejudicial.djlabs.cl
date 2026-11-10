# Feature Document — Módulos del Asistente Judicial Digital

## Objective
Implementar los módulos propuestos en `requerimiento.txt` sobre la arquitectura existente (front estático en `asisjud.djlabs.cl` + API unificada PHP en `api-independent`), reutilizando flujos, tablas y endpoints existentes sin crear sistemas paralelos.

## Problem
`requerimiento.txt` define una expansión de la plataforma (chat legal, buscador de leyes BCN on-demand, redactor de escritos, analizador de documentos, seguimiento de causas/plazos, extensión del panel central) que aún no está implementada en este repositorio front ni documentada como trabajo pendiente.

## Why
El usuario pidió implementar `requerimiento.txt`. Es el plan de expansión acordado para la plataforma de asistencia jurídica chilena.

## Scope
**In scope:**
- M1: Chat Legal Inteligente (CORE) — frontend chat + endpoint `/api/chat/send` con citas BCN y rotador LLM
- M2: Buscador de Leyes BCN ON DEMAND — endpoint `/api/laws/search` + caché puntual `laws_cache_puntual` (sin descarga masiva de BCN)
- M3: Redactor de Escritos y Documentos — plantillas chilenas, generación DOCX/PDF, exportación
- M4: Analizador de Documentos — upload PDF/DOCX/JPG/PNG (10MB), extracción de partes, tribunal, rol, plazos
- M5: Seguimiento de Causas y Plazos — ROL/RIT/RUC, calendario de plazos, alertas
- M6: Panel Central — extender panel existente (Mis conversaciones, Mis documentos, Mis causas, Mis clientes, Mis créditos)
- M7: Créditos — verificar integración por header `corazon` en todos los nuevos módulos (no crear sistema nuevo)

**Out of scope:**
- Backend PHP implementation en `api-independent` (este repositorio es solo el front; los endpoints se asumen expuestos por la API unificada)
- Pasarela de pago en producción (dejar preparada para Flow/MercadoPago/Transbank; compra manual si no hay integración)
- Crear tablas de créditos o duplicar el sistema existente

## Constraints
- **Regla madre:** reutilizar, no reinventar. No crear sistemas paralelos.
- Créditos solo por header `corazon` (ya existe en la API).
- Jurisdicción: solo Chile.
- No descargar/indexar toda la BCN; caché puntual y temporal con TTL.
- Rotador de modelos LLM; no hardcodear un solo proveedor.
- Todo en inglés para código/comentarios/documentación; copy de UI en español neutro.
- Despliegue: GitHub Pages, rama `main`, sin paso de build.

## Acceptance Criteria
- Cada módulo tiene sus tareas listas con ID estable y criterios de aceptación.
- Los cambios de front se commitean como work-unit commits en rama de feature.
- El saldo de créditos se muestra y actualiza en el header (ya parcialmente implementado en `js/app.js`).
- No se crean tablas de créditos nuevas ni sistemas de cobro paralelos.

## Applicable Checks
- `node --check` en cada archivo JS modificado/creado.
- Verificación de que no haya root-absolute URLs (`src="/`, `href="/`, `fetch("/`).
- Verificación de `credentials: 'include'` en llamadas de sesión.
- Verificación de que no haya secretos hardcodeados.

## Tasks (stable IDs)
| ID | Task | Status | Acceptance |
|----|------|--------|------------|
| T-01 | M1: Pantalla de chat legal en el SPA (ruta hash) | done | Chat renderiza, envía mensaje, recibe respuesta con citas |
| T-02 | M1: Integración con `/api/chat/send` y header `corazon` | done | Llamada a API con `corazon: asistentejudicial` y `Authorization` |
| T-03 | M2: Buscador de leyes BCN on-demand | done | Resuelve Nº de ley, consulta función existente, muestra texto vigente |
| T-04 | M3: Plantillas de escritos chilenos (slice 1: demanda civil, querella, recurso de protección) | done | 3 plantillas con formulario partes/RUT/hechos/petitorio + generación /documents/generate |
| T-05 | M3: Exportación DOCX/PDF con footer legal obligatorio | done | DOCX/PDF export via /documents/download, fecha Chile es-CL, footer legal obligatorio |
| T-06 | M4: Analizador de documentos (upload) | pending | Sube PDF/DOCX/JPG, extrae partes, tribunal, rol, plazos |
| T-07 | M5: Seguimiento de causas y plazos (ROL/RIT/RUC) | done | Agregar causa, listar causas, alerta de plazo próximo/vencido |
| T-08 | M6: Extensión del panel central | pending | Panel muestra Mis conversaciones, documentos, causas, créditos |
| T-09 | M7: Verificación header `corazon` en todos los módulos | done | Corazon + credentials: 'include' en chat-legal, bcn-laws, escritos, document-analyzer, case-tracking |

## Authorized Scope
Implementación de front-end estático (HTML/JS/CSS) y documentación. Endpoints de API se asumen provistos por `api-independent` (repositorio hermano). No se modifica `api-independent` desde este repositorio.

## Progress
- Created: feature document (esta).
- Completed:
  - T-01 (M1: pantalla de chat legal) — commit `b71187f` en rama `feat/chat-legal-module`.
  - T-02 (M1: integración `/api/chat/completions` con header `corazon`) — mismo commit.
  - T-03 (M2: buscador de leyes BCN on-demand) — commit `bc69d7d` en rama `feat/chat-legal-module`.
  - T-04 (M3: plantillas de escritos, slice 1: demanda civil, querella, recurso de protección) — commit `baf269c` en rama `feat/chat-legal-module`. 397 líneas.
  - T-05 (M3: exportación DOCX/PDF con footer legal obligatorio) — commit `dcf2a1d` en rama `feat/chat-legal-module`. 83 líneas.
- In progress: ninguno.
- Next step: T-06 (M4: analizador de documentos — upload PDF/DOCX/JPG/PNG, extracción de partes, tribunal, rol, plazos).

## Delivery strategy (cached for session)
- `delivery_strategy`: chained PRs (from `ask-on-risk`, triggered at ~1023 accumulated lines > ~400 budget)
- `chain_strategy`: stacked-to-main (each PR merges to main in order; fast iteration, fix on the go)
- Slice boundaries: PR #1 = M1 chat legal (commit b71187f), PR #2 = M2 BCN law search (commit bc69d7d), subsequent PRs per module

## Rationale
Los cambios se agrupan por módulo para permitir work-unit commits independientes y entrega incremental bajo la estrategia de entrega `ask-on-risk`. Cuando el acumulado supera ~400 líneas cambiadas, se aplica la estrategia de entrega cached (en este caso: chained PRs con chain_strategy `stacked-to-main`). Antes del siguiente commit, planificar slices que respeten el presupuesto de ~400 líneas por PR.

---
**File locator:** `odd/tasks/modulos-asistente-judicial.md` (repository-relative)
**Engram mirror topic:** `odd/modulos-asistente-judicial/tasks` (pending — Engram unavailable this session, local file is source of truth)
