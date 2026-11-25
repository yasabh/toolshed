// ShrinkPDF's page. Compression happens here, on this machine, in a worker —
// see gs-worker.js. Nothing is uploaded, which is why the page is allowed to say
// so.
//
// Files are compressed in parallel across a small pool of workers, capped at
// 70% of the machine's cores — see runPool below for why it is capped rather
// than maximised.
import { notice, humanBytes } from "./app.js";
import { PRESETS, DEFAULT_PRESET, presetById } from "./presets.js";
import { makeZip } from "./zip.js";
import { renderDocument, rescale, destroy } from "./preview.js";

const form = document.getElementById("shrink");
const input = document.getElementById("file");
const drop = document.getElementById("drop");
const dropIdle = document.getElementById("dropIdle");
const dropMore = document.getElementById("dropMore");
const qualityNote = document.getElementById("qualityNote");
const list = document.getElementById("fileList");
const filesMeta = document.getElementById("filesMeta");
const filesEmpty = document.getElementById("filesEmpty");
const clearPicks = document.getElementById("clearPicks");
const rowTemplate = document.getElementById("rowTemplate");
const resultsBar = document.getElementById("resultsBar");
const total = document.getElementById("resultsTotal");
const selectAll = document.getElementById("selectAll");
const resultsCount = document.getElementById("resultsCount");
const downloadSelected = document.getElementById("downloadSelected");
const shareSelected = document.getElementById("shareSelected");
const viewer = document.getElementById("viewer");
const viewerName = document.getElementById("viewerName");
const viewerBefore = document.getElementById("viewerBefore");
const viewerAfter = document.getElementById("viewerAfter");
const viewerQuality = document.getElementById("viewerQuality");
const whichBefore = document.getElementById("whichBefore");
const whichAfter = document.getElementById("whichAfter");
const viewerA = document.getElementById("viewerA");
const viewerB = document.getElementById("viewerB");
const scrollA = document.getElementById("scrollA");
const scrollB = document.getElementById("scrollB");
const go = document.getElementById("go");
const choices = document.getElementById("choices");
const maxBytes = Number(form.dataset.maxBytes);
const maxFiles = Number(form.dataset.maxFiles);

/* `picked` is the source of truth, not input.files: a FileList is read-only, so
   removing one file means rebuilding the list and assigning it back. Each file
   keeps one row for as long as it is picked, and at most one result. */
let picked = [];
const rows = new Map();     // File -> <li>
const fileOf = new WeakMap(); // <li> -> File, for the list's one click handler
const results = new Map();  // File -> { name, bytes, file, preset, url, row, saved }
// Declared here, with the rest of the state, rather than beside the code that
// uses it: renderFiles() runs while this module is still evaluating, and a `let`
// read before its declaration throws rather than reading undefined.
let compressing = false;

/* ---- The worker pool -----------------------------------------------------
   One worker is one core, which on an eight-core machine is twelve percent of
   the CPU while the user waits. The pool runs several files at once instead,
   sized to the machine it is actually running on.

   Two ceilings, and the lower one wins. Cores decide how much work can happen at
   once; **memory decides how much may be resident**, because every worker holds
   its own Ghostscript instance and a PDF, and that is what kills a tab. A phone
   with eight cores and 4 GB is bounded by the second, not the first. */
const CORES = navigator.hardwareConcurrency || 4;
const CPU_SHARE = 0.8;

// What one worker costs while it runs: a Ghostscript instance plus the file in
// and the file out. A ceiling rather than a measurement — an instance grows to
// fit the PDF it was given, and this has to hold for the worst one in a batch.
const WORKER_MB = 512;
// How much of the machine's memory this page may plan around. The rest belongs
// to the browser itself and to everything else the user has open.
const MEMORY_SHARE = 0.4;

function poolSize(fileCount) {
  const byCpu = Math.floor(CORES * CPU_SHARE);

  // deviceMemory is coarse (0.25 / 0.5 / 1 / 2 / 4 / 8) and browsers clamp it at
  // 8 whatever the machine really has, to make it useless for fingerprinting —
  // so a 64 GB workstation and a 16 GB laptop both say 8, and this stays
  // conservative on both. Absent on Firefox and Safari, where assuming a modest
  // laptop is the safe reading.
  const gb = navigator.deviceMemory || 4;
  const byMemory = Math.floor((gb * 1024 * MEMORY_SHARE) / WORKER_MB);

  // Never more workers than there is work: a fourth worker for a third file only
  // pays the startup cost.
  return Math.max(1, Math.min(byCpu, byMemory, fileCount));
}

// The compiled module, fetched and compiled once for the life of the page and
// handed to every worker after that. Workers themselves are per batch: keeping
// four Ghostscript instances resident between uploads would cost far more
// memory than re-spawning costs time.
let compiledModule = null;

async function getModule() {
  if (!compiledModule) {
    const url = new URL("./vendor/gs.wasm", import.meta.url);
    compiledModule = await WebAssembly.compileStreaming(fetch(url));
  }
  return compiledModule;
}

/**
 * Start fetching and compiling the engine as soon as a file is picked, rather
 * than when Compress is clicked.
 *
 * It is 15.4 MB. Left until the click, that download is the first thing that
 * happens after it — seconds of waiting on the network, during which nothing is
 * computing and the CPU sits idle, which is exactly what "slow but nothing is
 * happening" looks like. Picking a file, reading the quality options and moving
 * to the button is time that was being wasted; this spends it on the download.
 *
 * Still not on page load: someone who opens the page to read it should not pay
 * 15.4 MB for the privilege. Errors are swallowed because this is speculative —
 * the real attempt in runPool() reports them.
 */
let prefetching = null;
function prefetchEngine() {
  if (!prefetching) prefetching = getModule().catch(() => { compiledModule = null; });
  return prefetching;
}

/** One worker, doing one file at a time. */
function spawn(module) {
  const worker = new Worker(new URL("./gs-worker.js", import.meta.url),
                            { type: "module" });
  let pending = null;
  let nextId = 0;

  try {
    worker.postMessage({ type: "module", module });
  } catch {
    // Structured-cloning a WebAssembly.Module is not universal; the worker
    // compiles its own copy when it never arrives.
  }

  worker.addEventListener("message", ({ data }) => {
    if (!pending || data.id !== pending.id) return;
    const { resolve, reject } = pending;
    pending = null;
    data.ok ? resolve({ out: new Uint8Array(data.bytes), images: data.images })
            : reject(new Error(data.error));
  });
  worker.addEventListener("error", (event) => {
    // A worker that dies must fail the job it was holding, or that file waits
    // for a reply that can never come.
    if (pending) pending.reject(new Error(event.message || "The compressor stopped."));
    pending = null;
  });

  return {
    run(bytes, preset) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending = { id, resolve, reject };
        // Transferred, not copied: each file is read fresh from disk, so there
        // is nothing to lose by giving the buffer away.
        worker.postMessage({ id, bytes: bytes.buffer, preset }, [bytes.buffer]);
      });
    },
    stop: () => worker.terminate(),
  };
}

/**
 * Run every file through a pool, calling `onStart` as each is picked up and
 * `onDone` as each finishes.
 *
 * `onStart` is not decoration: with three workers, three files are being worked
 * on at once, and without it every row reads "Queued" until it flips straight to
 * a result. The queue would look stuck while the machine was at full tilt.
 *
 * Files are handed out on demand rather than dealt evenly up front: PDFs differ
 * wildly in how long they take, and a worker that drew three quick ones should
 * pick up a fourth rather than idle beside one still grinding.
 */
async function runPool(files, preset, onStart, onDone) {
  const module = await getModule();
  const workers = Array.from({ length: poolSize(files.length) },
                             () => spawn(module));
  let next = 0;
  try {
    await Promise.all(workers.map(async (worker) => {
      while (true) {
        const index = next++;
        if (index >= files.length) return;
        const file = files[index];
        onStart(index);
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          if (bytes[0] !== 0x25 || bytes[1] !== 0x50) { // "%P"
            throw new Error("That does not look like a PDF.");
          }
          onDone(index, await worker.run(bytes, preset.id), null);
        } catch (err) {
          onDone(index, null, err);
        }
      }
    }));
  } finally {
    for (const worker of workers) worker.stop();
  }
}

/* ---- The target-quality picker --------------------------------------------
   Built from presets.js rather than written into the template, so adding a
   preset is one entry in one file. */
function drawChoices() {
  for (const preset of PRESETS) {
    const label = document.createElement("label");
    label.className = "choice";
    label.innerHTML =
      `<input type="radio" name="quality" value="${preset.id}"` +
      `${preset.id === DEFAULT_PRESET ? " checked" : ""}>` +
      `<span class="choice-body"><span class="choice-name"></span>` +
      `<span class="choice-desc"></span>` +
      `<span class="choice-detail"></span></span>`;
    // textContent, not innerHTML: these strings come from a file today, but a
    // preset is exactly the kind of thing someone pastes into later.
    label.querySelector(".choice-name").textContent = preset.name;
    label.querySelector(".choice-desc").textContent = preset.blurb;
    label.querySelector(".choice-detail").textContent = preset.detail;
    choices.append(label);
  }
}
drawChoices();
choices.addEventListener("change", () => {
  syncQualityNote();
  syncCompressButton();
});

/** The phone's one-line description of the chosen preset: its blurb and dpi. */
function syncQualityNote() {
  const preset = chosenPreset();
  qualityNote.textContent = `${preset.blurb} ${preset.detail.split(" · ")[0]}`;
}
syncQualityNote();

function chosenPreset() {
  const picked = choices.querySelector("input[name=quality]:checked");
  return presetById(picked ? picked.value : DEFAULT_PRESET);
}

/* ---- What has already been compressed -------------------------------------
   Keyed on the file's **content hash and the preset**, not the file alone. The
   same PDF at Email and at Print are different outputs, so switching the picker
   has to mean real work again — reusing an Email result for a Print request
   would hand back the wrong file with no way to tell.

   Content, not name+size+date: a file edited and saved between two runs keeps
   its name and often its size, and reusing the old result there would be worse
   than the recompression it saved. */
const hashes = new Map();   // File -> hex digest
const done = new Map();     // `${digest}:${presetId}` -> { name, bytes, images }

const resultKey = (file, preset) => `${hashes.get(file)}:${preset.id}`;

async function hashOf(bytes) {
  // SubtleCrypto only exists in a secure context. Behind gatekeeper this is
  // always HTTPS, but on plain HTTP — which is how the test harness reaches the
  // app — it is simply absent, and a feature that silently stops working
  // outside production is a feature that is never really tested.
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  // FNV-1a, 32 bits at a time into two lanes. Not a cryptographic hash and not
  // pretending to be: this only decides whether to skip work the user can redo
  // by removing the file, and nothing trusts it.
  let a = 0x811c9dc5, b = 0x01000193;
  for (let i = 0; i < bytes.length; i++) {
    a = Math.imul(a ^ bytes[i], 0x01000193) >>> 0;
    b = Math.imul(b + bytes[i], 0x85ebca6b) >>> 0;
  }
  return `${a.toString(16)}${b.toString(16)}-${bytes.length.toString(16)}`;
}

/* ---- The file list ------------------------------------------------------- */
function syncInput() {
  // A DataTransfer is the only way to construct a FileList.
  const data = new DataTransfer();
  for (const file of picked) data.items.add(file);
  input.files = data.files;
}

const ROW_STATES = ["pending", "queued", "working", "done", "failed"];

function setRowState(row, state, status = "") {
  for (const name of ROW_STATES) row.classList.toggle(name, name === state);
  row.querySelector(".row-status").textContent = status;
}

/** Put a row back to "picked, nothing done yet": its size and its remove button. */
function showPending(file) {
  const row = rows.get(file);
  const tooBig = file.size > maxBytes;
  row.classList.toggle("too-big", tooBig);
  row.classList.remove("selected"); // nothing to select until it has a result
  row.querySelector(".row-size").textContent = humanBytes(file.size);
  row.querySelector(".row-sel").hidden = true;
  row.querySelector(".row-preview").hidden = true;
  row.querySelector(".row-get").hidden = true;
  row.querySelector(".row-drop").hidden = false;
  // Said on the row, beside the file, rather than only in a toast at submit:
  // the row is where the fix (remove it) is.
  setRowState(row, "pending",
    tooBig ? `Over the ${humanBytes(maxBytes)} limit. Remove it to continue.` : "");
}

function newRow(file) {
  const row = rowTemplate.content.firstElementChild.cloneNode(true);
  const name = row.querySelector(".row-name");
  name.textContent = file.name;
  name.title = file.name; // the full name when it is ellipsised
  row.querySelector(".row-drop").setAttribute("aria-label", `Remove ${file.name}`);
  fileOf.set(row, file);
  rows.set(file, row);
  showPending(file);
}

/** Forget a file's result and free its download URL. */
function dropResult(file) {
  const item = results.get(file);
  if (!item) return;
  URL.revokeObjectURL(item.url);
  results.delete(file);
}

function renderFiles() {
  for (const file of picked) if (!rows.has(file)) newRow(file);
  list.replaceChildren(...picked.map((file) => rows.get(file)));

  const count = picked.length;
  const size = picked.reduce((sum, f) => sum + f.size, 0);
  filesEmpty.hidden = count > 0;
  clearPicks.hidden = count === 0;
  filesMeta.textContent = count
    ? `${count} file${count > 1 ? "s" : ""} · ${humanBytes(size)}` : "";
  drop.classList.toggle("has-file", count > 0);
  dropIdle.hidden = count > 0;
  dropMore.hidden = count === 0;
  syncBar();
  syncCompressButton();
}

function removeFiles(gone) {
  for (const file of gone) {
    dropResult(file);
    rows.delete(file);
  }
  picked = picked.filter((file) => !gone.includes(file));
  syncInput();
  renderFiles();
}

/** Files still needing work for the preset currently chosen. */
function workLeft() {
  const preset = chosenPreset();
  return picked.filter((file) => !done.has(resultKey(file, preset)));
}

/**
 * The Compress button says what there is to do.
 *
 * Nothing picked, or everything already done at this quality, and it goes flat:
 * a button that runs a minute of work to produce byte-identical files is a trap,
 * not a convenience. Adding a file or changing the quality gives it something to
 * do again, and it says so.
 */
function syncCompressButton() {
  if (compressing) return; // the running batch owns the label
  const left = workLeft().length;
  go.disabled = left === 0;
  // "files" spelled out: this is the button that starts the work, and it is the
  // one place a bare number would have to be read twice to know what it counts.
  const plural = left === 1 ? "file" : "files";
  go.textContent = picked.length === 0 ? "Compress"
    : left === 0 ? "Compressed"
    : left === picked.length ? `Compress ${left} ${plural}`
    : `Compress ${left} new ${plural}`;
}

async function noteHashes(files) {
  await Promise.all(files.map(async (file) => {
    if (hashes.has(file)) return;
    hashes.set(file, await hashOf(new Uint8Array(await file.arrayBuffer())));
  }));
  syncCompressButton();
}

function addFiles(files) {
  if (files.length) prefetchEngine();
  for (const file of files) {
    // Dropping the same file twice is a slip, not a request to compress it
    // twice. Name and size alone collide across folders; lastModified does not.
    const already = picked.some(
      (p) => p.name === file.name && p.size === file.size &&
             p.lastModified === file.lastModified);
    if (!already) picked.push(file);
  }
  syncInput();
  renderFiles();
  // Hashing reads the whole file, so the list is drawn first and the button
  // settles a moment later rather than the page waiting on disk.
  noteHashes(picked);
}

// The picker adds, like a drop does: once files are listed the box says "Add
// more files", and a picker that silently replaced them would contradict it.
input.addEventListener("change", () => addFiles([...input.files]));
addFiles([...input.files]); // a back/forward navigation can restore a selection

clearPicks.addEventListener("click", () => removeFiles([...picked]));

// One handler for every row's controls: rows outlive a batch, so a listener
// added per result would stack up on each re-run.
list.addEventListener("click", (e) => {
  const row = e.target.closest(".row");
  const file = row && fileOf.get(row);
  if (!file) return;
  if (e.target.closest(".row-drop")) removeFiles([file]);
  else if (e.target.closest(".row-preview")) openPreview(results.get(file));
  else if (e.target.closest(".row-get")) markSaved([results.get(file)]);
});
list.addEventListener("change", (e) => {
  if (e.target.matches(".row-sel")) syncBar();
});

/* Dropping is handled on the window, not only on the dashed box.
   Landing two centimetres outside it is not a mistake worth punishing, and the
   browser's default for an unhandled drop is to *navigate to the file*: the page
   is replaced by the PDF and everything already picked is gone. The box stays as
   the thing to aim at; it is no longer the only thing that catches. */
let dragDepth = 0; // dragenter/leave fire per element, so a counter, not a flag

const overWindow = (on) => {
  document.body.classList.toggle("dragging", on);
  drop.classList.toggle("drag", on);
};

for (const type of ["dragenter", "dragover"]) {
  window.addEventListener(type, (e) => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();                    // this is what claims the drop
    e.dataTransfer.dropEffect = compressing ? "none" : "copy";
    if (compressing) return;               // no highlight for a refused drop
    if (type === "dragenter") dragDepth++;
    overWindow(true);
  });
}
window.addEventListener("dragleave", () => {
  if (--dragDepth > 0) return;
  dragDepth = 0;
  overWindow(false);
});
window.addEventListener("drop", (e) => {
  // Always claimed, even mid-run: the default for an unhandled drop is to
  // navigate to the file, which would replace the page and throw away a batch
  // that is halfway through. Refusing to *take* the file is separate from
  // refusing to let the browser act on it.
  e.preventDefault();
  dragDepth = 0;
  overWindow(false);
  if (compressing) {
    notice("Still compressing — wait for this batch to finish.", "error");
    return;
  }
  const dropped = [...(e.dataTransfer?.files || [])];
  // A dropped folder arrives with no type and no extension; taking it would add
  // a row that can never compress.
  const pdfs = dropped.filter((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
  if (pdfs.length) addFiles(pdfs);
  else if (dropped.length) notice("Only PDFs can be compressed.", "error");
});

/**
 * Freeze the inputs while a batch runs.
 *
 * Not cosmetic. Removing a file mid-run would pull a row out from under the
 * worker filling it in, and changing the quality would be worse: the preset is
 * read once at the start, so the picker would say Print while Email was still
 * being produced.
 *
 * `inert` rather than `disabled` on the settings: it takes the whole subtree out
 * of pointer events, tab order and the accessibility tree in one attribute, and
 * it leaves the Compress button — which is outside these — free to keep
 * announcing progress. The list itself stays live so finished rows can be
 * previewed mid-run; only its remove buttons are switched off.
 */
function lockForm(locked) {
  for (const part of form.querySelectorAll(".field")) part.inert = locked;
  clearPicks.disabled = locked;
  for (const button of list.querySelectorAll(".row-drop")) button.disabled = locked;
  form.classList.toggle("busy", locked);
}

/* ---- Compress ------------------------------------------------------------- */
form.addEventListener("submit", async (e) => {
  // Always: there is no server endpoint behind this form to fall back to.
  e.preventDefault();
  if (!picked.length) return;

  if (picked.length > maxFiles) {
    notice(`That is more than ${maxFiles} files at once.`, "error");
    return;
  }
  const tooBig = picked.find((f) => f.size > maxBytes);
  if (tooBig) {
    notice(`${tooBig.name} is larger than the ${humanBytes(maxBytes)} limit.`, "error");
    return;
  }

  go.disabled = true;
  compressing = true;
  lockForm(true);
  syncUnloadWarning();
  // Read once, up front: changing the picker halfway through a batch must not
  // give half the files one quality and half another.
  const preset = chosenPreset();
  const files = [...picked];

  let failed = 0, finishedCount = 0;
  const progress = () => {
    go.textContent = files.length > 1
      ? `Compressing… ${finishedCount}/${files.length}` : "Compressing…";
  };

  // Anything already compressed at this quality is placed straight away. The
  // work was done once; doing it again would produce the same bytes and cost the
  // same minute.
  const todo = [];
  for (const file of files) {
    const cached = done.get(resultKey(file, preset));
    if (cached) {
      placeResult(file, cached, preset, true);
      finishedCount++;
    } else {
      dropResult(file);
      showPending(file);
      setRowState(rows.get(file), "queued", "Queued…");
      todo.push(file);
    }
  }
  syncBar();
  progress();

  await runPool(todo, preset, (i) => {
    setRowState(rows.get(todo[i]), "working", "Compressing…");
  }, (i, result, err) => {
    finishedCount++;
    const file = todo[i];
    if (err) {
      failed++;
      setRowState(rows.get(file), "failed", err.message);
    } else {
      const output = { bytes: result.out, images: result.images };
      done.set(resultKey(file, preset), output);
      placeResult(file, output, preset, false);
    }
    syncBar();
    progress();
  });

  compressing = false;
  lockForm(false);
  reportFailures(files.length - failed, failed);
  // Last, so it reads the results this run just added: with nothing left to do
  // it settles on "Compressed" and goes flat.
  syncCompressButton();
});

/* ---- Losing work ----------------------------------------------------------
   Results live in this page and nowhere else — that is the whole design — so
   closing the tab throws them away. The browser will ask first, but only about
   work that is actually at risk.

   The listener is added and removed rather than left in place: a page that
   always asks is a page people learn to click through, and browsers ignore the
   prompt anyway unless the user has interacted with the page. */
// Function declarations, not arrow consts: the list is first drawn while this
// module is still evaluating, before a const further down would exist.

/** Every result, in the order the rows are listed. */
function finished() {
  return picked.map((file) => results.get(file)).filter(Boolean);
}

function unsaved() {
  return finished().filter((item) => !item.saved).length;
}

function warnBeforeUnload(event) {
  // preventDefault is the modern spelling; returnValue is what older browsers
  // still read. Neither lets us choose the wording — that text is the browser's.
  event.preventDefault();
  event.returnValue = "";
}

function syncUnloadWarning() {
  const atRisk = compressing || unsaved() > 0;
  window.removeEventListener("beforeunload", warnBeforeUnload);
  if (atRisk) window.addEventListener("beforeunload", warnBeforeUnload);
}

/** Marks results the user has actually taken a copy of. */
function markSaved(items) {
  for (const item of items) item.saved = true;
  syncBar();
}

/* ---- Selection ------------------------------------------------------------
   Everything that finishes starts ticked: the common case is "all of them", and
   unticking two is less work than ticking eighteen. */
function selected() {
  return finished().filter((item) => item.row.querySelector(".row-sel").checked);
}

// Sharing a file needs a File, not a Blob — the name is what the mail client
// attaches it as.
const asFile = (item) =>
  new File([item.bytes], item.name, { type: "application/pdf" });

/** "−77%", or "no smaller" — Ghostscript can make a file bigger, and a
    negative saving would read as a typo. */
function savingText(before, after) {
  const saved = before ? Math.round((1 - after / before) * 100) : 0;
  return saved > 0 ? `\u2212${saved}%` : "no smaller";
}

/** The bar above the list: what is selected, and what the job saved overall. */
function syncBar() {
  const items = finished();
  const chosen = selected();

  for (const item of items) {
    item.row.classList.toggle("selected", item.row.querySelector(".row-sel").checked);
  }

  // Indeterminate at "some", so the header never claims more than is true.
  selectAll.checked = chosen.length > 0 && chosen.length === items.length;
  selectAll.indeterminate = chosen.length > 0 && chosen.length < items.length;
  selectAll.disabled = items.length === 0;

  resultsBar.hidden = items.length === 0;
  resultsCount.textContent = items.length
    ? `${chosen.length} of ${items.length} selected` : "";

  // Worked out from the rows on screen rather than kept as a batch total, so it
  // stays true when a file is removed or re-run. A fact about the results, not
  // an event, so it is written here and not raised as a toast.
  const before = items.reduce((sum, item) => sum + item.file.size, 0);
  const after = items.reduce((sum, item) => sum + item.bytes.length, 0);
  if (before && after < before) {
    const saving = document.createElement("b");
    saving.textContent = `${Math.round((1 - after / before) * 100)}% smaller`;
    total.replaceChildren(saving,
      ` overall · ${humanBytes(before)} \u2192 ${humanBytes(after)}`);
  } else {
    total.replaceChildren();
  }

  // No visible counter: the browser's own confirmation on the way out is the
  // warning, and a running tally beside it was saying the same thing twice.
  syncUnloadWarning();

  // No counts here: the bar already says "3 of 4 selected" beside them. "(zip)"
  // stays — that is not a count, it is what will land in the downloads folder.
  downloadSelected.disabled = chosen.length === 0;
  downloadSelected.querySelector("span").textContent =
    chosen.length > 1 ? "Download (zip)" : "Download";
  shareSelected.disabled = chosen.length === 0;
}

selectAll.addEventListener("change", () => {
  for (const item of finished()) {
    item.row.querySelector(".row-sel").checked = selectAll.checked;
  }
  syncBar();
});

downloadSelected.addEventListener("click", () => {
  const picked = selected();
  if (!picked.length) return;
  // One file is not an archive. Zipping it would make the user unzip something
  // to get back exactly what they already had.
  //
  // Inside the zip the files keep their **original** names, so extracting them
  // drops straight over the originals. A single download keeps the suffixed name
  // instead: it lands in the downloads folder beside the file it came from, and
  // two files called brochure.pdf there is how the wrong one gets attached.
  const blob = picked.length === 1
    ? new Blob([picked[0].bytes], { type: "application/pdf" })
    : makeZip(picked.map((item) => ({ name: item.file.name, bytes: item.bytes })));

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = picked.length === 1 ? picked[0].name : "compressed-pdfs.zip";
  link.click();
  markSaved(picked);
  // Revoked on the next frame, not immediately: the click has to be dispatched
  // before the URL stops resolving.
  requestAnimationFrame(() => URL.revokeObjectURL(url));
});

shareSelected.addEventListener("click", async () => {
  const picked = selected();
  if (!picked.length) return;
  const files = picked.map(asFile);
  // Re-checked with the real files: canShare can refuse a specific set (too
  // large, wrong type) even when it accepted the capability probe.
  if (!navigator.canShare?.({ files })) {
    notice("This device will not share these files. Download them instead.", "error");
    return;
  }
  try {
    await navigator.share({ files, title: "Compressed PDFs" });
    // Only after it resolves: a share sheet the user closed took no copy.
    markSaved(picked);
  } catch (err) {
    // A user closing the share sheet is not a failure worth a toast.
    if (err?.name !== "AbortError") notice("Could not open the share sheet.", "error");
  }
});

// The share sheet is the only way to hand a file to another app without
// uploading it: mailto: cannot carry an attachment, in any browser, so there is
// nothing to fall back to. Where the sheet is missing the button is not shown at
// all, rather than shown and then failing. Probed with a real File because
// Firefox implements canShare but refuses files to it.
if (navigator.canShare?.({ files: [new File([new Uint8Array(1)], "a.pdf", { type: "application/pdf" })] })) {
  shareSelected.hidden = false;
}

/* ---- Preview --------------------------------------------------------------
   Both files side by side, rendered by PDF.js.

   The browser's own viewer was tried first and had to be abandoned: it is a
   separate, cross-origin document, so its scroll position can be neither read
   nor set and the two panes could never be kept together. Owning the renderer is
   the only way to own the scrolling — which is the same conclusion every project
   that does this has reached.

   What is kept is the second opinion: PDF.js is Mozilla's engine and shares no
   code with the Ghostscript that produced the file, so a difference on screen is
   still a difference in the documents. What is lost is that it is not this
   user's own viewer. */
let previewDocs = { a: null, b: null };
let currentZoom = "fit";

const ZOOMS = { fit: null, 150: 1.5, 200: 2, 300: 3, 400: 4, 500: 5 };

/** "Fit" is a scale, not a mode: whatever makes the first page fill the pane. */
function fitScale(state, pane) {
  const [first] = state.pages;
  if (!first) return 1;
  const natural = first.page.getViewport({ scale: 1 }).width;
  // A little room so the page is not flush against the pane's edges.
  return Math.max(0.1, (pane.clientWidth - 24) / natural);
}

async function openPreview(item) {
  closePreview();
  viewerName.textContent = item.file.name;
  viewerBefore.textContent = humanBytes(item.file.size);
  // Size and saving together: the heading is where the two panes are compared,
  // so the number that says how much came off belongs beside the one it came
  // off. Italic rather than brackets for the recipe — a preset can carry its own
  // brackets ("Print (Brochure)") and nesting them reads as a typo.
  viewerAfter.textContent =
    `${humanBytes(item.bytes.length)} ${savingText(item.file.size, item.bytes.length)}`;
  viewerQuality.textContent = item.preset ? `${item.preset} quality` : "";
  whichBefore.textContent = viewerBefore.textContent;
  whichAfter.textContent = viewerAfter.textContent;
  viewer.hidden = false;
  document.body.classList.add("viewing");
  document.getElementById("viewerClose").focus();

  // Each side is opened on its own. One document failing to parse should leave
  // the other readable and say which one broke, rather than closing the window
  // and blaming both — and a shared try block hid exactly that: a failure after
  // the pages were already on screen left the pane looking rendered while the
  // handle needed to zoom or scroll it was quietly never assigned.
  const load = async (host, bytes, which) => {
    try {
      return await renderDocument(host, bytes, 1);
    } catch (err) {
      console.error(`preview: ${which} failed to render`, err);
      notice(`The ${which} could not be displayed.`, "error");
      return null;
    }
  };

  // Sequential, not parallel: two documents parsing at once on a laptop makes
  // the first one appear later than it needs to.
  const original = new Uint8Array(await item.file.arrayBuffer());
  previewDocs.a = await load(viewerA, original, "original");
  previewDocs.b = await load(viewerB, item.bytes, "compressed file");
  setZoom(currentZoom);
}

function closePreview() {
  viewer.hidden = true;
  document.body.classList.remove("viewing");
  destroy(previewDocs.a);
  destroy(previewDocs.b);
  previewDocs = { a: null, b: null };
}

function setZoom(zoom) {
  currentZoom = zoom;
  for (const [state, pane] of [[previewDocs.a, scrollA], [previewDocs.b, scrollB]]) {
    if (!state) continue;
    // Both panes are scaled by the same rule, but "fit" is measured per pane —
    // if the two documents differ in page size, matching their *scales* would
    // leave one of them not fitting.
    rescale(state, zoom === "fit" ? fitScale(state, pane) : ZOOMS[zoom]);
  }
  for (const button of viewer.querySelectorAll(".viewer-zoom button")) {
    button.setAttribute("aria-pressed", String(String(button.dataset.zoom) === String(zoom)));
  }
}

for (const button of viewer.querySelectorAll(".viewer-zoom button")) {
  button.addEventListener("click", () => setZoom(button.dataset.zoom));
}

// Phone: which document is on screen. Zoom is re-applied after the switch
// because "Fit" measures the pane, and a hidden pane measures zero wide.
for (const button of viewer.querySelectorAll(".viewer-which button")) {
  button.addEventListener("click", () => {
    viewer.dataset.show = button.dataset.show;
    for (const other of viewer.querySelectorAll(".viewer-which button")) {
      other.setAttribute("aria-pressed", String(other === button));
    }
    setZoom(currentZoom);
  });
}
document.getElementById("viewerClose").addEventListener("click", closePreview);
// Escape closes it, as it closes everything else that covers the page.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !viewer.hidden) closePreview();
});

/* Scrolling one pane scrolls the other, both ways.
   Possible at all only because the panes are this page's own elements now.
   Proportional rather than absolute: the two documents can be different heights
   — a compressed file is often shorter — and matching raw pixel offsets would
   drift further apart the longer the document. The guard stops the echo: moving
   A moves B, whose scroll event would otherwise move A back, and the two would
   fight to a standstill. */
let syncingScroll = false;

for (const [from, to] of [[scrollA, scrollB], [scrollB, scrollA]]) {
  from.addEventListener("scroll", () => {
    if (syncingScroll) return;
    syncingScroll = true;
    const room = from.scrollHeight - from.clientHeight;
    const fraction = room > 0 ? from.scrollTop / room : 0;
    to.scrollTop = fraction * (to.scrollHeight - to.clientHeight);
    to.scrollLeft = from.scrollLeft;
    // Released on the next frame: the assignment above fires the other pane's
    // scroll event asynchronously, and clearing the flag in the same tick would
    // let it straight through.
    requestAnimationFrame(() => { syncingScroll = false; });
  });
}

/* ---- Results ------------------------------------------------------------- */
/**
 * Fill in a file's row with its result, whether the bytes were just produced or
 * came from a previous run at the same quality.
 */
function placeResult(file, { bytes, images }, preset, reused) {
  dropResult(file);
  const row = rows.get(file);
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  // The name says which recipe produced it, so two runs of the same source do
  // not land in the downloads folder as "file (1).pdf".
  const name = file.name.replace(/\.pdf$/i, "") + preset.suffix + ".pdf";
  results.set(file, { name, bytes, file, preset: preset.name, url, row, saved: false });

  // Everything that finishes starts ticked: the common case is "all of them",
  // and unticking two is less work than ticking eighteen.
  const checkbox = row.querySelector(".row-sel");
  checkbox.hidden = false;
  checkbox.checked = true;

  const link = row.querySelector(".row-get");
  link.href = url;
  link.download = name;
  link.hidden = false;
  row.querySelector(".row-preview").hidden = false;
  // Done rows leave through Clear all; a lone × beside Download is a misclick.
  row.querySelector(".row-drop").hidden = true;

  const saving = document.createElement("b");
  saving.textContent = savingText(file.size, bytes.length);
  row.querySelector(".row-size").replaceChildren(
    `${humanBytes(file.size)} \u2192 ${humanBytes(bytes.length)} `, saving);

  // What was actually done to the file. The image count is real — it comes from
  // Ghostscript's own object dump. Italic rather than brackets for the recipe: a
  // preset can carry its own brackets ("Print (Brochure)").
  const quality = document.createElement("i");
  quality.textContent = `${preset.name} quality`;
  setRowState(row, "done");
  row.querySelector(".row-status").replaceChildren(
    `${describeImages(images)} · `, quality,
    // Said plainly rather than hidden: a row that appears instantly while its
    // neighbours grind looks like a bug unless it explains itself.
    reused ? " · already compressed" : "");
}

/** "400/417 images resized". Both numbers in one phrase rather than a count and
    a breakdown: the interesting quantity is the ratio.

    The *reason* an image was left alone is deliberately not claimed — it
    depends on the image's placement on the page, which is not read here. */
function describeImages({ total, resized }) {
  if (!total) return "No images";
  return `${resized}/${total} image${total > 1 ? "s" : ""} resized`;
}

/** Failures are events, so they are the one thing still raised as a toast. */
function reportFailures(ok, failed) {
  if (!failed) return;
  if (!ok) {
    notice(failed === 1 ? "That file could not be compressed."
                        : `All ${failed} files failed.`, "error");
    return;
  }
  notice(`${failed} of ${failed + ok} files failed.`, "error");
}
