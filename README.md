<div align="center">

# toolshed

Small self-hosted utilities behind the gatekeeper edge.

[Quick start](#quick-start) • [Getting started](#getting-started) • [Deployment](#deployment-and-operations) • [Open questions](#open-questions)

</div>

A shell for small web tools, served at `/toolshed/` behind the gatekeeper
nginx on the Pi (`rpi`). Today it hosts one tool, **ShrinkPDF**, which
compresses PDFs in the browser: nothing is uploaded.
Status: active. Current as of 2026-11-24.

| Route | Name | Does |
| --- | --- | --- |
| `<prefix>/pdf` | ShrinkPDF | Compress PDFs in the browser, nothing uploaded |

## Quick start

```sh
docker context use rpi
SKIP_BROWSER=1 ./test/prefix.sh   # builds the image, runs it behind a stand-in gateway
```

You should see `58 passed, 0 failed` and `418s in the proxy log (2 deliberate)`.

## Purpose

- **Problem:** compress PDFs (e.g. to fit an email) without sending them to a
  third-party site.
- **People:** owner and maintainer: yasabh. Users: people signed in through
  gatekeeper (the gate is not wired yet, see [Security](#security)).
- **Hard constraints:**
  - No published ports, ever: see [Security](#security).
  - Files never leave the user's machine. The server answers GET only.
  - No npm dependencies, no build step.
- **Rejected options:**
  - Express or Python/Starlette: [ADR 0001](docs/adr/0001-pure-node-no-express.md)
  - Compressing on the server: [ADR 0002](docs/adr/0002-compress-in-the-browser.md)
  - Loading wasm from a CDN or npm at build: [ADR 0003](docs/adr/0003-vendored-wasm.md)
  - Previewing in the browser's own PDF viewer: [ADR 0004](docs/adr/0004-preview-with-pdfjs.md)

## Features

- **In-browser compression:** Ghostscript compiled to WebAssembly, in a pool of
  Web Workers sized to the machine.
- **Presets:** target-quality recipes in `public/presets.js`, shared by the page
  and the worker.
- **Image stats:** per file, how many images were resized and how many left as
  they were.
- **Side-by-side preview:** before and after, rendered by PDF.js with synced
  scroll and zoom.
- **Batch results:** select, download as a zip, or share through the OS share
  sheet where the browser supports it.

## Getting started

Prerequisites:

- Docker with the `rpi` context (`ssh://admin@192.168.100.226`). Node is not
  needed locally; everything runs in containers.
- Nothing publishes a port and nothing is bind-mounted, so every command works
  against the remote context.

```sh
./test/prefix.sh                  # full proof: both prefixes + headless Chromium
SKIP_BROWSER=1 ./test/prefix.sh   # server side only, much quicker
./test/prefix.sh /tools           # proves the prefix is not hardcoded
./test/vendor.sh                  # re-fetch vendored wasm; only to change version
```

`SKIP_BROWSER=1 ./test/prefix.sh` verified 2026-11-24 (58 passed). The full
run with the browser stage: `UNVERIFIED` this session.

`prefix.sh` also runs the `safeNext` unit test (`test/test-next.mjs`) in a
`node:26.13.1-alpine3.24` container. With Node installed locally: `node test/test-next.mjs`
(`UNVERIFIED`, no local Node here).

## Configuration

| Name | Purpose | Default | Where set |
| --- | --- | --- | --- |
| `PORT` | listen port | `8080` | not set; gatekeeper expects 8080 |
| `TZ` | container timezone | UTC | `docker-compose.yml`: `Europe/Budapest` |
| `MAX_BODY_BYTES` | body cap for non-GET requests | 100 MB | not set |

No secrets. `MAX_FILES` (20) is a UI limit in `lib/tools/pdf.js`.

## Architecture

```
server.js      the router, in the order a request meets things:
               prefix → cross-site check → body size → gate → static → routes
lib/
  prefix.js    X-Forwarded-Prefix in, url() out; read before adding any URL
  links.js     safeNext(); pure, no imports, unit-tested on its own
  csrf.js      fetch-metadata check + double-submit token
  limits.js    refuse an oversized body before anything reads it
  static.js    public/ with ETag, 304 and Range; caching per path
  gate.js      the auth gate, deliberately empty; its contract is in the comment
  registry.js  the tool list the sidebar and routes are built from
  render.js    the only way to render a page, so nothing loses the prefix
  tools/pdf.js ShrinkPDF: a description of a page, nothing else
templates/     base.html is the sidebar + header; one fragment per tool
public/        page JS and CSS; vendor/ holds Ghostscript-WASM and PDF.js
test/          prefix.sh (end-to-end), browser-test.mjs, test-next.mjs,
               nginx.conf (gatekeeper's block), vendor.sh
docs/          design.md, adr/, lessons.md
```

**Adding a tool:** write `lib/tools/<id>.js` exporting a `TOOL`, add a template
fragment, list it in `lib/registry.js`. Sidebar, route and `<h1>` come from that
entry. A new folder also needs a `COPY` line in the `Dockerfile`.

Design detail (worker pool, preview, image counting, page behaviour):
[docs/design.md](docs/design.md).

## Deployment and operations

| Environment | Where | URL path |
| --- | --- | --- |
| prod | docker context `rpi`, network `edge` | `/toolshed/` via gatekeeper |

```sh
docker context use rpi
docker compose up -d --build      # deploy
docker compose logs -f toolshed   # logs
docker compose restart toolshed   # restart
```

- **Health:** `GET /healthz` returns `{"ok":true}`; the Dockerfile
  `HEALTHCHECK` uses it.
- **Rollback:** check out the previous commit and run `docker compose up -d --build`
  again. Images are not versioned (`toolshed:latest`). `UNVERIFIED`.
- **Gatekeeper side:** the nginx block lives in the gatekeeper repo;
  `test/nginx.conf` is the copy the tests run. See
  [docs/design.md](docs/design.md#the-gatekeeper-side).

> [!WARNING]
> Never add `ports:` to `docker-compose.yml`. See [Security](#security).

## Security

- **Access contract:** service `toolshed` on the external `edge` network,
  `:8080` plain HTTP (TLS ends at the gateway), prefix already stripped,
  URLs built from `X-Forwarded-Prefix`, HTML ends with `</body>` for the
  gateway's badge.
- **No published ports.** `X-Auth-User` and Content-Length can be trusted only
  because nginx overwrites them on every hop. Publish a port and anyone on the
  LAN can set them.
- **No uploads.** Tools answer GET/HEAD only; anything else is a 405.
- **Defence kept for future tools:** cross-site requests are refused
  (`Sec-Fetch-Site`/`Origin`) and oversized bodies refused before reading;
  pages carry a double-submit CSRF token.
- **`next=` validation:** `safeNext()` in `lib/links.js` refuses control
  characters and normalises like a browser before testing, so `//evil.com`,
  `/\evil.com` and `" //evil.com"` fail. `test/test-next.mjs` covers each.
- **Authorisation** will come from a call to `auth`, never from a header. The
  gate is not wired yet; its contract is in `lib/gate.js`.
- **Container:** runs as `node` (uid 1000, asserted by `test/prefix.sh`),
  `no-new-privileges`, code root-owned and read-only to the process,
  `pids_limit: 128`, `cpus: 1.0`. No `mem_limit`: the Pi ignores it
  ([L-004](docs/lessons.md#l-004--2026-08-11--platform--mem_limit-is-silently-discarded-on-the-pi)).
- **Responses:** pages are `no-store`, with `nosniff`, `no-referrer`,
  `X-Frame-Options: DENY`. Errors never include a stack.
- **Licences:** Ghostscript is AGPL-3.0, PDF.js Apache-2.0; both ship in
  `public/vendor/` and are linked from the page.

## Maintenance

- **Owner:** yasabh.
- **Tests:** `./test/prefix.sh` before every deploy.
- **Dependencies:** none from npm. Base image `node:26.13.1-alpine3.24` (Node 26
  LTS, EOL 2029-04-30, same as tvremotehub), pinned exactly; test images too;
  vendored wasm updated by hand with `test/vendor.sh`, checksums in
  `public/vendor/VENDOR.txt`.
- **Conventions:** short commit messages, no `Co-Authored-By` trailer. Comments
  explain why, not what. `TZ` is `Europe/Budapest`: the deployment is in
  Hungary.
- **Decisions:** [docs/adr/](docs/adr/). **Lessons:** [docs/lessons.md](docs/lessons.md).

## Performance

- Engine: 15.4 MB wasm, fetched when a file is picked, cached by the browser
  (ETag), served with Range so a broken download resumes.
- Worker pool: `min(80% of cores, deviceMemory × 0.4 ÷ 512 MB, files)`. One
  file uses one core: `pdfwrite` is single-threaded. Detail in
  [docs/design.md](docs/design.md#worker-pool).
- Image: ~270 MB, of which ~250 MB is the `node:26.13.1-alpine3.24` base
  (2026-11-24, `docker image ls`). Alternatives were measured; see
  [ADR 0001](docs/adr/0001-pure-node-no-express.md).

## Open questions

- **Gate:** when will `lib/gate.js` be wired to `auth`? Until then `/toolshed/`
  is ungated at this app (owner: yasabh).
- **Image tag:** version the image instead of `toolshed:latest`, so rollback
  does not need a rebuild?
- **Security scan:** `check-security` has not been run yet.
- **Worker table** in docs/design.md is computed from the formula, not measured
  on real devices.
- **Old images on the Pi:** `toolshed:dbg`, `toolshed:layertest*`,
  `toolshed:wasm`, `toolshed-toolshed:latest` look unused. Safe to remove?
