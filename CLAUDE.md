# CLAUDE.md

toolshed: a pure-Node shell for small web tools behind gatekeeper; today only
ShrinkPDF (compresses PDFs in the browser). `README.md` is the real
documentation; if they disagree, README wins on domain facts, this file on tooling.

## Commands

```sh
docker context use rpi                 # the Pi; no local Node needed
SKIP_BROWSER=1 ./test/prefix.sh        # quick: server side, ~58 checks
./test/prefix.sh                       # full: + headless Chromium
docker compose up -d --build           # deploy (ask first)
```

## Rules

- Never add `ports:` or bind mounts; the docker context is a remote Pi and
  `X-Auth-User` is only trustworthy with no published port.
- Every URL the app emits goes through `url()` in `lib/prefix.js`; never
  hardcode `/toolshed`.
- Tools are GET-only; nothing is uploaded. Don't add a server-side file path.
- No npm dependencies, no build step (docs/adr/0001).
- A new top-level folder needs its own `COPY` line in `Dockerfile`; never `COPY . .`.
- The `:root` tokens and `@font-face` in `public/style.css` are gatekeeper's
  (`auth/static/login.css`): keep them in step. The `theme` key is shared with /tvs.
- New tool: `lib/tools/<id>.js` + template fragment + entry in `lib/registry.js`.
- Comments explain why, not what. Commit messages short, no `Co-Authored-By`.

## Learned the hard way

- Never set `-dJPEGQ`; JPEG quality is a QFactor in distiller params. (L-001)
- `ColorImageResolution` only acts above 1.5× unless `DownsampleThreshold` is set. (L-002)
- Don't add `mem_limit`; the Pi's kernel discards it. (L-004)

## Ask before

- Commit or push (only when asked in that message).
- `docker compose up` on `rpi` (it is prod), or removing images there.
- Running `test/vendor.sh` (changes 16 MB of committed files).
