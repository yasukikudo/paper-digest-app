// The app: sign-in, routing (#/day/YYYY-MM-DD, #/library, #/settings) and paper actions.
// The page shell (index.html) has a fixed top bar, a scrolling content area, a fixed tab bar,
// a bottom sheet for notes and a toast for short messages.

import * as data from "./data.js";
import * as view from "./render.js";
import { DEFAULT_FIELDS, STATUSES } from "./labels.js";

const content = document.getElementById("content");
const appbar = document.getElementById("appbar");
const tabbar = document.getElementById("tabbar");
const sheet = document.getElementById("note-sheet");
const backdrop = document.getElementById("sheet-backdrop");
const EMAIL_KEY = "paper-digest.email";
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

const state = {
  user: null,
  days: [],                  // dates with a day document, ascending
  library: new Map(),        // doi_key → library document (live)
  requests: new Map(),       // request ID → request document (live)
  papers: new Map(),         // doi_key → paper document (cache)
  authors: new Map(),        // OpenAlex author ID → author document (cache)
  busy: new Set(),           // doi_keys with a request being created
  optimistic: new Map(),     // doi_key → library entry shown until the write is confirmed
  page: null,                // "login" | "day" | "library" | "settings"
  librarySignature: "",
  navigation: 0,             // increases on every page change; stale loads are dropped
  noteKey: null,             // paper the note sheet is for
  unsubscribe: [],
};

// ---------- Small helpers ----------

const storage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* not available */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* not available */ } },
};

let toastTimer;
function toast(message, kind = "") {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = "toast"; }, kind === "error" ? 5000 : 1600);
}

function errorText(err) {
  const code = err?.code || "";
  if (code === "permission-denied" || code === "firestore/permission-denied") {
    return "Permission denied by the Firestore rules.";
  }
  if (code === "unavailable") return "Offline or Firestore is unavailable. Try again.";
  return err?.message || String(err);
}

function stateOf(key) {
  return {
    entry: state.optimistic.get(key) || state.library.get(key),
    request: view.latestRequest(key, state.requests),
    busy: state.busy.has(key),
  };
}

// Show a page: top bar, content (with a short entrance animation) and the active tab
function show(page, bar, html, { keepScroll = false } = {}) {
  appbar.innerHTML = view.appBar(bar);
  const y = content.scrollTop;
  content.innerHTML = html;
  if (keepScroll) {
    content.scrollTop = y;
  } else {
    content.scrollTop = 0;
    content.classList.remove("enter");
    void content.offsetWidth;   // restart the animation
    content.classList.add("enter");
  }
  for (const tab of tabbar.querySelectorAll("[data-tab]")) {
    if (tab.dataset.tab === page) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  }
}

function showLoading(page, bar) {
  show(page, bar, view.skeleton());
}

// ---------- Sign-in ----------

function showLogin(message = "") {
  state.page = "login";
  document.body.classList.add("signed-out");
  appbar.innerHTML = "";
  content.innerHTML = view.loginPage(storage.get(EMAIL_KEY), message);
  const form = content.querySelector("#login-form");
  const pin = form.elements.pin;
  pin.focus();
  pin.addEventListener("input", () => {
    pin.value = pin.value.replace(/\D/g, "").slice(0, 6);
    if (pin.value.length === 6 && form.elements.email.value) form.requestSubmit();
  });
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const email = form.elements.email.value.trim();
    const msg = form.querySelector(".msg");
    msg.textContent = "Signing in…";
    try {
      await data.signIn(email, pin.value);
      storage.set(EMAIL_KEY, email);   // only on this device
    } catch (err) {
      pin.value = "";
      msg.textContent = {
        "auth/invalid-credential": "Wrong PIN or email.",
        "auth/wrong-password": "Wrong PIN.",
        "auth/user-not-found": "No account with this email.",
        "auth/invalid-email": "Check the email address.",
        "auth/too-many-requests": "Too many attempts. Wait a while and try again.",
        "auth/network-request-failed": "No network connection.",
      }[err.code] || errorText(err);
    }
  });
  form.querySelector('[data-act="other-email"]')?.addEventListener("click", () => {
    storage.remove(EMAIL_KEY);
    showLogin();
  });
}

function startSession(user) {
  state.user = user;
  document.body.classList.remove("signed-out");
  const fail = (err) => toast(`Live updates stopped: ${errorText(err)}`, "error");
  state.unsubscribe = [
    data.watchCollection("library", (docs) => { state.library = docs; onLiveChange(); }, fail),
    data.watchCollection("requests", (docs) => { state.requests = docs; onLiveChange(); }, fail),
  ];
  route();
}

function endSession() {
  state.unsubscribe.forEach((stop) => stop());
  state.unsubscribe = [];
  state.user = null;
  state.library = new Map();
  state.requests = new Map();
  state.papers.clear();
  state.authors.clear();
  state.days = [];
  closeSheet();
}

// ---------- Routing ----------

function route() {
  if (!state.user) return;
  state.navigation += 1;
  closeSheet();
  const hash = location.hash;
  const day = hash.match(/^#\/day\/(\d{4}-\d{2}-\d{2})$/);
  if (day) showDay(day[1]);
  else if (hash === "#/library") showLibrary();
  else if (hash === "#/settings") showSettings();
  else showDay(null);
}

window.addEventListener("hashchange", route);

// ---------- Day page ----------

async function showDay(date) {
  const navigation = state.navigation;
  state.page = "day";
  showLoading("today", { date: date || "" });
  try {
    if (!date || !state.days.length) state.days = await data.dayIds();
    if (!date) date = state.days.at(-1);
    if (navigation !== state.navigation) return;
    if (!date) {
      show("today", { date: "" }, '<p class="empty">No digest yet.</p>');
      return;
    }
    const bar = {
      date,
      prev: state.days.filter((d) => d < date).at(-1),
      next: state.days.find((d) => d > date),
      min: state.days[0],
      max: state.days.at(-1),
    };
    appbar.innerHTML = view.appBar(bar);
    const day = await data.getDay(date);
    if (navigation !== state.navigation) return;
    if (!day) {
      show("today", bar, '<p class="empty">No digest for this day.</p>');
      return;
    }
    const papers = (await data.getMany("papers", day.paper_keys || [], state.papers)).filter(Boolean);
    const fields = day.fields?.length ? day.fields : DEFAULT_FIELDS;
    if (navigation !== state.navigation) return;
    show("today", bar, view.dayPage(day, papers, fields, stateOf));
    document.title = `Paper digest ${date}`;
  } catch (err) {
    if (navigation === state.navigation) {
      show("today", { date: date || "" }, `<p class="empty">Could not load the digest. ${view.e(errorText(err))}</p>`);
    }
  }
}

// ---------- Library page ----------

function libraryEntries() {
  const saved = [...state.library.values()].filter((x) => x.saved);
  const time = (s) => Date.parse(s || "") || 0;
  const groups = new Map(STATUSES.map(([code]) => [code, []]));
  for (const entry of saved) groups.get(entry.status === "read" ? "read" : "to_read").push(entry);
  for (const list of groups.values()) {
    list.sort((a, b) => (b.saved_at || "").localeCompare(a.saved_at || "") || time(b.updated_at) - time(a.updated_at));
  }
  return { saved, groups };
}

const signatureOf = (groups) => [...groups.values()].map((list) => list.map((x) => x.doi_key).join(",")).join("|");

async function showLibrary() {
  const navigation = state.navigation;
  state.page = "library";
  document.title = "Library";
  showLoading("library", { title: "Library" });
  try {
    await data.getMany("papers", [...state.library.keys()], state.papers);
    if (navigation === state.navigation) renderLibrary(false);
  } catch (err) {
    if (navigation === state.navigation) {
      show("library", { title: "Library" }, `<p class="empty">Could not load the library. ${view.e(errorText(err))}</p>`);
    }
  }
}

function renderLibrary(keepScroll) {
  const { saved, groups } = libraryEntries();
  state.librarySignature = signatureOf(groups);
  const htmlGroups = new Map([...groups].map(([code, list]) => [code, list.map((entry) => ({
    html: view.libraryCard(state.papers.get(entry.doi_key) || { doi_key: entry.doi_key }, entry, stateOf(entry.doi_key)),
  }))]));
  // keep open panels across a re-render
  const open = new Set([...content.querySelectorAll("details[open]")].map(detailsId));
  show("library", { title: "Library" },
    view.libraryPage(htmlGroups, { saved: saved.length, fulltext: saved.filter((x) => x.fulltext).length }),
    { keepScroll });
  content.querySelectorAll("details").forEach((d) => { if (open.has(detailsId(d))) d.open = true; });
  content.querySelectorAll("details[open][data-authors]").forEach(loadAuthors);
}

function detailsId(d) {
  return `${d.closest("[data-key]")?.dataset.key}|${d.querySelector("summary")?.textContent}`;
}

// ---------- Live updates ----------

async function onLiveChange() {
  if (state.page === "library" && !content.querySelector(".skeleton")) {
    const { groups } = libraryEntries();
    if (signatureOf(groups) !== state.librarySignature) {
      await data.getMany("papers", [...state.library.keys()], state.papers).catch(() => {});
      if (state.page === "library") renderLibrary(true);
      return;
    }
  }
  if (state.page === "day" || state.page === "library") refreshCards();
}

// Replace only the parts of each card that depend on library and requests
function refreshCards() {
  for (const card of content.querySelectorAll("article.paper[data-key]")) {
    const key = card.dataset.key;
    const paper = state.papers.get(key) || { doi_key: key };
    const s = stateOf(key);
    const slot = (name) => card.querySelector(`[data-slot="${name}"]`);
    slot("badges").innerHTML = view.cardBadges(card, s.entry);
    slot("actions").innerHTML = view.actions(paper, s.entry, s.request, s.busy);
    slot("notes").innerHTML = view.notesList(s.entry);
    const ft = s.entry?.fulltext;
    const signature = ft ? `${ft.created_at}|${ft.source}` : "";
    const ftSlot = slot("fulltext");
    if ((ftSlot.dataset.signature || "") !== signature) {
      ftSlot.innerHTML = view.fulltextPanel(s.entry);
      ftSlot.dataset.signature = signature;
    }
    const oneLiner = slot("oneliner");
    if (oneLiner) {
      const text = ft?.one_liner || paper.one_liner;
      oneLiner.innerHTML = text ? `<p class="oneliner"${view.lang(text)}>${view.e(text)}</p>` : "";
    }
  }
}

// ---------- Actions on papers ----------

// Library writes run in a transaction, so Firestore confirms them only after a round trip.
// The change is shown at once and replaced by the stored document when the write finishes
// (or undone if it fails).
async function withOptimistic(key, change, write) {
  const current = state.optimistic.get(key) || state.library.get(key) || { notes: [] };
  state.optimistic.set(key, { ...current, ...change(current) });
  refreshCards();
  try {
    await write();
  } finally {
    state.optimistic.delete(key);
    refreshCards();
  }
}

const today = () => new Date().toLocaleDateString("en-CA");   // YYYY-MM-DD

async function act(button, card) {
  const key = card.dataset.key;
  const paper = state.papers.get(key);
  if (!paper) return;
  const what = button.dataset.act;
  try {
    if (what === "save") {
      toast("Saved");
      await withOptimistic(key, (e) => ({ saved: true, saved_at: e.saved_at || today(), status: e.status || "to_read" }),
        () => data.setSaved(paper, true));
    } else if (what === "unsave") {
      toast("Removed from library");
      await withOptimistic(key, () => ({ saved: false, saved_at: null }), () => data.setSaved(paper, false));
    } else if (what === "status") {
      const status = button.dataset.status;
      toast(status === "read" ? "Marked as read" : "Marked as to read");
      await withOptimistic(key, (e) => ({ saved: true, saved_at: e.saved_at || today(), status }),
        () => data.setStatus(paper, status));
    } else if (what === "note") {
      openSheet(paper);
    } else if (what === "request") {
      const request = view.latestRequest(key, state.requests);
      if (state.busy.has(key) || ["pending", "processing"].includes(request?.status) || state.library.get(key)?.fulltext) return;
      state.busy.add(key);
      refreshCards();
      try {
        await data.requestFulltext(paper);
        toast("Requested");
      } finally {
        state.busy.delete(key);
        refreshCards();
      }
    }
  } catch (err) {
    toast(`Could not save: ${errorText(err)}`, "error");
  }
}

content.addEventListener("click", (ev) => {
  const jump = ev.target.closest("[data-jump]");
  if (jump) {
    ev.preventDefault();
    document.getElementById(jump.dataset.jump)?.scrollIntoView({ behavior: reducedMotion.matches ? "auto" : "smooth" });
    return;
  }
  const button = ev.target.closest("button[data-act]");
  const card = button?.closest("article.paper[data-key]");
  if (button && card) act(button, card);
  if (button?.dataset.act === "signout") {
    endSession();
    data.signOutUser();
  }
});

appbar.addEventListener("change", (ev) => {
  if (ev.target.matches('input[type="date"]') && ev.target.value) {
    location.hash = `#/day/${ev.target.value}`;
  }
});

// Tapping the active Today tab on the latest day scrolls back to the top
tabbar.addEventListener("click", (ev) => {
  const tab = ev.target.closest("[data-tab]");
  if (tab?.getAttribute("aria-current") === "page" && location.hash === tab.getAttribute("href")) {
    ev.preventDefault();
    content.scrollTo({ top: 0, behavior: reducedMotion.matches ? "auto" : "smooth" });
  }
});

// Author details are loaded when the Authors panel is first opened
async function loadAuthors(details) {
  if (details.dataset.loaded) return;
  const paper = state.papers.get(details.closest("[data-key]").dataset.key);
  if (!paper) return;
  details.dataset.loaded = "1";
  const ids = (paper.authorships || []).map((a) => a.author_id).filter(Boolean);
  try {
    await data.getMany("authors", ids, state.authors);
  } catch { /* names and affiliations are shown without the numbers */ }
  details.querySelector(".panel").innerHTML = view.authorsBody(paper, state.authors);
}

content.addEventListener("toggle", (ev) => {
  if (ev.target.matches?.("details[data-authors]") && ev.target.open) loadAuthors(ev.target);
}, true);

// ---------- Note sheet ----------

function openSheet(paper) {
  state.noteKey = paper.doi_key;
  sheet.querySelector(".sheet-paper").textContent = paper.title || paper.doi || "";
  sheet.hidden = false;
  backdrop.hidden = false;
  requestAnimationFrame(() => {
    sheet.classList.add("open");
    backdrop.classList.add("open");
    sheet.elements.text.focus();
  });
}

function closeSheet() {
  if (sheet.hidden) return;
  state.noteKey = null;
  sheet.classList.remove("open");
  backdrop.classList.remove("open");
  const hide = () => { if (!state.noteKey) { sheet.hidden = true; backdrop.hidden = true; } };
  if (reducedMotion.matches) hide();
  else setTimeout(hide, 250);
}

sheet.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const text = sheet.elements.text.value.trim();
  const paper = state.papers.get(state.noteKey);
  if (!text || !paper) return;
  sheet.elements.text.value = "";
  closeSheet();
  toast("Note added");
  try {
    await withOptimistic(paper.doi_key, (e) => ({ notes: [...(e.notes || []), { at: data.isoNow(), text }] }),
      () => data.addNote(paper, text));
  } catch (err) {
    toast(`Could not save the note: ${errorText(err)}`, "error");
    openSheet(paper);
    sheet.elements.text.value = text;   // give the text back
  }
});

sheet.addEventListener("click", (ev) => {
  if (ev.target.closest('[data-act="sheet-cancel"]')) closeSheet();
});
backdrop.addEventListener("click", closeSheet);
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") closeSheet();
  // ⌘/Ctrl + Enter adds the note
  if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey) && !sheet.hidden) sheet.requestSubmit();
});

// ---------- Settings ----------

function showSettings() {
  state.page = "settings";
  document.title = "Settings";
  show("settings", { title: "Settings" }, view.settingsPage(state.user.email));
  const form = content.querySelector("#pin-form");
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const msg = form.querySelector(".msg");
    const { current, next, again } = form.elements;
    msg.classList.remove("ok");
    if (!/^\d{6}$/.test(next.value)) { msg.textContent = "The new PIN must be 6 digits."; return; }
    if (next.value !== again.value) { msg.textContent = "The new PINs do not match."; return; }
    msg.textContent = "Changing…";
    try {
      await data.changePin(current.value, next.value);
      form.reset();
      msg.textContent = "PIN changed.";
      msg.classList.add("ok");
      toast("PIN changed");
    } catch (err) {
      msg.textContent = {
        "auth/invalid-credential": "The current PIN is wrong.",
        "auth/wrong-password": "The current PIN is wrong.",
        "auth/too-many-requests": "Too many attempts. Wait a while and try again.",
        "auth/weak-password": "Firebase rejected this PIN (password policy).",
        "auth/password-does-not-meet-requirements": "Firebase rejected this PIN (password policy).",
      }[err.code] || errorText(err);
    }
  });
}

// ---------- Start ----------

data.watchUser((user) => {
  if (user) {
    if (state.user?.uid !== user.uid) startSession(user);
  } else {
    endSession();
    showLogin();
  }
});
