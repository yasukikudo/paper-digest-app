// The app: sign-in, routing and paper actions.
// Routes: #/day/YYYY-MM-DD (Today), #/browse, #/paper/{doi_key}, #/library, #/settings.
// The page shell (index.html) has a fixed top bar, a scrolling content area, a fixed tab bar,
// bottom sheets (notes, calendar), a calendar window for wide screens and a toast.

import * as data from "./data.js";
import * as view from "./render.js";
import { DEFAULT_FIELDS, STATUSES } from "./labels.js";
import * as schedule from "./schedule.js";
import * as push from "./push.js";

const content = document.getElementById("content");
const appbar = document.getElementById("appbar");
const tabbar = document.getElementById("tabbar");
const noteSheet = document.getElementById("note-sheet");
const calSheet = document.getElementById("cal-sheet");
const calPop = document.getElementById("cal-pop");
const calSide = document.getElementById("cal-side");
const backdrop = document.getElementById("sheet-backdrop");
const EMAIL_KEY = "paper-digest.email";
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const wideScreen = matchMedia("(min-width: 700px)");       // calendar opens as a window
const sidebarScreen = matchMedia("(min-width: 1100px)");   // calendar stays on the left
const STALE_MS = 10 * 60 * 1000;   // reload the calendar and index after 10 minutes
const PAGE_SIZE = 150;             // search results shown at a time

const state = {
  user: null,
  calendar: null,            // { days: {date: {papers, highlights}}, dates: [...], loadedAt }
  index: null,               // { meta, entries, journals, loadedAt }
  library: new Map(),        // doi_key → library document (live)
  requests: new Map(),       // request ID → request document (live)
  papers: new Map(),         // doi_key → paper document (cache)
  authors: new Map(),        // OpenAlex author ID → author document (cache)
  busy: new Set(),           // doi_keys with a request being created
  optimistic: new Map(),     // doi_key → library entry shown until the write is confirmed
  page: null,                // "login" | "day" | "browse" | "paper" | "library" | "settings"
  day: null,                 // the date shown on the day page
  calMonth: null,            // "YYYY-MM" shown in the calendar
  browse: { q: "", journal: "", field: "", limit: PAGE_SIZE, scroll: 0 },
  librarySignature: "",
  navigation: 0,             // increases on every page change; stale loads are dropped
  previousHash: "",
  noteKey: null,             // paper the note sheet is for
  seen: undefined,           // settings/seen (live): {digest_date, fulltext_at}; null if missing
  appSettings: null,         // settings/app, as last read
  me: null,                  // this account's entry in the user list (users/{uid})
  summaryList: {},           // meta/summaries (live): doi_key → {language, created_at, source}
  summaries: new Map(),      // doi_key → shared summary document (cache)
  pushBusy: false,
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

const today = () => new Date().toLocaleDateString("en-CA");   // YYYY-MM-DD on this device
const fresh = (loaded) => loaded && Date.now() - loaded.loadedAt < STALE_MS;
const motion = () => (reducedMotion.matches ? "auto" : "smooth");

// A paper as this user sees it: their library entry, with the shared summary (if any) as
// `fulltext` (an imported summary of their own otherwise)
function entryOf(key) {
  const entry = state.optimistic.get(key) || state.library.get(key);
  const shared = state.summaryList[key] ? state.summaries.get(key) : null;
  if (!shared) return entry;
  return { ...(entry || { doi_key: key }), fulltext: shared };
}

function stateOf(key) {
  return {
    entry: entryOf(key),
    request: view.latestRequest(key, state.requests),
    busy: state.busy.has(key),
  };
}

// Load the shared summaries of these papers (those listed in meta/summaries)
async function loadSummaries(keys) {
  const wanted = keys.filter((k) => state.summaryList[k] && !state.summaries.get(k));
  wanted.forEach((k) => state.summaries.delete(k));   // reload changed ones
  if (wanted.length) await data.getMany("summaries", wanted, state.summaries).catch(() => {});
}

// Full-text summaries left this month (null = no limit); from this user's requests
function remainingThisMonth() {
  const limit = state.me?.monthly_limit;
  if (limit === null || limit === undefined) return null;
  const month = schedule.monthIn((state.appSettings || DEFAULT_DIGEST).timezone);
  const used = [...state.requests.values()].filter((r) => r.status === "done" && !r.reused
    && (r.processed_at || "").startsWith(month)).length;
  return Math.max(0, limit - used);
}

// Show a page: top bar, content (with a short entrance animation) and the active tab
function show(tab, bar, html, { keepScroll = false, scrollTo = 0 } = {}) {
  appbar.innerHTML = view.appBar(bar);
  const y = content.scrollTop;
  content.innerHTML = html;
  if (keepScroll) {
    content.scrollTop = y;
  } else {
    content.scrollTop = scrollTo;
    content.classList.remove("enter");
    void content.offsetWidth;   // restart the animation
    content.classList.add("enter");
  }
  for (const el of tabbar.querySelectorAll("[data-tab]")) {
    if (el.dataset.tab === tab) el.setAttribute("aria-current", "page");
    else el.removeAttribute("aria-current");
  }
  document.body.classList.toggle("page-day", state.page === "day");
}

function showLoading(tab, bar) {
  show(tab, bar, view.skeleton());
}

// ---------- Sign-in ----------

function showLogin(message = "") {
  state.page = "login";
  document.body.classList.add("signed-out");
  document.body.classList.remove("page-day");
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

async function startSession(user) {
  state.user = user;
  data.setUid(user.uid);
  // Only active users in the user list may use the app
  const me = await data.getUserEntry(user.uid).catch(() => null);
  if (state.user?.uid !== user.uid) return;
  if (!me || !me.active) {
    showNotRegistered();
    return;
  }
  state.me = me;
  view.setViewer({ admin: me.role === "admin", canRequest: me.fulltext_allowed === true });
  document.body.classList.remove("signed-out");
  const fail = (err) => toast(`Live updates stopped: ${errorText(err)}`, "error");
  state.unsubscribe = [
    data.watchLibrary((docs) => { state.library = docs; onLiveChange(); }, fail),
    data.watchMyRequests((docs) => {
      state.requests = docs;
      view.setViewer({ remaining: remainingThisMonth() });
      onLiveChange();
    }, fail),
    data.watchSeen(onSeen, fail),
    data.watchSummaryList(async (list) => {
      const changed = Object.keys(list).filter((k) => list[k]?.created_at !== state.summaryList[k]?.created_at);
      state.summaryList = list;
      changed.forEach((k) => state.summaries.delete(k));
      await loadSummaries([...content.querySelectorAll("article.paper[data-key]")].map((a) => a.dataset.key));
      onLiveChange();
    }, fail),
  ];
  data.getAppSettings().then((s) => {
    state.appSettings = s || DEFAULT_DIGEST;
    view.setViewer({ remaining: remainingThisMonth() });
  }).catch(() => {});
  push.registerWorker().then(() => push.refresh());
  ensureCalendar().then(updateIndicators).catch(() => {});
  route();
}

function showNotRegistered() {
  state.page = "login";
  document.body.classList.add("signed-out");
  appbar.innerHTML = "";
  content.innerHTML = view.notRegisteredPage(state.user?.email);
}

function endSession() {
  state.unsubscribe.forEach((stop) => stop());
  state.unsubscribe = [];
  state.user = null;
  state.library = new Map();
  state.requests = new Map();
  state.papers.clear();
  state.authors.clear();
  state.calendar = null;
  state.index = null;
  state.seen = undefined;
  state.me = null;
  state.summaryList = {};
  state.summaries.clear();
  state.appSettings = null;
  data.setUid(null);
  view.setViewer({ admin: false, canRequest: false, remaining: null });
  updateIndicators();
  closePanels();
  calSide.innerHTML = "";
}

// ---------- Routing ----------

let currentHash = "";
function route() {
  if (!state.user) return;
  state.previousHash = currentHash;
  currentHash = location.hash;
  state.navigation += 1;
  closePanels();
  const hash = location.hash;
  const day = hash.match(/^#\/day\/(\d{4}-\d{2}-\d{2})$/);
  const paper = hash.match(/^#\/paper\/(.+)$/);
  if (state.page === "browse") state.browse.scroll = content.scrollTop;
  if (day) showDay(day[1]);
  else if (paper) showPaper(paper[1]);
  else if (hash === "#/browse") showBrowse();
  else if (hash === "#/library") showLibrary();
  else if (hash === "#/settings") showSettings();
  else showDay(null);
}

window.addEventListener("hashchange", route);

// ---------- Calendar data (meta/calendar, one read) ----------

async function ensureCalendar(force = false) {
  if (!force && fresh(state.calendar)) return state.calendar;
  const meta = await data.getMeta("calendar");
  let days = meta?.days;
  if (!days) {
    // Older data without meta/calendar: the day IDs, without counts
    days = Object.fromEntries((await data.dayIds()).map((d) => [d, { papers: 0, highlights: 0 }]));
  }
  state.calendar = { days, dates: Object.keys(days).sort(), lastRun: meta?.last_run || null, loadedAt: Date.now() };
  updateIndicators();
  return state.calendar;
}

// ---------- Day page ----------

async function showDay(date) {
  const navigation = state.navigation;
  state.page = "day";
  showLoading("today", { date: date || "" });
  try {
    const cal = await ensureCalendar(!date);   // the latest day: check for a new digest
    if (!date) date = cal.dates.at(-1);
    if (navigation !== state.navigation) return;
    state.day = date || null;
    renderSide();
    if (!date) {
      show("today", { date: "" }, '<p class="empty">No digest yet.</p>');
      return;
    }
    const bar = {
      date,
      prev: cal.dates.filter((d) => d < date).at(-1),
      next: cal.dates.find((d) => d > date),
    };
    appbar.innerHTML = view.appBar(bar);
    const day = await data.getDay(date);
    if (navigation !== state.navigation) return;
    if (!day) {
      show("today", bar, '<p class="empty">No digest for this day.</p>');
      return;
    }
    const papers = (await data.getMany("papers", day.paper_keys || [], state.papers)).filter(Boolean);
    await loadSummaries(day.paper_keys || []);
    const fields = day.fields?.length ? day.fields : DEFAULT_FIELDS;
    if (navigation !== state.navigation) return;
    show("today", bar, view.dayPage(day, papers, fields, stateOf));
    document.title = `Paper digest ${date}`;
    markDaySeen(date);
  } catch (err) {
    if (navigation === state.navigation) {
      show("today", { date: date || "" }, `<p class="empty">Could not load the digest. ${view.e(errorText(err))}</p>`);
    }
  }
}

// ---------- Calendar (sheet on phones, window on wider screens, sidebar on wide ones) ----------

function calendarHtml() {
  const month = state.calMonth || (state.day || today()).slice(0, 7);
  return view.calendar(month, state.calendar?.days || {}, state.day, today());
}

function renderSide() {
  calSide.innerHTML = state.calendar ? calendarHtml() : "";
}

async function openCalendar() {
  if (!state.calendar) await ensureCalendar().catch(() => null);
  state.calMonth = (state.day || today()).slice(0, 7);
  if (sidebarScreen.matches && state.page === "day") {
    renderSide();
    calSide.querySelector(".cal-day.selected, .cal-day.today")?.focus?.();
    return;
  }
  closePanels();
  if (wideScreen.matches) {
    calPop.innerHTML = calendarHtml();
    calPop.hidden = false;
    requestAnimationFrame(() => calPop.classList.add("open"));
    calPop.querySelector("[data-date].selected, [data-cal='today']")?.focus();
  } else {
    calSheet.innerHTML = '<div class="sheet-grip" aria-hidden="true"></div>' + calendarHtml();
    openSheet(calSheet);
  }
}

function moveMonth(step) {
  const [y, m] = (state.calMonth || today().slice(0, 7)).split("-").map(Number);
  const d = new Date(y, m - 1 + step, 1);
  state.calMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// Clicks inside any calendar container
function onCalendarClick(ev) {
  const container = ev.currentTarget;
  const control = ev.target.closest("[data-cal]");
  const day = ev.target.closest("[data-date]");
  if (control) {
    const what = control.dataset.cal;
    if (what === "prev") moveMonth(-1);
    if (what === "next") moveMonth(1);
    if (what === "today") {
      state.calMonth = today().slice(0, 7);
      if (state.calendar?.days[today()]) {
        location.hash = `#/day/${today()}`;
        return;
      }
    }
    const grip = container === calSheet ? '<div class="sheet-grip" aria-hidden="true"></div>' : "";
    container.innerHTML = grip + calendarHtml();
  } else if (day) {
    closePanels();
    location.hash = `#/day/${day.dataset.date}`;
  }
}
for (const el of [calSheet, calPop, calSide]) el.addEventListener("click", onCalendarClick);

// A sheet or window opened for one screen width is closed when the width changes
wideScreen.addEventListener("change", closePanels);
sidebarScreen.addEventListener("change", () => { closePanels(); renderSide(); });

// Clicking outside the calendar window closes it
document.addEventListener("click", (ev) => {
  if (!calPop.hidden && !calPop.contains(ev.target) && !ev.target.closest('[data-act="calendar"]')) closePanels();
});

// ---------- Browse (paper index: meta/index + index/{shard}) ----------

async function ensureIndex(force = false) {
  if (!force && fresh(state.index)) return state.index;
  const meta = (await data.getMeta("index")) || { shards: {}, journals: {}, fields: [] };
  const ids = Object.values(meta.shards || {}).flat();
  const shards = await Promise.all(ids.map((id) => data.getIndexShard(id)));
  const byKey = new Map();
  for (const entry of shards.flat()) byKey.set(entry.doi_key, entry);
  const names = meta.journals || {};
  const counts = new Map();
  const entries = [...byKey.values()].map((x) => {
    counts.set(x.journal_abbr, (counts.get(x.journal_abbr) || 0) + 1);
    return {
      ...x,
      // what search looks at: title, authors, journal, one-liner, topic tags (lower case)
      hay: [x.title, ...(x.authors || []), x.journal_abbr, names[x.journal_abbr], x.one_liner,
        ...(x.topic_tags || [])].filter(Boolean).join("\n").toLowerCase(),
      sortKey: `${x.published_date || ""}|${(x.appeared_in || [""])[0]}`,
    };
  }).sort((a, b) => b.sortKey.localeCompare(a.sortKey));
  const journals = [...counts].filter(([abbr]) => abbr)
    .map(([abbr, count]) => ({ abbr, name: names[abbr] || abbr, count }))
    .sort((a, b) => a.name.localeCompare(b.name));
  state.index = { meta, entries, journals, loadedAt: Date.now() };
  return state.index;
}

async function showBrowse() {
  const navigation = state.navigation;
  const returning = state.previousHash.startsWith("#/paper/");
  state.page = "browse";
  document.title = "Browse";
  showLoading("browse", { title: "Browse" });
  try {
    const index = await ensureIndex();
    if (navigation !== state.navigation) return;
    show("browse", { title: "Browse" },
      view.browseBar(index.meta, index.journals, state.browse) + '<div id="browse-list"></div>',
      { scrollTo: 0 });
    if (!returning) state.browse.limit = PAGE_SIZE;
    renderBrowseList();
    if (returning) content.scrollTop = state.browse.scroll;
  } catch (err) {
    if (navigation === state.navigation) {
      show("browse", { title: "Browse" }, `<p class="empty">Could not load the paper index. ${view.e(errorText(err))}</p>`);
    }
  }
}

function browseMatches() {
  const { q, journal, field } = state.browse;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return state.index.entries.filter((x) => (!journal || x.journal_abbr === journal)
    && (!field || (x.field || "other") === field)
    && words.every((w) => x.hay.includes(w)));
}

function renderBrowseList() {
  const list = document.getElementById("browse-list");
  if (!list || !state.index) return;
  const { q, journal, field, limit } = state.browse;
  if (!q.trim() && !journal && !field) {
    list.innerHTML = view.journalList(state.index.journals);
    return;
  }
  const matches = browseMatches();
  const shown = matches.slice(0, limit);
  const isSaved = (key) => Boolean(stateOf(key).entry?.saved);
  list.innerHTML = view.resultRows(shown, matches.length, state.index.meta.highlight_threshold ?? 7, isSaved,
    Math.min(PAGE_SIZE, matches.length - shown.length));
}

// Typing filters as you go (redrawn once per frame)
let browseFrame = 0;
content.addEventListener("input", (ev) => {
  if (state.page !== "browse" || ev.target.name !== "q") return;
  state.browse.q = ev.target.value;
  state.browse.limit = PAGE_SIZE;
  cancelAnimationFrame(browseFrame);
  browseFrame = requestAnimationFrame(renderBrowseList);
});

content.addEventListener("change", (ev) => {
  if (state.page !== "browse" || !["journal", "field"].includes(ev.target.name)) return;
  state.browse[ev.target.name] = ev.target.value;
  state.browse.limit = PAGE_SIZE;
  renderBrowseList();
});

// The search box: Enter / Search closes the keyboard
content.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && ev.target.name === "q") ev.target.blur();
});

// ---------- One paper (from Browse) ----------

async function showPaper(key) {
  const navigation = state.navigation;
  state.page = "paper";
  const bar = { title: "Paper", back: state.previousHash.startsWith("#/day/") ? "Digest" : "Browse" };
  showLoading("browse", bar);
  try {
    const [paper] = await data.getMany("papers", [key], state.papers);
    await loadSummaries([key]);
    const index = await ensureIndex().catch(() => null);
    if (navigation !== state.navigation) return;
    if (!paper) {
      show("browse", bar, '<p class="empty">This paper is not in the database.</p>');
      return;
    }
    const meta = index?.meta || {};
    const fieldList = meta.fields?.length ? meta.fields : DEFAULT_FIELDS;
    const ctx = { highlight_threshold: meta.highlight_threshold ?? 7, languages: meta.languages || {} };
    show("browse", bar, view.paperPage(paper, ctx, new Map(fieldList.map((f) => [f.id, f.name])), stateOf(key)));
    document.title = paper.title || "Paper";
  } catch (err) {
    if (navigation === state.navigation) {
      show("browse", bar, `<p class="empty">Could not load the paper. ${view.e(errorText(err))}</p>`);
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
    await loadSummaries([...state.library.keys()]);
    if (navigation === state.navigation) {
      renderLibrary(false);
      markFulltextSeen();
    }
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
    html: view.libraryCard(state.papers.get(entry.doi_key) || { doi_key: entry.doi_key }, entryOf(entry.doi_key), stateOf(entry.doi_key)),
  }))]));
  // keep open panels across a re-render
  const open = new Set([...content.querySelectorAll("details[open]")].map(detailsId));
  show("library", { title: "Library" },
    view.libraryPage(htmlGroups, { saved: saved.length, fulltext: saved.filter((x) => entryOf(x.doi_key)?.fulltext).length }),
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
      await loadSummaries([...state.library.keys()]);
      if (state.page === "library") renderLibrary(true);
      return;
    }
  }
  if (["day", "library", "paper"].includes(state.page)) refreshCards();
  if (state.page === "browse") refreshMarks();
  updateIndicators();
  if (state.page === "library") markFulltextSeen();
}

// ---------- What has been seen: tab dots and the icon badge ----------
// settings/seen (shared by all devices): digest_date = the latest day viewed,
// fulltext_at = when the Library was last viewed.

function onSeen(doc) {
  state.seen = doc;
  // First use: start counting full-text summaries from now
  if (!doc?.fulltext_at) data.markSeen({ fulltext_at: data.isoNow() }).catch(() => {});
  updateIndicators();
}

// Days after the latest one viewed (if never viewed: only the latest day)
function unseenDays() {
  const dates = state.calendar?.dates || [];
  if (!dates.length || state.seen === undefined) return [];
  const seen = state.seen?.digest_date ?? (dates.at(-2) || "");
  return dates.filter((d) => d > seen);
}

function unseenFulltext() {
  const since = Date.parse(state.seen?.fulltext_at || "");
  if (!since) return false;
  return [...state.library.values()].some((x) => x.saved && Date.parse(
    state.summaryList[x.doi_key]?.created_at || x.fulltext?.created_at || "") > since);
}

function updateIndicators() {
  const days = unseenDays();
  const papers = days.reduce((n, d) => n + (state.calendar?.days[d]?.papers || 0), 0);
  tabbar.querySelector('[data-tab="today"]').classList.toggle("has-dot", days.length > 0);
  tabbar.querySelector('[data-tab="library"]').classList.toggle("has-dot", state.user ? unseenFulltext() : false);
  push.setBadge(state.user ? papers : 0);
}

function markDaySeen(date) {
  if (state.seen === undefined || date <= (state.seen?.digest_date || "")) return;
  state.seen = { ...(state.seen || {}), digest_date: date };
  updateIndicators();
  data.markSeen({ digest_date: date }).catch(() => {});
}

function markFulltextSeen() {
  if (!unseenFulltext()) return;
  const now = data.isoNow();
  state.seen = { ...(state.seen || {}), fulltext_at: now };
  updateIndicators();
  data.markSeen({ fulltext_at: now }).catch(() => {});
}

// Saved marks in the Browse list
function refreshMarks() {
  for (const mark of content.querySelectorAll("[data-mark]")) {
    mark.innerHTML = stateOf(mark.dataset.mark).entry?.saved ? view.ICONS.bookmarkFilled : "";
  }
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
      openNote(paper);
    } else if (what === "request") {
      const request = view.latestRequest(key, state.requests);
      if (state.busy.has(key) || ["pending", "processing"].includes(request?.status) || entryOf(key)?.fulltext) return;
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
    document.getElementById(jump.dataset.jump)?.scrollIntoView({ behavior: motion() });
    return;
  }
  const journal = ev.target.closest("[data-journal]");
  if (journal) {
    state.browse.journal = journal.dataset.journal;
    state.browse.limit = PAGE_SIZE;
    const select = content.querySelector('select[name="journal"]');
    if (select) select.value = state.browse.journal;
    renderBrowseList();
    content.scrollTo({ top: 0 });
    return;
  }
  const button = ev.target.closest("button[data-act]");
  if (button?.dataset.act === "more") {
    state.browse.limit += PAGE_SIZE;
    renderBrowseList();
    return;
  }
  const card = button?.closest("article.paper[data-key]");
  if (button && card) act(button, card);
  if (button?.dataset.act === "signout") {
    endSession();
    data.signOutUser();
  }
});

appbar.addEventListener("click", (ev) => {
  const button = ev.target.closest("[data-act]");
  if (button?.dataset.act === "calendar") {
    if (!calPop.hidden) closePanels();
    else openCalendar();
  }
  if (button?.dataset.act === "back") {
    if (state.previousHash && state.previousHash !== currentHash) history.back();
    else location.hash = "#/browse";
  }
});

// Tapping the active tab again scrolls back to the top
tabbar.addEventListener("click", (ev) => {
  const tab = ev.target.closest("[data-tab]");
  if (tab?.getAttribute("aria-current") === "page" && location.hash === tab.getAttribute("href")) {
    ev.preventDefault();
    content.scrollTo({ top: 0, behavior: motion() });
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

// ---------- Sheets and the calendar window ----------

function openSheet(el) {
  el.hidden = false;
  backdrop.hidden = false;
  requestAnimationFrame(() => {
    el.classList.add("open");
    backdrop.classList.add("open");
  });
}

function closePanels() {
  state.noteKey = null;
  for (const el of [noteSheet, calSheet, calPop]) {
    if (el.hidden) continue;
    el.classList.remove("open");
    const hide = () => { if (!el.classList.contains("open")) el.hidden = true; };
    if (reducedMotion.matches || el === calPop) hide();
    else setTimeout(hide, 250);
  }
  backdrop.classList.remove("open");
  const hideBackdrop = () => { if (!backdrop.classList.contains("open")) backdrop.hidden = true; };
  if (reducedMotion.matches) hideBackdrop();
  else setTimeout(hideBackdrop, 250);
}

backdrop.addEventListener("click", closePanels);
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") closePanels();
  // ⌘/Ctrl + Enter adds the note
  if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey) && !noteSheet.hidden) noteSheet.requestSubmit();
});

// ---------- Note sheet ----------

function openNote(paper) {
  state.noteKey = paper.doi_key;
  noteSheet.querySelector(".sheet-paper").textContent = paper.title || paper.doi || "";
  openSheet(noteSheet);
  requestAnimationFrame(() => noteSheet.elements.text.focus());
}

noteSheet.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const text = noteSheet.elements.text.value.trim();
  const paper = state.papers.get(state.noteKey);
  if (!text || !paper) return;
  noteSheet.elements.text.value = "";
  closePanels();
  toast("Note added");
  try {
    await withOptimistic(paper.doi_key, (e) => ({ notes: [...(e.notes || []), { at: data.isoNow(), text }] }),
      () => data.addNote(paper, text));
  } catch (err) {
    toast(`Could not save the note: ${errorText(err)}`, "error");
    openNote(paper);
    noteSheet.elements.text.value = text;   // give the text back
  }
});

noteSheet.addEventListener("click", (ev) => {
  if (ev.target.closest('[data-act="sheet-cancel"]')) closePanels();
});

// ---------- Settings ----------

// Defaults when settings/app does not exist yet (the repository's settings.yaml values)
const DEFAULT_DIGEST = { digest_time: "05:00", timezone: "America/Los_Angeles" };

async function showSettings() {
  const navigation = state.navigation;
  state.page = "settings";
  document.title = "Settings";
  show("settings", { title: "Settings" }, view.settingsPage(state.user.email));
  bindPinForm();
  try {
    const [saved, choices] = await Promise.all([data.getAppSettings(), data.getNotifyChoices(), ensureCalendar(true)]);
    if (navigation !== state.navigation) return;
    const current = saved || DEFAULT_DIGEST;
    state.appSettings = current;
    state.notifyChoices = choices;
    if (state.me?.role === "admin") renderDigest(current.digest_time, current.timezone, Boolean(saved));
    await renderNotify();
    if (state.me?.role === "admin") await renderMembers();
  } catch (err) {
    if (navigation === state.navigation) {
      content.querySelector("#digest-section").innerHTML = `<p class="msg">Could not load the digest time. ${view.e(errorText(err))}</p>`;
    }
  }
}

function renderDigest(time, timezone, fromApp) {
  const section = content.querySelector("#digest-section");
  if (!section) return;
  section.innerHTML = view.digestSettings({
    time, timezone, fromApp,
    times: schedule.timeOptions(),
    zones: schedule.timezoneOptions(),
    next: schedule.nextRunText(time, timezone, state.calendar?.lastRun),
    last: schedule.lastRunText(state.calendar?.lastRun, timezone),
  });
  const form = section.querySelector("#digest-form");
  // The "next run" line follows the choices before saving
  form.addEventListener("change", () => {
    form.querySelector("[data-next]").textContent = schedule.nextRunText(form.elements.time.value,
      form.elements.timezone.value, state.calendar?.lastRun);
  });
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const msg = form.querySelector(".msg");
    const newTime = form.elements.time.value;
    const newZone = form.elements.timezone.value;
    msg.classList.remove("ok");
    if (!schedule.validTime(newTime) || !schedule.validTimezone(newZone)) {
      msg.textContent = "Choose a time and a time zone from the lists.";
      return;
    }
    msg.textContent = "Saving…";
    try {
      await data.saveAppSettings(newTime, newZone);
      state.appSettings = { ...(state.appSettings || {}), digest_time: newTime, timezone: newZone };
      toast("Saved");
      renderDigest(newTime, newZone, true);
      const after = content.querySelector("#digest-form .msg");
      after.textContent = `Saved. Next run: ${schedule.nextRunText(newTime, newZone, state.calendar?.lastRun)}`;
      after.classList.add("ok");
    } catch (err) {
      msg.textContent = `Could not save: ${errorText(err)}`;
    }
  });
}

async function renderNotify() {
  const section = content.querySelector("#notify-section");
  if (!section) return;
  const s = state.notifyChoices || {};
  section.innerHTML = view.notifySection({
    status: await push.status(), platform: push.platformName(), busy: state.pushBusy,
    digestOn: s.notify_digest !== false, emptyOn: s.notify_empty !== false, fulltextOn: s.notify_fulltext !== false,
  });
}

content.addEventListener("change", async (ev) => {
  const kind = ev.target.dataset?.notify;
  if (!kind || state.page !== "settings") return;
  const on = ev.target.checked;
  try {
    await data.saveNotifyChoice(kind, on);
    state.notifyChoices = { ...(state.notifyChoices || {}), [`notify_${kind}`]: on };
    toast(on ? "Turned on" : "Turned off");
    if (kind === "digest") await renderNotify();   // the no-new-papers switch depends on it
  } catch (err) {
    ev.target.checked = !on;
    toast(`Could not save: ${errorText(err)}`, "error");
  }
});

content.addEventListener("click", async (ev) => {
  const what = ev.target.closest("button[data-act]")?.dataset.act;
  if (!what?.startsWith("push-") || state.page !== "settings") return;
  try {
    if (what === "push-enable" || what === "push-disable") {
      state.pushBusy = true;
      await renderNotify();
      if (what === "push-enable") {
        const result = await push.enable();
        toast(result === "enabled" ? "Notifications enabled" : result === "blocked" ? "Notifications are blocked" : "Not enabled");
      } else {
        await push.disable();
        toast("This device was removed");
      }
    } else if (what === "push-test") {
      await push.testNotification();
    }
  } catch (err) {
    toast(`Notifications: ${errorText(err)}`, "error");
  } finally {
    state.pushBusy = false;
    await renderNotify();
  }
});

// ---------- Members (admins) ----------

async function renderMembers() {
  const section = content.querySelector("#members-section");
  if (!section) return;
  try {
    const [people, requests] = await Promise.all([data.listUsers(), data.allRequests()]);
    const month = schedule.monthIn((state.appSettings || DEFAULT_DIGEST).timezone);
    const used = (id) => requests.filter((r) => r.uid === id && r.status === "done" && !r.reused
      && (r.processed_at || "").startsWith(month)).length;
    const users = [...people].map(([id, u]) => ({ uid: id, ...u, used: used(id) }))
      .sort((a, b) => (a.role === "admin" ? 0 : 1) - (b.role === "admin" ? 0 : 1) || (a.display_name || "").localeCompare(b.display_name || ""));
    state.members = new Map(users.map((u) => [u.uid, u]));
    section.innerHTML = view.membersSection({ users, me: state.user.uid });
  } catch (err) {
    section.innerHTML = `<p class="msg">Could not load the members. ${view.e(errorText(err))}</p>`;
  }
}

const parseLimit = (value) => (String(value).trim() === "" ? null : Math.max(0, Math.min(1000, Math.round(Number(value)))));

// Changing a member: display name, active, full-text summaries, monthly limit (saved at once)
content.addEventListener("change", async (ev) => {
  const field = ev.target.dataset?.member;
  const row = ev.target.closest("[data-uid]");
  if (!field || !row || state.page !== "settings") return;
  const value = field === "monthly_limit" ? parseLimit(ev.target.value)
    : field === "display_name" ? ev.target.value.trim() : ev.target.checked;
  if (field === "monthly_limit" && value !== null && Number.isNaN(value)) {
    toast("Enter a whole number, or leave it empty for no limit", "error");
    return;
  }
  if (field === "display_name" && (!value || value.length > 60)) {
    toast("Enter a display name (up to 60 characters)", "error");
    await renderMembers();
    return;
  }
  try {
    await data.updateUser(row.dataset.uid, { [field]: value });
    toast("Saved");
  } catch (err) {
    toast(`Could not save: ${errorText(err)}`, "error");
  }
  await renderMembers();
});

content.addEventListener("submit", async (ev) => {
  if (ev.target.id !== "member-form") return;
  ev.preventDefault();
  const form = ev.target;
  const msg = form.querySelector(".msg");
  const id = form.elements.uid.value.trim();
  const name = form.elements.name.value.trim();
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(id)) { msg.textContent = "Paste the UID from the Firebase console."; return; }
  if (!name) { msg.textContent = "Enter a display name."; return; }
  if (state.members?.has(id)) { msg.textContent = "This UID is already a member."; return; }
  msg.textContent = "Adding…";
  try {
    await data.addUser(id, {
      displayName: name, fulltextAllowed: form.elements.allowed.checked,
      monthlyLimit: parseLimit(form.elements.limit.value),
    });
    toast("Member added");
    await renderMembers();
  } catch (err) {
    msg.textContent = `Could not add: ${errorText(err)}`;
  }
});

function bindPinForm() {
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

// Coming back to the app after a while: the next page load re-reads the calendar and index
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.calendar && !fresh(state.calendar) && state.page === "day") {
    ensureCalendar(true).then(renderSide).catch(() => {});
  }
});

data.watchUser((user) => {
  if (user) {
    if (state.user?.uid !== user.uid) startSession(user);
  } else {
    endSession();
    showLogin();
  }
});
