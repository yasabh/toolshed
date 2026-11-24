# Lessons

## L-004 · 2026-08-11 · platform · `mem_limit` is silently discarded on the Pi

**Symptom:** a warning on every `docker compose up`; the memory limit in compose
had no effect.
**Cause:** the Pi's firmware sets `cgroup_disable=memory` on the kernel command
line, so docker cannot enforce a memory limit and drops it.
**Fix:** `mem_limit` removed from `docker-compose.yml`; `cpus` and `pids_limit`
apply and are kept (156f059).
**Prevention:** a comment in `docker-compose.yml` says why it is absent. A
control that is not enforced is worse than none, because it reads like one.
**Rule in CLAUDE.md:** yes

## L-003 · 2026-08-13 · bug · Side-by-side preview drifted apart

**Symptom:** the two panes showed the documents at different sizes, one pane
kept its old zoom, and zooming blanked the pages. Each pane on its own looked
fine.
**Cause:** three separate bugs:
1. A grid column's default minimum is its content, so `1fr 1fr` let a page
   zoomed to 300% widen its own column and squeeze the other.
2. A redraw requested while one was running was dropped, not queued.
3. Resizing a canvas clears it.

**Fix:** `minmax(0, 1fr)`; queue the redraw; draw into a new canvas and swap it
in (1f779d3).
**Prevention:** test a two-pane view with both panes at once, not one by one.
**Rule in CLAUDE.md:** no

## L-002 · 2026-08-11 · platform · `-dColorImageResolution` is not a cutoff

**Symptom:** a 250 dpi scan passed through a "200 dpi" preset untouched.
**Cause:** `DownsampleThreshold` defaults to 1.5, so "200 dpi" means "anything
above 300 dpi becomes 200". Measured here, not taken from documentation.
**Fix:** Email sets the threshold to 1.0 so the number means what the label
says; Print keeps the default on purpose, because resampling 350 → 300 dpi costs
quality and saves little. See `public/presets.js` (156f059).
**Prevention:** presets live in one file, shared by the page and the worker.
**Rule in CLAUDE.md:** yes

## L-001 · 2026-08-11 · platform · `-dJPEGQ` does nothing in pdfwrite

**Symptom:** `-dJPEGQ=10` and `-dJPEGQ=95` produced byte-identical output.
**Cause:** pdfwrite ignores it. JPEG quality is set through distiller
parameters as a **QFactor**, where lower is better: 0.1 maximum, 0.4 high, 0.76
medium, 1.3 low.
**Fix:** presets use QFactor (156f059).
**Prevention:** any recipe that sets `-dJPEGQ` is wrong; compare output bytes
when changing a preset.
**Rule in CLAUDE.md:** yes
