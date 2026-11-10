# Image credits

The four landing-page photos are **no longer vendored here**. They are served
through GitHub Pages from their own repository, and `public/index.html`
hotlinks them:

    https://jacktravolta.github.io/asistente-judicial-assets/<file>.webp

Repository: https://github.com/jacktravolta/asistente-judicial-assets
Canonical credits (sources, licenses, replacement rules): `CREDITS.md` there.

All images are free to use under the [Unsplash License](https://unsplash.com/license)
(free for commercial and non-commercial use, no permission needed; attribution
appreciated but not required). The attribution below is provided as good practice.

| File | Source (Unsplash page) | Author | License |
| --- | --- | --- | --- |
| `hero-signing-document.webp` | https://unsplash.com/photos/man-writing-on-paper-OQMZwNd3ThU | Scott Graham (@amstram) | Unsplash License |
| `desk-workspace.webp` | https://unsplash.com/photos/person-holding-pencil-near-laptop-computer-5fNmWej4tAA | Scott Graham (@amstram) | Unsplash License |
| `documents-organized.webp` | https://unsplash.com/photos/person-holding-paper-near-pen-and-calculator-xoU52jUVUXA | Kelly Sikkema (@kellysikkema) | Unsplash License |
| `calm-planning.webp` | https://unsplash.com/photos/white-ceramic-mug-with-coffee-on-top-of-a-planner-aQfhbxailCs | Estée Janssens (@esteejanssens) | Unsplash License |

## Notes

- Photos were chosen for a calm, trustworthy legal-services tone: documents,
  desks, hands, and quiet workspaces. None of them implies a legal result or a
  judicial outcome.
- Testimonials on the landing page remain speech bubbles without faces.
- To replace a photo: same filename in the assets repo (URL stability),
  update its `CREDITS.md`, and keep `loading="lazy"` + descriptive `alt` in
  the landing markup.
