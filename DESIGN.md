# Design system — Asistente Jurídico Digital

Compact reference for the visual language of the front end. Tokens live in
`public/css/tokens.css`; Tailwind maps them to utility classes in
`public/js/tailwind.config.js`. Both are loaded by every page.

## Subject

A calm, trustworthy legal-assistance service for people in Chile who face a
legal procedure alone. The visual language should feel like a well-kept
notary's desk: paper, ink, a single restrained seal — never a startup
dashboard and never a "chat with an AI" product.

## Color

Six named values carry the identity. Neutrals are cool and green-tinted
(paper, not cream); the accent is a deep spruce ink, not terracotta and not
acid green.

| Name | Light | Dark | Role |
| --- | --- | --- | --- |
| Papel | `#F4F7F6` | `#0C1413` | Page background |
| Tinta | `#12211F` | `#E8EFED` | Primary text |
| Abeto | `#0E5C55` | `#5FD3C0` | Primary accent (skin: `teal`) |
| Índigo | `#4338CA` | `#A5B4FC` | Alternate accent (skin: `indigo`) |
| Sello | `#8A5A0B` | `#F0C879` | Warning / "verify this" amber |
| Bruma | `#DCE5E2` | `#2C3B38` | Borders and dividers |

Status colours (success, warning, danger, info) are derived from the same
cool family and always read as soft tint + strong text, so alerts stay
legible in both themes.

## Type

- **Display — Newsreader** (serif, reading-optimized): headings and the
  brand voice. A document-reading serif, chosen because the product is about
  reading documents.
- **Body/UI — Public Sans** (humanist sans, civic clarity): paragraphs,
  labels, buttons, tables.

Scale (fluid where it matters): display `clamp(1.75rem, 1.3rem + 2vw, 3rem)`
for hero headings, then `1.5rem` section headings, `1rem` body, `0.875rem`
UI, `0.75rem` captions. Body line length capped near 70 characters.

## Layout + principles

A single centered column (max ~72rem) with generous vertical rhythm; content
is left-aligned, only marketing section headers are centered. Structure comes
from hairline borders and surface changes, not from shadows on every card.
One memorable element per screen (the hero's "workspace" card on the landing,
the balance figure on the wallet); everything around it stays quiet.

- **Empathy is a layout rule.** Costs, limits and consequences are visible
  before the action, never hidden behind a click.
- **Same action, same name.** A button and its result use the same verb.
- **Theme is a token switch.** Day/night and accent skins swap CSS custom
  properties only; no component forks.

## Self-critique

First pass used a warm cream background with a teal accent — the exact
warm-neutral + accent combo the brief warns reads as generic. I moved the
neutrals to a cool, green-tinted paper and made the accent a deep spruce
(a notary's ink) so the palette reads as legal/civic rather than "AI chat
product". I also dropped the system-font stack for Newsreader + Public Sans,
which ties the type to reading documents instead of a dashboard.
