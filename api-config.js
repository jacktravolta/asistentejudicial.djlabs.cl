// api-config.js — the ONE deploy-time knob of the frontend.
//
// This deployment is the 2-SERVER TOPOLOGY (static front on GitHub Pages +
// backend on a different host), so window.__API_BASE__ points at the
// BACKEND origin. Every API call — and ONLY API calls — is resolved against
// it; navigation links, assets and SPA routes stay same-host, because they
// belong to the front server.
//
// This file is plain JS (not an ES module) so index.html loads it BEFORE
// the modules, and the deploy can rewrite just this one file:
//
//   window.__API_BASE__ = 'https://api.djlabs.cl';
//
// The backend must trust this origin in its 'cors.origins' config
// (exact scheme+host+port), and cookies must allow the cross-site flow
// (auth.cookie_samesite='None' when the two hosts are different sites).
window.__API_BASE__ = 'https://api.djlabs.cl';
