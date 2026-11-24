# 0001. Pure Node, no dependencies, no Express

Status: accepted
Date: 2026-08-12

## Context

The server renders a few templates and serves static files: six routes, no
request bodies. The first version was Python (Starlette); it was ported in
1b2d1e8 to match tvremotehub's webapp, so the two services read alike.

## Decision

`node:http` only, `node:*-alpine` base, no `package.json` dependencies, no
build step, no bundler. Static serving is hand-written in `lib/static.js`.

## Consequences

- No supply chain to audit; alpine is safe because nothing native is compiled.
- `lib/static.js` must cover what Express would: correct MIME
  (`application/wasm`, or the browser cannot stream-compile), ETag/304, and
  Range so an interrupted 15.4 MB download resumes. `test/prefix.sh` asserts
  these.
- Express would cost ~30 transitive packages for that one benefit.
- The image carries the full Node runtime. Base sizes measured 2026-11-24
  (x86, `docker image ls`, without the app's ~18 MB):

  | Base | Size | Node | Kept? |
  | --- | --- | --- | --- |
  | `node:26.13.1-alpine3.24` | 252 MB | 26.13.1 | **chosen**: exact pin, base shared with tvremotehub on the Pi |
  | `alpine:3.22` + node binary copied in | 215 MB | 26.13.1 | saves 37 MB, needs `libstdc++ libatomic` |
  | `alpine:3.22` + `apk add nodejs` | 114 MB | 22.23.5 | smallest, but Node follows Alpine's release; no exact pin |

  Rewriting in Go (~30 MB image) was considered and rejected: a rewrite and a
  second stack beside tvremotehub, to save ~240 MB of disk.
