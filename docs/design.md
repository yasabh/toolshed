# Design notes

Why ShrinkPDF behaves the way it does. Moved out of the README on 2026-11-24;
decisions with alternatives are in [adr/](adr/), failures in
[lessons.md](lessons.md).

## The gatekeeper side

A change in the **gatekeeper** repo, not this one. `test/nginx.conf` is the
same block, and is what the test harness actually runs:

```nginx
location = /toolshed { return 302 /toolshed/; }

location /toolshed/ {
    # sub_filter reads the body, so it must arrive uncompressed.
    proxy_set_header Accept-Encoding "";
    sub_filter_types text/html;
    sub_filter_once on;
    sub_filter "</body>" "$whoami_tag</body>";

    # A variable host forces per-request DNS re-resolution, which disables
    # nginx's automatic prefix replacement — a trailing slash does NOT strip
    # the prefix here. Strip it explicitly, before proxy_pass.
    set $toolshed toolshed;
    rewrite ^/toolshed/(.*)$ /$1 break;
    proxy_pass http://$toolshed:8080;

    proxy_set_header Host               $host;
    proxy_set_header X-Real-IP          $remote_addr;
    proxy_set_header X-Forwarded-For    $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto  $scheme;
    proxy_set_header X-Forwarded-Prefix /toolshed;  # how this app builds URLs
    proxy_set_header X-Auth-User        "";         # ungated for now
}
```

Unlike `/tvs/`, this app needs **no** catch-all `location /`. Nothing it emits
is unprefixed, and `test/prefix.sh` is what says so. The stand-in gateway in the
test answers **418** on `location /`: on the real one that namespace is
tv-webui's catch-all, so a leaked unprefixed request would not 404, it would
quietly land somewhere else. "2 deliberate 418s in the log" at the end of a run
is how it says nothing leaked.

## URLs

The gateway strips the prefix, so the app routes on the unprefixed path and
puts the prefix back on everything it emits, via `url()` in `lib/prefix.js`,
built from `X-Forwarded-Prefix`. Nothing in the app knows the string
`/toolshed`; `./test/prefix.sh /tools` still passes.

## Counting images without asking Ghostscript

`public/pdf-images.js` reads image dictionaries straight out of the PDF, before
and after, so the result row can say *"12 images · 9 resized, 3 left as they
were"*. It works because an object with a stream may not live inside an object
stream, and every image XObject has one, so image dictionaries are always
top-level and in plain text, even in a compressed PDF 1.6.

`-dPDFDEBUG` contains the same information but costs a JS callback per line of a
dump of every object. On a thousand-image brochure that is more expensive than
the compression itself.

The *reason* an image was left alone is deliberately not claimed. That depends on
its effective dpi, which needs the transformation matrix from the page's content
stream. Reading it means interpreting the drawing program: a different project.

## Worker pool

Files run in parallel across a worker pool sized to the machine. **Two
ceilings, the lower one wins:**

| | |
| --- | --- |
| CPU | `floor(hardwareConcurrency × 0.8)` |
| Memory | `floor(deviceMemory × 0.4 ÷ 512 MB)` |
| Work | never more workers than files |

Every worker holds its own Ghostscript instance plus a PDF in and a PDF out;
memory is what kills a tab. Browsers clamp `deviceMemory` at 8, and Firefox and
Safari do not expose it at all.

Resulting workers, computed from the formula above (not measured):

| machine | workers |
| --- | --- |
| 2 cores / 2 GB | 1 |
| 4 cores / 4 GB | 3 |
| 8 cores / 4 GB (phone) | 3 |
| 8 cores / 8 GB | 6 |
| 16 cores, clamped to 8 GB | 6 |

- Capped so a background tab never takes the whole CPU.
- Work is handed out on demand, not dealt up front: PDFs differ wildly in time.
- The 15.4 MB module is compiled **once** on the main thread and the
  `WebAssembly.Module` posted to every worker. Workers are terminated after each
  batch; the compiled module is kept.
- **One file uses one core, and that is not a bug.** `pdfwrite` is
  single-threaded. Splitting by page range and merging would duplicate every
  shared image, so the output would grow.

## The first run is network, not CPU

The engine is fetched **when a file is picked**, not when Compress is clicked,
so the 15.4 MB download overlaps the time spent choosing a quality. Not on page
load: someone who opens the page only to read it should not pay for it.

## The preview

Rendered by **PDF.js**, loaded only when a preview is first opened. It shares no
code with Ghostscript, so it is still a second opinion on the output. Why not the
browser's own viewer: [ADR 0004](adr/0004-preview-with-pdfjs.md). Bugs found on
the way: [L-003](lessons.md#l-003--2026-08-13--bug--side-by-side-preview-drifted-apart).

## Page behaviour

- **Dropping** is handled on the `window`, not only on the dashed box. The
  browser's default for an unhandled drop is to navigate to the file, which
  throws away everything already picked. The whole page outlines while a file
  is over it.
- **Closing the tab** throws results away; that is the design. The
  `beforeunload` listener is registered only while a batch runs or a result has
  not been downloaded, because a page that always asks is one people learn to
  click past. Taking a copy (Download, zip, or a share sheet that resolved)
  clears that file.
- **Selecting:** finished rows start ticked; a row still compressing has a
  *disabled* checkbox rather than none; "Select all" goes indeterminate; counts
  live in the buttons (*Download 3*); one file downloads as a PDF, not a zip.
- **Email** uses `navigator.share({files})`, the OS share sheet. `mailto:` cannot
  carry attachments, and sending from a server would make "nothing is uploaded"
  a lie. Where `share` is missing (desktop Firefox, most Linux) the button is
  not rendered at all.
- **Multiple files:** each file gets its own row and its own run, so the first
  result appears early and one bad file does not take the others down.

## The visual language is shared, not owned

The `:root` token block at the top of `public/style.css`, the `theme`
localStorage key and the `.theme-toggle` markup are **tv-webui's, verbatim**.
`/tvs`, `/login` and this app share them, so a theme picked in one shows
everywhere. Do not tidy them.

From the login page: **labels above fields**, not placeholders; a **3px focus
ring** rather than a border-colour shift; **no entry animation** on anything
re-rendered after an error.

## Identity, when the gate is wired

Sessions belong entirely to `auth`: web sign-ins last until the coming Saturday
00:00 Europe/Budapest, WiFi identity is re-derived per request. This app stores
no session of its own and **must not cache the answer**. The contract is in the
header comment of `lib/gate.js`.
