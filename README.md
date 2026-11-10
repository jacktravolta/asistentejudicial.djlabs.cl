# Asistente Judicial Digital — front

Static front-end for **Asistente Jurídico Digital**. This repository contains
**no back end**: every page is a static file, and every backend call goes to
the unified API at `https://api.djlabs.cl`.

- **Live site:** <https://jacktravolta.github.io/asistentejudicial.djlabs.cl/>
- **API:** `https://api.djlabs.cl`
- **Migration notes:** [MIGRATION.md](./MIGRATION.md)

---

## What lives here

| Path | What it is |
| --- | --- |
| `index.html` | The landing page and the single-page application (login, panel, chat, wallet, top-ups). |
| `ley-datos/` | The Ley 21.719 landing page and its panel (`app.html`). |
| `url-analyzer/` | The URL-analyzer landing page and its panel. |
| `cv/`, `judicial/`, `corporativo/` | Heart-specific front doors. |
| `embed/corporate-chat.js` | The embeddable corporate chat widget, usable on any website. |
| `demo/` | A demo page for the embeddable widget. |
| `js/` | ES modules shared by the pages (API client, auth, chat, wallet, notifications, usage, editors). |
| `css/` | Design tokens and the Quill stylesheet. |
| `api-config.js` | The single deploy-time knob: the API origin. |
| `terminos.html`, `privacidad.html`, `preguntas.html` | Legal and help pages. |

`login.html`, `wallet.html`, `chat.html`, `landing.html` and `preguntas.html`
are tiny redirect stubs to the SPA's hash routes.

---

## Configuration

`api-config.js` is the only file that changes between environments:

```js
window.__API_BASE__ = 'https://api.djlabs.cl';
```

It is a plain script (not an ES module) and every page loads it **before**
its own modules, so `js/api-base.js` can read it at import time.

```js
import { apiUrl } from './api-base.js';
fetch(apiUrl('/auth/me'), { credentials: 'include' });
```

Two rules apply to every API call:

1. **Resolve the URL through the API origin** — `apiUrl()` in ES modules,
   `window.API()` in plain HTML pages, `data-api-base` in the embeddable
   widget.
2. **Send `credentials: 'include'`** — the front and the API live on
   different origins, so the httpOnly session cookie only travels when the
   request opts in explicitly.

---

## Local development

The project is plain static files; any static server works:

```bash
php -S 127.0.0.1:8816 -t .
# or
python3 -m http.server 8816
```

Then open <http://127.0.0.1:8816/>.

To develop against a local API, point `api-config.js` at it
(`http://127.0.0.1:8086`) and make sure the API allows this origin in
`cors.origins`.

---

## Deployment

GitHub Actions publishes the repository with **no build step** — there is no
bundler, no npm and no compile phase. The workflow
(`.github/workflows/pages.yml`) checks out the repository and uploads the
files as a Pages artifact.

- Branch: `main`
- Site: <https://jacktravolta.github.io/asistentejudicial.djlabs.cl/>

Because the project is served from a **sub-path**, every asset and route in
this repository is relative. Keep it that way: a root-absolute URL
(`/css/tokens.css`) breaks the moment the site is not served from the root
of a host.

The SPA panels are **hash routes** (`#/wallet`, `#/admin`, `#/recargas`)
because a static host has no server rewrite for `/wallet`.

---

## Repository conventions

- No secrets, tokens or API keys in this repository. The only configuration
  is the public API origin.
- No server-side code: no PHP, no session handling, no `.htaccess`.
- API calls are never relative to the page — they always go through the API
  origin.
- Legal and privacy copy is Spanish; code, comments and documentation are
  English.
