// Keeps every page live. The server pushes ready made HTML for the live panels, and tells
// pages to reload their data when a job starts or finishes.

const events = new EventSource("/events");
const dot = () => document.querySelector("[data-connection]");

events.onopen = () => {
  dot()?.classList.replace("bg-error", "bg-success");
  dot()?.setAttribute("data-tip", "Live updates are connected");
};
events.onerror = () => {
  dot()?.classList.replace("bg-success", "bg-error");
  dot()?.setAttribute("data-tip", "Lost the connection to the server. Retrying.");
};

// The server sends a new id each time it starts. Reload when it changes, since the page
// was drawn by the old version.
let boot;
events.addEventListener("boot", (e) => {
  if (boot && boot !== e.data) location.reload();
  boot = e.data;
});

for (const name of ["nav", "activity"]) {
  events.addEventListener(name, (e) => {
    for (const el of document.querySelectorAll(`[data-live="${name}"]`)) update(el, e.data);
    tick();
  });
}

// Updates part of the page by changing only what differs. Replacing it all would swap out
// the button under the cursor, and a click that lands mid swap does nothing.
function update(el, html) {
  const next = document.createElement("div");
  next.innerHTML = html;
  morphChildren(el, next);
  takeTitles(el);
}

function morph(from, to) {
  if (from.nodeType !== to.nodeType || from.nodeName !== to.nodeName) {
    from.replaceWith(to.cloneNode(true));
    return;
  }
  if (from.nodeType !== Node.ELEMENT_NODE) {
    if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
    return;
  }
  // Leave alone whatever someone is typing, and rows the filter has hidden.
  if (from === document.activeElement && (from.nodeName === "INPUT" || from.nodeName === "TEXTAREA")) return;
  for (const { name, value } of [...to.attributes]) {
    if (from.getAttribute(name) !== value) from.setAttribute(name, value);
  }
  for (const { name } of [...from.attributes]) {
    const keep = (name === "open" && from.nodeName === "DETAILS") || name === "hidden" || name === "data-tip";
    if (!to.hasAttribute(name) && !keep) from.removeAttribute(name);
  }
  morphChildren(from, to);
}

function morphChildren(from, to) {
  const old = [...from.childNodes];
  const next = [...to.childNodes];
  next.forEach((node, i) => (old[i] ? morph(old[i], node) : from.appendChild(node.cloneNode(true))));
  old.slice(next.length).forEach((node) => node.remove());
}

// Jobs come and go in bursts, so wait for a quiet moment, and once more after the burst
// so the last change isn't missed.
let reloadTimer;
let reloading = false;
let reloadAgain = false;
events.addEventListener("jobs", () => {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(reloadAll, 300);
});

async function reloadAll() {
  if (reloading) {
    reloadAgain = true;
    return;
  }
  reloading = true;
  for (const el of document.querySelectorAll("[data-refresh-on]")) await reload(el);
  reloading = false;
  if (reloadAgain) {
    reloadAgain = false;
    reloadAll();
  }
}

async function reload(el) {
  const url = new URL(el.dataset.src, location.href);
  url.searchParams.set("fragment", "1");
  try {
    const res = await fetch(url, { headers: { "x-timeshifter": "1" } });
    if (!res.ok) return;
    update(el, await res.text());
  } catch {
    return;
  }
  filter();
  tick();
}

// Some reverse proxies hold the event stream back, which would leave a finished job
// looking like it's still running. Reread every so often as a backstop.
setInterval(() => {
  if (document.visibilityState === "visible") reloadAll();
}, 30_000);

// Parts of the page showing something in progress ask to be reread every second or two.
const polled = new WeakMap();
setInterval(() => {
  if (document.visibilityState !== "visible") return;
  for (const el of document.querySelectorAll("[data-poll]")) {
    const holder = el.closest("[data-src]");
    if (!holder) continue;
    const last = polled.get(holder) ?? 0;
    if (Date.now() - last < Number(el.dataset.poll)) continue;
    polled.set(holder, Date.now());
    reload(holder);
  }
}, 500);

events.addEventListener("toast", (e) => toast(JSON.parse(e.data)));

const toneColour = { success: "bg-success", error: "bg-error", warn: "bg-warning", quiet: "bg-base-content/40" };

function toast({ tone, title, text, href }) {
  const box = document.querySelector("[data-toasts]");
  if (!box) return;
  const el = document.createElement(href ? "a" : "div");
  if (href) el.href = href;
  el.className = "toast hover:border-base-content/20";
  const mark = document.createElement("span");
  mark.className = `mt-1.5 size-2 shrink-0 rounded-full ${toneColour[tone] ?? toneColour.quiet}`;
  const body = document.createElement("span");
  body.className = "min-w-0 flex-1";
  const strong = document.createElement("span");
  strong.className = "block truncate font-medium";
  strong.textContent = title;
  const small = document.createElement("span");
  small.className = `block text-xs ${tone === "error" ? "text-error" : "text-base-content/55"}`;
  small.textContent = text;
  body.append(strong, small);
  el.append(mark, body);
  box.append(el);
  setTimeout(() => el.remove(), tone === "error" ? 12_000 : 6_000);
}

// Forms marked data-async post in the background. Live updates show what happened.
document.addEventListener("submit", async (e) => {
  const form = e.target;
  const button = e.submitter;

  // A button with data-result posts its form and shows the answer next to it.
  if (button?.dataset.result) {
    e.preventDefault();
    const target = document.querySelector(button.dataset.result);
    button.disabled = true;
    target.innerHTML = '<span class="text-[13px] text-base-content/50 pulse">Trying…</span>';
    try {
      const res = await fetch(button.formAction, { method: "POST", body: new URLSearchParams(new FormData(form)) });
      target.innerHTML = await res.text();
    } catch {
      target.innerHTML = '<span class="text-[13px] text-error">Couldn\'t reach timeshifter</span>';
    }
    button.disabled = false;
    return;
  }

  if (!form.matches("[data-async]")) return;
  e.preventDefault();
  if (button) button.disabled = true;
  try {
    const body = new URLSearchParams(new FormData(form, button));
    const res = await fetch(form.action, { method: "POST", body, headers: { "x-timeshifter": "1" } });
    if (!res.ok) toast({ tone: "error", title: "That didn't work", text: await res.text() });
    else if (form.matches("[data-reload]")) location.reload();
    else reloadAll();
  } catch {
    toast({ tone: "error", title: "That didn't work", text: "Couldn't reach timeshifter" });
  }
  setTimeout(() => button && (button.disabled = false), 600);
});

// Forms marked data-preview redraw a summary as you type, from the same page's fragment.
let previewTimer;
function preview(form) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    const url = new URL(location.pathname, location.href);
    // A list field sends one value per box, so every one has to go in, not just the last.
    url.search = new URLSearchParams(new FormData(form)).toString();
    url.searchParams.set("fragment", "1");
    const res = await fetch(url);
    const target = document.querySelector(form.dataset.preview);
    if (res.ok && target) update(target, await res.text());
  }, 200);
}
for (const type of ["input", "change"]) {
  document.addEventListener(type, (e) => {
    const form = e.target.closest?.("form[data-preview]");
    if (form) preview(form);
  });
}

// Dropdowns marked data-navigate go to the page named by the option picked.
document.addEventListener("change", (e) => {
  if (e.target.matches?.("select[data-navigate]")) location.href = e.target.value;
});

// List fields, like "Title contains", have a box per word with + and × to add and remove boxes.
function addWord(row) {
  const copy = row.cloneNode(true);
  const input = copy.querySelector("input");
  input.value = "";
  input.removeAttribute("placeholder");
  row.after(copy);
  input.focus();
}

document.addEventListener("click", (e) => {
  const add = e.target.closest?.("[data-add]");
  if (add) return addWord(add.closest(".word"));
  const remove = e.target.closest?.("[data-remove]");
  if (!remove) return;
  const row = remove.closest(".word");
  const form = row.closest("form");
  (row.nextElementSibling ?? row.previousElementSibling)?.querySelector("input")?.focus();
  row.remove();
  tip.hidden = true;
  // Tells the live preview that the form changed.
  form?.dispatchEvent(new Event("input", { bubbles: true }));
});

// Enter in a list box adds another box rather than saving the form.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || !e.target.matches?.(".word input")) return;
  e.preventDefault();
  addWord(e.target.closest(".word"));
});

// Instant search over the rows already on the page. The text lives in the URL as ?q= so a
// refresh or a shared link keeps it.
const search = () => document.querySelector("[data-filter]");
function filter() {
  const input = search();
  if (!input) return;
  const value = input.value;
  const q = value.trim().toLowerCase();
  let shown = 0;
  for (const row of document.querySelectorAll("[data-title]")) {
    row.hidden = q !== "" && !row.dataset.title.toLowerCase().includes(q);
    if (!row.hidden) shown++;
  }
  for (const group of document.querySelectorAll("[data-group]")) {
    group.hidden = !group.querySelector("[data-title]:not([hidden])");
  }
  for (const empty of document.querySelectorAll("[data-filter-empty]")) empty.hidden = shown > 0;
  const url = new URL(location.href);
  if (value) url.searchParams.set("q", value);
  else url.searchParams.delete("q");
  history.replaceState(null, "", url);
}

document.addEventListener("input", (e) => e.target.matches?.("[data-filter]") && filter());
if (search()) {
  search().value = new URLSearchParams(location.search).get("q") ?? "";
  filter();
}
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) {
    e.preventDefault();
    search()?.focus();
  }
  if (e.key === "Escape" && document.activeElement === search()) {
    search().value = "";
    filter();
    search().blur();
  }
});

// Running clocks, "5m ago" and "in 7m" count along on their own between updates.
function tick() {
  const now = Date.now();
  for (const el of document.querySelectorAll("[data-since]")) {
    if (el.dataset.since) el.textContent = duration((now - Date.parse(el.dataset.since)) / 1000);
  }
  for (const el of document.querySelectorAll("[data-ago]")) {
    if (!el.dataset.ago) continue;
    const secs = (now - Date.parse(el.dataset.ago)) / 1000;
    if (secs < 86_400) el.textContent = ago(secs);
  }
  for (const el of document.querySelectorAll("[data-until]")) {
    if (!el.dataset.until) continue;
    const secs = (Date.parse(el.dataset.until) - now) / 1000;
    el.textContent = until(secs);
  }
}

function ago(secs) {
  if (secs < 10) return "just now";
  if (secs < 60) return `${Math.floor(secs)}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}

function until(secs) {
  if (secs <= 0) return "now";
  if (secs < 60) return "in under a minute";
  if (secs < 3600) return `in ${Math.floor(secs / 60)}m`;
  if (secs < 86_400) return `in ${Math.floor(secs / 3600)}h ${String(Math.floor(secs / 60) % 60).padStart(2, "0")}m`;
  return `in ${Math.floor(secs / 86_400)}d`;
}

function duration(secs) {
  secs = Math.max(0, Math.floor(secs));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, "0")}s`;
  return `${Math.floor(secs / 3600)}h ${String(Math.floor(secs / 60) % 60).padStart(2, "0")}m`;
}

setInterval(tick, 1000);
tick();

// "Saved" notes fade away once they've been seen.
for (const el of document.querySelectorAll("[data-flash]")) {
  setTimeout(() => el.remove(), 4000);
  const url = new URL(location.href);
  url.searchParams.delete("saved");
  history.replaceState(null, "", url);
}

// The browser's own tooltips take a second to appear and can't be styled, so titles move
// into data-tip and show in our own box instead. Live updates bring titles back, which is
// why update() runs this again.
function takeTitles(root) {
  for (const el of root.querySelectorAll("[title]")) {
    el.dataset.tip = el.title;
    el.removeAttribute("title");
  }
}
takeTitles(document.body);

const tip = document.createElement("div");
tip.className = "tip";
tip.hidden = true;
document.body.append(tip);

document.addEventListener("pointerover", (e) => {
  const el = e.target.closest?.("[data-tip]");
  if (!el || e.pointerType === "touch") return;
  tip.textContent = el.dataset.tip;
  tip.hidden = false;
  const box = el.getBoundingClientRect();
  const gap = 6;
  const left = Math.min(Math.max(8, box.left + box.width / 2 - tip.offsetWidth / 2), innerWidth - tip.offsetWidth - 8);
  // Above the element, unless that would go off the top of the screen.
  const above = box.top - tip.offsetHeight - gap;
  tip.style.left = `${left}px`;
  tip.style.top = `${above > 8 ? above : box.bottom + gap}px`;
});
document.addEventListener("pointerout", (e) => {
  if (e.target.closest?.("[data-tip]") && !e.relatedTarget?.closest?.("[data-tip]")) tip.hidden = true;
});
addEventListener("scroll", () => (tip.hidden = true), { passive: true });
