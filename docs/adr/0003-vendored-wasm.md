# 0003. Vendor Ghostscript-WASM and PDF.js in the repo

Status: accepted
Date: 2026-08-11

## Context

The browser needs `ghostscript-wasm-esm` and `pdfjs-dist`. The image has no npm
and no build step, and loading from a CDN at runtime would tell a third party
(jsdelivr) every time someone compresses a PDF.

## Decision

Commit them in `public/vendor/`: `ghostscript-wasm-esm@1.0.1` (15.4 MB) and
`pdfjs-dist@6.2.108` (1.6 MB, minified build and worker only).
`test/vendor.sh` re-fetches them and records checksums in `VENDOR.txt`. The
Dockerfile copies the vendor folder on its own layer, before the app code.

## Consequences

- Nothing leaves the browser; builds need no network for these files.
- Updates are manual: run `test/vendor.sh` with a new version.
- Ghostscript is **AGPL-3.0**, PDF.js **Apache-2.0**. Serving them is
  distribution, so both licences ship beside them and are linked from the page.
