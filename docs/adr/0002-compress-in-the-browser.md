# 0002. Compress PDFs in the browser, not on the server

Status: accepted
Date: 2026-08-11

## Context

Server-side compression meant uploading every file to the Pi and running a C
parser (Ghostscript) on files strangers chose, on the box that also runs
gatekeeper, Grafana and tv-webui.

## Decision

Ghostscript compiled to WebAssembly runs in Web Workers in the user's tab. The
server ships the page and the wasm, and answers GET only; a POST to a tool is a
405, asserted by `test/prefix.sh`.

| | server-side (rejected) | in-browser (chosen) |
| --- | --- | --- |
| Where files go | uploaded to the Pi | nowhere |
| Ghostscript | native binary in the image | 15.4 MB wasm, cached |
| Pi's job per file | one gs process, capped, queued | serve a static file |
| Hostile PDF parsed by | the box running gatekeeper | the tab that opened it |
| Cost | upload time, 100 MB cap | one-time 15.4 MB download |

## Consequences

- Output matches native gs on the same file to within a percent (measured when
  the decision was made).
- Needs JavaScript, module workers and a one-time 15.4 MB download.
- A very large PDF can exhaust a phone tab where the Pi would have coped; that
  is the user's tab, not everyone's gateway.
- "Nothing is uploaded" rules out server-side features such as sending email.
