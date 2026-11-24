# 0004. Render the side-by-side preview with PDF.js

Status: accepted
Date: 2026-08-13

## Context

The preview first used two `<iframe>`s with the browser's built-in PDF viewer:
an independent renderer is a second opinion on the file. But that viewer is a
separate, cross-origin document: its scroll position can be neither read nor
set, `#zoom=` is ignored for `blob:` URLs, and resizing the frame to zoom put
the bottom of the page out of reach. The two panes could never stay together.

## Decision

Render both panes with PDF.js (vendored, see [0003](0003-vendored-wasm.md)),
loaded only when a preview is first opened (1f779d3).

## Consequences

- Scroll and zoom are under our control and kept in sync.
- Still a second opinion: PDF.js shares no code with Ghostscript. Lost: it is
  not *this* user's own viewer.
- We own the rendering bugs; see
  [L-003](../lessons.md#l-003--2026-08-13--bug--side-by-side-preview-drifted-apart).
