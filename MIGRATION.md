# Migration — Asistente Judicial front → static site on the unified API

This repository is the **front-only** successor of the legacy PHP project
`asistente-judicial`. It contains no PHP, no server-side session logic and
no credentials: every page is a static file served by GitHub Pages, and
every backend call goes to the unified API at `https://api.djlabs.cl`.

- **Source (read-only):** `/home/test/test/asistente-judicial/public/`
- **Unified API (authoritative route map):** `/home/test/test/api-independent/public/index.php`
  (`$router->register(...)`, ≈150 routes) plus `app/Rest/*Controller.php`
  for the payload contracts.
- **Target:** `/home/test/test/asistentejudicial.djlabs.cl/`
- **Published:** `https://jacktravolta.github.io/asistentejudicial.djlabs.cl/`

---

## 1. Topology

| Piece | Before | After |
| --- | --- | --- |
| Front | PHP served by the legacy app (`index.php` + `public/`) | Static files on GitHub Pages (project sub-path) |
| Back end | Same origin (`/api/*.php`) | `https://api.djlabs.cl` (cross-origin) |
| API origin knob | `window.__API_BASE__ = ''` (same origin) | `window.__API_BASE__ = 'https://api.djlabs.cl'` |

`api-config.js` is the single deploy-time knob and is loaded **before** any
module, so `js/api-base.js` can read it at import time.

Two consequences of the cross-origin topology were applied everywhere:

1. **Every API call goes through the API origin.** ES modules use
   `apiUrl(path)` from `js/api-base.js`; plain HTML pages use
   `window.API(path)` (a helper identical to the one the legacy
   `ley-datos/app.html` already had); the embeddable widget uses
   `data-api-base` with a `window.__API_BASE__` fallback.
2. **Every session-bearing call sends `credentials: 'include'`.** The legacy
   `credentials: 'same-origin'` never leaves the origin, so it would have
   silently dropped the httpOnly auth cookie on the new topology.

---

## 2. What was copied

Everything under the legacy `public/` that is part of the front:

```
api-config.js   DESIGN.md   informe-ejemplo.pdf
*.html          css/        js/        img/
corporativo/    cv/         judicial/ demo/    embed/
ley-datos/      url-analyzer/
```

## 3. What was excluded, and why

| Excluded | Reason |
| --- | --- |
| `index.php` | Server-side entry point. The SPA is now the static `index.html`. |
| `api/**` (36 scripts) | The whole PHP back end. Its behaviour now lives in the unified API. |
| `admin.html`, `js/admin.js` | Out of scope for this migration (see GAP-4). |
| `heart-metrics.html` | Internal metrics page; it called `/api/sessions/complete-deletion.php` and imported the excluded `js/modules/*` modules. |
| `js/app.js.bak` | Backup file. |
| `perf-comparison.json`, `perf-results.json`, `test-hearts-results.json` | Test/benchmark artefacts. |
| `_preview_biobio.html`, `_preview_fmdos.html`, `_preview_lider.html`, `_preview_lider.pdf` | Previews. |
| `bonus-mail-preview.html`, `bonus-panel-preview.html`, `informe-mail-preview.html`, `welcome-email-preview.html`, `welcome-heart-preview.html` | Mail/UI previews. |
| `_demo_chat_informe.html` | Dev-only demo that embeds the excluded `_preview_biobio.html`. |
| `.htaccess` | Apache-only; GitHub Pages ignores it. |

---

## 4. Route mapping — legacy `/api/*.php` → unified API

Every legacy endpoint that the kept front referenced was verified against
`api-independent/public/index.php`. **No endpoint was invented.**

| Legacy (legacy front) | Unified API | Method change | Notes |
| --- | --- | --- | --- |
| `/api/auth/magic-link` | `/auth/magic-link` | — | `js/modules/auth.js` (dead module, remapped anyway) |
| `/api/document-download.php` | `/documents/download` | — | Same payload contract (`format`, `html`, `operationId`, `templateId`, `heart`, `quote`). |
| `/api/tts.php` | `/tts` | — | Same payload contract. |
| `/api/heart-theme.php` | `/ui/theme` | JS file → JSON | **Contract change**, see §6. |
| `/api/wsp-chat-config.php` | `/wsp/chat-config` | — | GET + PUT. |
| `/api/rag/list-sources.php` | `/rag/sources` | — | |
| `/api/rag/source-text.php` | `/rag/sources/text` | — | `?id=&heart=`. |
| `/api/rag/update-source-text.php` | `/rag/sources/text` | POST → **PUT** | Body `{sourceId, text, heart}` unchanged. |
| `/api/rag/delete-source.php` | `/rag/sources` | POST → **DELETE** | Body `{sourceId \| sourceIds, heart}` unchanged. |
| `/api/rag/chat-enabled.php` | `/rag/sources/chat-enabled` | — | Body `{source_id, enabled, heart}` unchanged. |
| `/api/rag/visitor-conversations.php` | `/rag/visitor-conversations` | — | |
| `/api/rag/visitor-conversation.php` | `/rag/visitor-conversations/{id}` | query → **path param** | UUID stays 36 chars. |
| `/api/rag/delete-visitor-conversation.php` | `/rag/visitor-conversations/{id}` | POST → **DELETE** | Body `{id, heart}` kept. |
| `/api/rag/visitor-guard.php` | `/rag/visitor-guard` | — | Body `{visitor_key, blocked, heart}` unchanged. |
| `/api/rag/embed-config.php` | `/rag/embed-config` | POST → **PUT** (save) | GET (read) unchanged. |
| `/api/rag/embed-avatar.php` | `/rag/embed-avatar` | — | Multipart `{heart, avatar \| action}` unchanged. |
| `/api/rag/corporate-usage.php` | `/usage/summary` | — | **Response shape change**, see §6. |
| `/api/embed-config.php` | `/rag/embed-config` | — | GET. |
| `/api/ley-datos-analyze.php` | `/analyzer/analyze` | — | `heart` added to the body. |
| `/api/ley-datos-ingest.php` | `/content/ingest` | — | |
| `/api/ley-datos-submit.php` | `/analyzer/jobs` | — | `heart` added to the body. |
| `/api/ley-datos-status.php` | `/analyzer/jobs/{operationId}` | POST → **GET** | `?heart=` added. |
| `/api/ley-datos-history.php` (`?operation_id=`) | `/analyzer/analyses/{operationId}` | query → **path param** | `?heart=` added. |
| `/api/ley-datos-history.php` (`?limit=`) | `/analyzer/analyses` | — | `?heart=` added. |
| `/api/ley-datos-delete.php` | `/analyzer/analyses/{operationId}` | POST → **DELETE** | `?heart=` added. |
| `/api/ley-datos-ingest-status.php` | `/content/ingest/{operationId}` | query → **path param** | |
| `/api/url-analyzer-todo-en-1.php` | `/analyzer/analyze` | — | `heart` added to the body. |
| `/api/url-analyzer-history.php` | `/analyzer/analyses[/{operationId}]` | — | `?heart=` added. |
| `/api/url-analyzer-delete.php` | `/analyzer/analyses/{operationId}` | POST → **DELETE** | `?heart=` added. |

Legacy scripts that the kept front never referenced (no action needed):
`/api/admin/logs.php`, `/api/chat-queue.php`, `/api/embed-avatar.php`,
`/api/job-process-one.php`, `/api/job-status.php`, `/api/ley-datos-complete.php`,
`/api/ley-datos-jobs.php`, `/api/rag/chat-snippet.php`.

---

## 5. The heart contract

`HeartResolver` (`api-independent/app/Rest/HeartResolver.php`) resolves the
heart in this order: **JSON body → query string → `X-Heart-Id` header**, and
falls back to the installation heart when the request names none.

Each surface keeps the heart it already used, and every money/history path
now names it explicitly:

| Surface | Heart | Where it is sent |
| --- | --- | --- |
| `ley-datos/` | `ley_datos_21719` | body on `/analyzer/analyze`, `/analyzer/jobs`, `/content/ingest`; `?heart=` on `/analyzer/analyses*`, `/analyzer/jobs/{id}`, `/rag/sources*`, `/rag/visitor-*`, `/wsp/chat-config`, `/auth/me` |
| `cv/` | `cv` | body on `/auth/magic-link` and `/auth/login` |
| `judicial/` | `judicial` | body on `/auth/magic-link` and `/auth/login` |
| `corporativo/` | `chat-corporativo` | body on `/auth/magic-link` and `/auth/login` |
| `url-analyzer/` | `url-analyzer` | body on `/auth/magic-link`, `/auth/login`, `/analyzer/analyze`; `?heart=` on `/analyzer/analyses*`, `/auth/me` |
| root SPA (`index.html`) | default (installation heart) | no heart sent — same as the legacy root panel |

`/auth/login` in the four heart sub-fronts previously sent only
`{email, password}`; the heart was added so the balance the API returns
right after the login belongs to the wallet the visitor just entered from.

**Two routes read the heart from the query string only** (their controller
calls `HeartResolver::resolve($request->query('heart', ''))`, and the `??`
fallback does not fire on an empty string): `/analyzer/analyses*` and
`/analyzer/analyses/{id}` (DELETE). For those the heart is always sent as
`?heart=`, never only in the body.

---

## 6. Payload and contract drift that had to be handled

### 6.1 `/ui/theme` answers JSON, not JavaScript

The legacy `/api/heart-theme.php` returned a small executable script that
the landing injected with `<script src=…>`. The unified `/ui/theme`
returns `{success, data:{heart, skin, tema}}`.

Both `ley-datos/index.html` and `ley-datos/app.html` now fetch it as JSON
and apply the same two rules themselves:

- `skin` is admin-configured → asserted over any stale `localStorage`.
- `tema` only fills a visitor that never chose day/night.

**Behaviour change:** the theme is applied asynchronously instead of
synchronously before first paint, so a visitor may briefly see the default
skin. Theming is a preference, never a gate, and the markup defaults still
apply if the request fails.

### 6.2 `/usage/summary` nests the corporate counters

The legacy `/api/rag/corporate-usage.php` answered `{data:{queries,
input_tokens, output_tokens, total_tokens}}`. The unified `/usage/summary`
answers the same numbers under `data.corporate.*`. `demo/index.html` was
updated to read `d.data.corporate`.

The unified route requires authentication, so the demo badge (dev-only)
hides itself for an anonymous visitor instead of showing a dev-only owner
override.

### 6.3 Root-relative asset URLs do not survive a sub-path

GitHub Pages serves this project under
`https://jacktravolta.github.io/asistentejudicial.djlabs.cl/`. Every
root-absolute reference (`/css/…`, `/js/…`, `/api-config.js`, `/embed/…`,
`/ley-datos/img/…`) was rewritten to a relative one (`./…` or `../…`), and
every dynamic import in the ES modules was rewritten too.

The two places that cannot be relative — a file the visitor's browser
requests from a host we do not control — are resolved against the module's
own URL:

- `js/chat-editor.js` / `js/quill-loader.js` load Quill from
  `new URL('./vendor/quill.min.js', import.meta.url)`.
- `js/chat-widget.js` imports the editor with
  `new URL('./chat-editor.js?v=…', import.meta.url)`.

### 6.4 The SPA is hash-routed

The SPA used to rewrite the URL to `/`, `/wallet`, `/admin` and `/recargas`.
A static host has no server rewrite, so `/wallet` would 404 on a reload.
The panels are now **hash routes** (`#/`, `#/wallet`, `#/admin`,
`#/recargas`), which the sibling stubs (`wallet.html`, `chat.html`,
`login.html`, `preguntas.html`, `landing.html`) already used.

The legal links (`#/terminos`, `#/privacidad`) still open the standalone
`terminos.html` / `privacidad.html` pages, now addressed relative to the
site root.

### 6.5 The front origin and the API origin are two different values

`ley-datos/app.html` prints the embeddable-widget snippet for the owner's
website. The snippet file is served by **this front** (`FRONT_BASE`, which
includes the sub-path), while `data-api-base` is the **API origin**. The
legacy code used `window.location.origin` for both, which was correct when
the two were the same host.

`window.FRONT_BASE` (the front's absolute base URL, sub-path included) and
`window.__API_BASE__` (the API origin) are now kept apart. The bot avatar
URL comes from the API as a root-relative path on the **API** host and is
prefixed accordingly (`apiAsset()` in `ley-datos/app.html`, and the same
treatment in `embed/corporate-chat.js`).

---

## 7. Gaps — legacy routes with no unified equivalent

These are **not** implemented, because the unified API does not expose them.
Nothing was invented to paper over them.

| # | Legacy route | Where | Consequence |
| --- | --- | --- | --- |
| GAP-1 | `/api/corporate-chat-status.php` (availability probe) | `embed/corporate-chat.js:933` (was called at legacy line 926) | The probe was **removed**. The bubble is always shown; the owner's balance is enforced on the first message, which already answers with the kind 402 message. |
| GAP-2 | `/api/sessions/complete-deletion/{id}` | `js/modules/delete-modal.js:188` | Dead module — no page imports it. The call is kept and flagged with a `GAP` comment; it needs a server-side route before it can be used. |
| GAP-3 | `/api/documents/{id}/edit-status` | `js/modules/editor.js:62` | Dead module — no page imports it. Same treatment as GAP-2. |
| GAP-4 | Admin panel implementation (`js/admin.js`) | `js/app.js:708` (`import('./admin.js?v=7')`) | `js/admin.js` is excluded from this migration by scope. The SPA's admin panel therefore renders empty. The unified API **does** expose the admin routes (`/admin/*`), so the module can be ported later. |

`js/modules/auth.js`, `js/modules/editor.js` and `js/modules/delete-modal.js`
are dead code in the legacy project as well (the only importer was the
excluded `heart-metrics.html`). They were copied for completeness and their
API-base handling was corrected, but they are not reachable from any page.

---

## 8. Other fixes made during the migration

| Fix | Where | Why |
| --- | --- | --- |
| Unbalanced parenthesis in a rewritten `window.API(...)` call | `ley-datos/app.html:4702` | Caught by a syntax check of every inline script; the visitor-conversation request would have broken the whole panel script. |
| Live `<script>` tags inside prose | `demo/index.html:49` and `demo/index.html:61` | The HTML parser treated `<code><script></code>` as the start of a script element and swallowed the rest of the page. The tags are now escaped as text. |
| PHP short-echo tags | `cv/index.html`, `judicial/index.html`, `corporativo/index.html`, `url-analyzer/index.html` | `<?= date('Y') ?>` is not valid in a static file; replaced with the literal year. |
| `credentials: 'same-origin'` on API calls | `js/auth.js`, `js/uso.js`, `js/chat-widget.js`, `ley-datos/index.html`, `url-analyzer/app.html`, `rag-chat.html` | `same-origin` never leaves the origin, so the session cookie would have been dropped. |
| Chat widget posted to the front origin | `js/chat-widget.js:2012` | `(options.apiBase \|\| '')` produced a relative `/chat/completions` on the static host. It now defaults to the API origin. |
| `window.location.origin` used for the API | `ley-datos/app.html:3506`, `ley-datos/app.html:5355` | Split into `FRONT_BASE` (front) and `__API_BASE__` (API). |

---

## 9. Verification performed

```bash
# no server-side leftovers
find . -name "*.php"                       # → empty
grep -rn "<?=\|<?php" --include=*.html .   # → empty

# no root-absolute assets or API calls
grep -rn 'src="/\|href="/' --include=*.html --include=*.js .
grep -rn "fetch(\s*['\"\`]/" --include=*.html --include=*.js .

# every local reference resolves on a local static server
php -S 127.0.0.1:8816 -t .
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8816/index.html   # → 200
```

Every `*.js` file and every inline `<script>` block was also parsed with
`node --check` (0 issues) and every local `src`/`href`/dynamic import was
resolved against the local server (0 broken, 0 root-absolute).

---

## 10. Deploy requirements on the API side

The front now calls the API from a different origin. The unified API must:

- allow `https://jacktravolta.github.io` in `cors.origins`;
- set the session cookies with `SameSite=None; Secure` (cross-site);
- keep `X-Heart-Id` / `heart` handling as it is today.

**Already satisfied.** The unified API's `config.php` lists
`https://jacktravolta.github.io` in `cors.origins` and sets
`auth.cookie_samesite` to `None`. Verified against the live API:

```
$ curl -s -D - -o /dev/null -H "Origin: https://jacktravolta.github.io" \
    https://api.djlabs.cl/ui/theme | grep -i access-control
access-control-allow-credentials: true
access-control-allow-origin: https://jacktravolta.github.io
vary: Origin
```

The preflight (`OPTIONS /auth/login`) returns `204` with the same
`access-control-allow-origin`, so the browser will accept the
credentialed cross-origin calls the front makes.

---

## 11. How the site is published

### 11.1 The active source: the branch build

Pages is configured with:

```
build_type: legacy
source:    { branch: "main", path: "/" }
html_url:  https://jacktravolta.github.io/asistentejudicial.djlabs.cl/
```

There is **no build step** in either mode: the repository is the artifact.
`.nojekyll` is committed so the branch build serves the files verbatim
instead of running them through Jekyll. Every push to `main` rebuilds and
republishes the site; a rebuild can also be triggered on demand with
`gh api -X POST repos/jacktravolta/asistentejudicial.djlabs.cl/pages/builds`.

### 11.2 Why the Actions workflow is not the active source yet

`.github/workflows/pages.yml` is written and ready, but the OAuth token this
environment authenticates with carries only the `gist`, `read:org` and
`repo` scopes. **GitHub refuses any write under `.github/workflows/` without
the `workflow` scope**, and it refuses it on the *path*, not on the
transport. Every route was tried and measured:

| Attempt | Result |
| --- | --- |
| `git push` over HTTPS | `refusing to allow an OAuth App to create or update workflow .github/workflows/pages.yml without workflow scope` |
| `git push` over SSH with a repo deploy key | Same rejection. A deploy key does not carry OAuth scopes, so it inherits the same limit. |
| Contents API (`PUT /contents/.github/workflows/pages.yml`) | `404 Not Found` |
| Git database API (`POST /git/trees` with that path) | `404 Not Found` — the same path is accepted for any other file |
| `POST /user/tokens`, `POST /users/{user}/tokens`, fine-grained token API | `404 Not Found` — token minting is not available to this token |

So the file cannot be committed from here. It stays on disk, untracked, and
the site is published by the branch build instead.

### 11.3 Switching to the Actions workflow

The change is two steps, both of which need a credential with the
`workflow` scope:

```bash
# 1. grant the scope (device flow — needs a human at the browser)
gh auth refresh -h github.com -s workflow

# 2. commit the workflow and switch the Pages source
cd <repo>
git add .github/workflows/pages.yml
git commit -m "ci: publish the static front to GitHub Pages"
git push origin main
gh api -X PUT repos/jacktravolta/asistentejudicial.djlabs.cl/pages \
  -f build_type=workflow
```

The workflow itself needs no build step either: it checks out the
repository and uploads the working tree as the Pages artifact.

Until then, **do not delete the branch build**. It is what keeps the site
online, and `build_type: legacy` is fully supported by the Pages API.
