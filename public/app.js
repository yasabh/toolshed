// The shell: theme toggle, sidebar collapse, and the one way to say something
// short to the user. Tools import notice() from here with a relative specifier,
// which resolves against this module's own URL — prefix-safe by construction.

const root = document.documentElement;

/* ---- Theme — tv-webui's js/theme.js, verbatim ---------------------------- */
// One button toggles light<->dark; with no saved choice it follows the OS.
(function initTheme() {
  const btn = document.getElementById("theme");
  const effective = () =>
    localStorage.getItem("theme") ||
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const render = () => {
    const saved = localStorage.getItem("theme");
    if (saved) root.setAttribute("data-theme", saved);
    else root.removeAttribute("data-theme");
    btn.dataset.val = effective(); // CSS shows the matching icon
  };
  render();
  btn.addEventListener("click", () => {
    localStorage.setItem("theme", effective() === "dark" ? "light" : "dark");
    render();
  });
})();

/* ---- Sidebar ------------------------------------------------------------- */
(function initSidebar() {
  const btn = document.getElementById("sidebarToggle");
  const narrow = () => matchMedia("(max-width: 700px)").matches;

  const render = () => {
    const collapsed = root.getAttribute("data-sidebar") === "collapsed";
    btn.setAttribute("aria-expanded", String(!collapsed));
    btn.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
  };
  render(); // the pre-paint script in <head> already set the attribute

  btn.addEventListener("click", () => {
    const collapsed = root.getAttribute("data-sidebar") === "collapsed";
    if (collapsed) root.removeAttribute("data-sidebar");
    else root.setAttribute("data-sidebar", "collapsed");

    // On a phone the collapsed state is the viewport's doing, not a choice —
    // storing it would follow the user back to a desktop that has room for it.
    if (!narrow()) {
      localStorage.setItem("sidebar", collapsed ? "expanded" : "collapsed");
    }
    render();
  });
})();

/* ---- Toast notices ------------------------------------------------------- */
//   notice("Saved", "success");  notice("Failed", "error");  notice("…")
// The stack is a popover="manual", so it sits in the top layer above any
// overlay (the preview included) without a z-index race. Screen readers hear the
// text through one live region that exists from page load: a region created
// together with its message is often not read at all.
const host = document.getElementById("notices");
const announce = document.getElementById("announce");
const ICON = { success: "\u2713", error: "!", info: "i" };
const SHOW_MS = 3500;
const X_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

export function notice(message, type = "info") {
  const card = document.createElement("div");
  card.className = `notice ${type}`;
  const icon = document.createElement("span");
  icon.className = "ni";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = ICON[type] || ICON.info;
  const text = document.createElement("span");
  text.className = "nt";
  text.textContent = message; // textContent: a file name is not markup
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "nx";
  dismiss.setAttribute("aria-label", "Dismiss");
  dismiss.innerHTML = X_ICON; // a constant, never data
  card.append(icon, text, dismiss);

  host.append(card);
  if (!host.matches(":popover-open")) host.showPopover();
  announce.textContent = message;
  requestAnimationFrame(() => card.classList.add("in"));

  const close = () => {
    clearTimeout(timer);
    card.classList.remove("in");
    setTimeout(() => {
      card.remove();
      if (!host.children.length && host.matches(":popover-open")) host.hidePopover();
    }, 220);
  };
  const timer = setTimeout(close, SHOW_MS);
  dismiss.addEventListener("click", close);
}

/* ---- Sizes, in the units people quote them in ---------------------------- */
export function humanBytes(n) {
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}
