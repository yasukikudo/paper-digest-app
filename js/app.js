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
const sideNav = document.getElementById("side-nav");
const sideToc = document.getElementById("side-toc-box");
const VIEW_KEY = "paper-digest.day-view";   // "cards" or "compact", remembered on this device
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
  browse: { q: "", journal: "__mine__", field: "", limit: PAGE_SIZE, scroll: 0 },
  librarySignature: "",
  navigation: 0,             // increases on every page change; stale loads are dropped
  previousHash: "",
  noteKey: null,             // paper the note sheet is for
  seen: undefined,           // settings/seen (live): {digest_date, fulltext_at}; null if missing
  appSettings: null,         // settings/app, as last read
  me: null,                  // this account's entry in the user list (users/{uid})
  summaryList: {},           // meta/summaries (live): doi_key → {language, created_at, source}
  summaries: new Map(),      // doi_key → shared summary document (cache)
  prefs: null,               // users/{uid}/settings/prefs: journals, fields, language, onboarded
  journals: new Map(),       // journals/{id} (the journals that can be followed)
  languages: {},             // settings/languages: {code: name}
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
// Abbreviations of the journals this user follows (every journal if they have not chosen)
function myAbbrs() {
  const chosen = state.prefs?.journals;
  const ids = Array.isArray(chosen) ? chosen : [...state.journals.keys()];
  return new Set(ids.map((id) => state.journals.get(id)?.abbr).filter(Boolean));
}

// The language full-text summaries are made in for this user (English if none chosen)
const summaryLanguage = () => (state.prefs?.language && state.languages[state.prefs.language] ? state.prefs.language : "en");

// {code: summary} of a summaries document (documents from before schema version 11 included)
function summaryLanguages(doc) {
  if (!doc) return {};
  const langs = { ...(doc.languages || {}) };
  if (doc.sections && doc.language && !langs[doc.language]) langs[doc.language] = doc;
  return langs;
}

function entryOf(key) {
  const entry = state.optimistic.get(key) || state.library.get(key);
  const langs = state.summaryList[key] ? summaryLanguages(state.summaries.get(key)) : {};
  const own = langs[summaryLanguage()];
  const shared = own || Object.values(langs)[0];
  // hasOwnSummary: a summary in the user's language (or an imported one) exists, so no request
  const hasOwnSummary = Boolean(own || (entry?.fulltext && !shared));
  if (!shared) return entry ? { ...entry, hasOwnSummary } : entry;
  return { ...(entry || { doi_key: key }), fulltext: shared, hasOwnSummary };
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
  for (const el of [...tabbar.querySelectorAll("[data-tab]"), ...sideNav.querySelectorAll("[data-tab]")]) {
    if (el.dataset.tab === tab) el.setAttribute("aria-current", "page");
    else el.removeAttribute("aria-current");
  }
  document.body.classList.toggle("page-day", state.page === "day");
  if (state.page !== "day") sideToc.innerHTML = "";
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
  try {
    const [prefs, journals, languages] = await Promise.all([data.getPrefs(), data.listJournals(), data.getLanguages()]);
    state.prefs = prefs;
    state.journals = journals;
    state.languages = languages;
  } catch (err) {
    toast(`Could not load your settings: ${errorText(err)}`, "error");
  }
  applyPrefs();
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

// The user's preferences in the views (favourite fields, language, journals in the calendar)
function applyPrefs() {
  view.setViewer({
    favFields: new Set(state.prefs?.fields || []),
    language: state.prefs?.language && state.languages[state.prefs.language] ? state.prefs.language : null,
    languageNames: state.languages,
    fieldNames: new Map(DEFAULT_FIELDS.map((f) => [f.id, f.name])),
  });
  viewCalendar();
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
  state.prefs = null;
  state.journals = new Map();
  state.languages = {};
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
  if (!state.user || !state.me) return;
  if (!state.prefs?.onboarded) {   // new users choose journals, fields and a language first
    showOnboarding();
    return;
  }
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
  else if (hash.startsWith("#/settings/")) showSettingsSection(hash.slice("#/settings/".length));
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
  state.calendar = { all: days, lastRun: meta?.last_run || null, loadedAt: Date.now() };
  viewCalendar();
  return state.calendar;
}

// The calendar as this user sees it: only days with papers in their journals, counted in
// those journals (highlights only for admins)
function viewCalendar() {
  if (!state.calendar) return;
  const mine = myAbbrs();
  const admin = state.me?.role === "admin";
  const days = {};
  for (const [date, d] of Object.entries(state.calendar.all)) {
    let papers = d.papers || 0;
    let highlights = d.highlights || 0;
    if (d.by_journal) {
      const counts = Object.entries(d.by_journal).filter(([abbr]) => mine.has(abbr)).map(([, c]) => c);
      papers = counts.reduce((n, c) => n + c[0], 0);
      highlights = counts.reduce((n, c) => n + c[1], 0);
    }
    if (papers > 0) days[date] = { papers, highlights: admin ? highlights : 0 };
  }
  state.calendar.days = days;
  state.calendar.dates = Object.keys(days).sort();
  updateIndicators();
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
      show("today", { date: "" }, '<p class="empty">No papers from your journals yet.</p>');
      return;
    }
    const bar = {
      date,
      today: today(),
      prev: cal.dates.filter((d) => d < date).at(-1),
      next: cal.dates.find((d) => d > date),
    };
    state.dayBar = bar;
    appbar.innerHTML = view.appBar(bar);
    const day = await data.getDay(date);
    if (navigation !== state.navigation) return;
    if (!day) {
      show("today", bar, '<p class="empty">No digest for this day.</p>');
      return;
    }
    // Only the journals this user follows
    const mine = myAbbrs();
    const all = (await data.getMany("papers", day.paper_keys || [], state.papers)).filter(Boolean);
    const papers = all.filter((p) => mine.has(p.journal_abbr));
    await loadSummaries(papers.map((p) => p.doi_key));
    const fields = day.fields?.length ? day.fields : DEFAULT_FIELDS;
    if (navigation !== state.navigation) return;
    if (!papers.length) {
      show("today", bar, '<p class="empty">No papers from your journals on this day.</p>');
      markDaySeen(date);
      return;
    }
    const threshold = day.highlight_threshold ?? 7;
    const mineDay = { ...day, paper_count: papers.length,
      highlight_count: papers.filter((p) => (p.relevance ?? 0) >= threshold).length };
    state.dayView = { day: mineDay, papers, fields };
    renderDayView(bar);
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

// The day's papers as cards or compact rows, and its fields in the sidebar (wide screens)
function renderDayView(bar = state.dayBar, keepScroll = false) {
  const { day, papers, fields } = state.dayView;
  const compact = storageGet(VIEW_KEY) === "compact";
  show("today", bar, view.dayPage(day, papers, fields, stateOf, compact), { keepScroll });
  sideToc.innerHTML = view.sideToc(view.groupPapers(papers, fields));
  markCurrentField();
}

// The field whose heading is at the top of the page (highlighted in the sidebar)
function markCurrentField() {
  const links = sideToc.querySelectorAll("[data-jump]");
  if (!links.length) return;
  const top = content.getBoundingClientRect().top + parseFloat(getComputedStyle(content).paddingTop) + 24;
  let current = null;
  for (const group of content.querySelectorAll(".group[id]")) {
    if (group.getBoundingClientRect().top <= top) current = group.id;
  }
  current = current || content.querySelector(".group[id]")?.id;
  links.forEach((a) => (a.dataset.jump === current ? a.setAttribute("aria-current", "true") : a.removeAttribute("aria-current")));
}

let spyFrame = 0;
content.addEventListener("scroll", () => {
  if (state.page !== "day") return;
  cancelAnimationFrame(spyFrame);
  spyFrame = requestAnimationFrame(markCurrentField);
}, { passive: true });

sideToc.addEventListener("click", (ev) => {
  const jump = ev.target.closest("[data-jump]");
  if (!jump) return;
  ev.preventDefault();
  document.getElementById(jump.dataset.jump)?.scrollIntoView({ behavior: motion() });
});

function storageGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function storageSet(key, value) { try { localStorage.setItem(key, value); } catch { /* not available */ } }

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
  const mine = myAbbrs();
  return state.index.entries.filter((x) => (!journal || (journal === "__mine__" ? mine.has(x.journal_abbr) : x.journal_abbr === journal))
    && (!field || (x.field || "other") === field)
    && words.every((w) => x.hay.includes(w)));
}

function renderBrowseList() {
  const list = document.getElementById("browse-list");
  if (!list || !state.index) return;
  const { q, journal, field, limit } = state.browse;
  if (!q.trim() && !field && (!journal || journal === "__mine__")) {
    const mine = myAbbrs();
    list.innerHTML = view.journalList(journal ? state.index.journals.filter((j) => mine.has(j.abbr)) : state.index.journals);
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
  const bar = { title: "Paper", back: "Browse" };
  state.backHash = "#/browse";
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
  const papers = days.reduce((n, d) => n + (state.calendar?.days?.[d]?.papers || 0), 0);
  for (const nav of [tabbar, sideNav]) {
    nav.querySelector('[data-tab="today"]').classList.toggle("has-dot", days.length > 0);
    nav.querySelector('[data-tab="library"]').classList.toggle("has-dot", state.user ? unseenFulltext() : false);
  }
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
    slot("meta").innerHTML = view.cardMeta(paper, s.entry, { library: Boolean(card.dataset.library) });
    slot("actions").innerHTML = view.actions(paper, s.entry, s.request, s.busy);
    slot("notes").innerHTML = view.notesList(s.entry);
    const ft = s.entry?.fulltext;
    const signature = ft ? `${ft.created_at}|${ft.source}|${ft.language}` : "";
    const ftSlot = slot("fulltext");
    if ((ftSlot.dataset.signature || "") !== signature) {
      ftSlot.innerHTML = view.fulltextBody(s.entry);
      ftSlot.dataset.signature = signature;
      card.querySelector('[role="tab"][data-tab="ft"]').hidden = !ft;
    }
    const oneLiner = slot("oneliner");
    if (oneLiner && card.dataset.library) {
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
      if (state.busy.has(key) || ["pending", "processing"].includes(request?.status) || entryOf(key)?.hasOwnSummary) return;
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
    const target = state.backHash || "#/browse";
    if (state.previousHash === target) history.back();
    else location.hash = target;
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
async function loadAuthors(pane) {
  if (!pane || pane.dataset.loaded) return;
  const paper = state.papers.get(pane.closest("[data-key]").dataset.key);
  if (!paper) return;
  pane.dataset.loaded = "1";
  const ids = (paper.authorships || []).map((a) => a.author_id).filter(Boolean);
  try {
    await data.getMany("authors", ids, state.authors);
  } catch { /* names and affiliations are shown without the numbers */ }
  pane.innerHTML = view.authorsBody(paper, state.authors);
}

// Opening "Details" shows the selected tab (authors are loaded when their tab is shown)
content.addEventListener("toggle", (ev) => {
  const details = ev.target;
  if (!details.matches?.("details.more") || !details.open) return;
  const pane = details.querySelector(".pane:not([hidden])");
  if (pane?.dataset.pane === "au") loadAuthors(pane);
}, true);

// Tabs inside "Details"; the Cards / Compact switch; opening a compact row
content.addEventListener("click", (ev) => {
  const tab = ev.target.closest('[role="tab"][data-tab]');
  if (tab) {
    const details = tab.closest("details");
    for (const b of details.querySelectorAll('[role="tab"]')) b.setAttribute("aria-selected", String(b === tab));
    for (const pane of details.querySelectorAll(".pane")) pane.hidden = pane.dataset.pane !== tab.dataset.tab;
    if (tab.dataset.tab === "au") loadAuthors(details.querySelector('[data-pane="au"]'));
    return;
  }
  const mode = ev.target.closest('[data-act="view-mode"]');
  if (mode && state.dayView) {
    storageSet(VIEW_KEY, mode.dataset.mode);
    renderDayView(state.dayBar, true);
    return;
  }
  const row = ev.target.closest("[data-expand]");
  if (row && state.dayView) {
    const p = state.papers.get(row.dataset.expand);
    if (!p) return;
    const fieldNames = new Map(state.dayView.fields.map((f) => [f.id, f.name]));
    row.outerHTML = view.dayCard(p, state.dayView.day, fieldNames, stateOf(p.doi_key));
  }
});

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
const DEFAULT_DIGEST = { digest_time: "05:00", timezone: "America/Chicago" };

const ADMIN_PAGES = new Set(["digest", "members", "journal-list", "languages"]);
const NOTIFY_LABELS = { enabled: "On", off: "Off", blocked: "Blocked", unsupported: "Not supported", "ios-browser": "Home Screen app only" };

// Settings: a list of items with their current values; each opens its own page
async function showSettings() {
  const navigation = state.navigation;
  state.page = "settings";
  state.settingsSection = null;
  document.title = "Settings";
  const admin = state.me?.role === "admin";
  const menu = (values) => view.settingsMenu({ email: state.user.email, admin, values });
  show("settings", { title: "Settings" }, menu({}));
  try {
    const chosen = state.prefs?.journals || [...state.journals.keys()];
    const fieldNames = new Map(DEFAULT_FIELDS.map((f) => [f.id, f.name]));
    const favs = (state.prefs?.fields || []).map((f) => fieldNames.get(f) || f);
    const values = {
      journals: `${chosen.filter((id) => state.journals.has(id)).length} of ${state.journals.size}`,
      fields: favs.length ? (favs.length > 1 ? `${favs.length} fields` : favs[0]) : "None",
      language: state.languages[state.prefs?.language] || "None",
      notifications: NOTIFY_LABELS[await push.status()] || "",
    };
    if (admin) {
      const [app, people] = await Promise.all([data.getAppSettings(), data.listUsers()]);
      const s = app || DEFAULT_DIGEST;
      state.appSettings = s;
      const time = schedule.timeOptions().find(([v]) => v === s.digest_time)?.[1] || s.digest_time;
      values.digest = `${time} · ${s.timezone.split("/").pop().replace(/_/g, " ")}`;
      const active = [...people.values()].filter((u) => u.active).length;
      values.members = `${active} active`;
      const paused = [...state.journals.values()].filter((j) => !j.active).length;
      values.journalList = `${state.journals.size}${paused ? ` · ${paused} paused` : ""}`;
      values.languages = Object.values(state.languages).sort().join(", ") || "None";
    }
    if (navigation === state.navigation) {
      const y = content.scrollTop;
      content.innerHTML = menu(values);
      content.scrollTop = y;
    }
  } catch (err) {
    toast(`Could not load the settings: ${errorText(err)}`, "error");
  }
}

async function showSettingsSection(id) {
  const navigation = state.navigation;
  const admin = state.me?.role === "admin";
  if (!view.SETTINGS_PAGES[id] || (ADMIN_PAGES.has(id) && !admin)) {
    location.hash = "#/settings";
    return;
  }
  state.page = "settings";
  state.settingsSection = id;
  state.backHash = "#/settings";
  document.title = view.SETTINGS_PAGES[id];
  show("settings", { title: view.SETTINGS_PAGES[id], back: "Settings" }, view.settingsSection(id));
  try {
    if (id === "pin") bindPinForm();
    else if (["journals", "fields", "language"].includes(id)) renderPrefs();
    else if (id === "notifications") {
      state.notifyChoices = await data.getNotifyChoices();
      if (navigation === state.navigation) await renderNotify();
    } else if (id === "digest") {
      const [saved] = await Promise.all([data.getAppSettings(), ensureCalendar(true)]);
      if (navigation !== state.navigation) return;
      const current = saved || DEFAULT_DIGEST;
      state.appSettings = current;
      renderDigest(current.digest_time, current.timezone, Boolean(saved));
    } else if (id === "members") {
      if (!state.appSettings) state.appSettings = (await data.getAppSettings()) || DEFAULT_DIGEST;
      await renderMembers();
    } else if (id === "journal-list") await renderJournals();
    else if (id === "languages") renderLanguages();
  } catch (err) {
    if (navigation === state.navigation) toast(`Could not load: ${errorText(err)}`, "error");
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

// ---------- Preferences (Settings and the first-run screen) ----------

// Languages an admin can offer (code, name)
const LANGUAGE_CHOICES = [
  ["ja", "Japanese"], ["zh-Hans", "Chinese (Simplified)"], ["zh-Hant", "Chinese (Traditional)"], ["ko", "Korean"],
  ["es", "Spanish"], ["fr", "French"], ["de", "German"], ["pt", "Portuguese"], ["it", "Italian"], ["ru", "Russian"],
  ["ar", "Arabic"], ["tr", "Turkish"], ["vi", "Vietnamese"], ["id", "Indonesian"], ["th", "Thai"], ["hi", "Hindi"],
];

function prefsOptions(chosen) {
  const journals = [...state.journals].map(([id, j]) => ({ id, name: j.name, abbr: j.abbr, active: j.active }))
    .sort((a, b) => a.abbr.localeCompare(b.abbr));
  return {
    journals, chosenJournals: new Set(chosen.journals || []), fields: DEFAULT_FIELDS,
    chosenFields: new Set(chosen.fields || []), languages: state.languages, language: chosen.language || "",
  };
}

// The choices on a form; parts not on it (a settings page shows one part) keep their saved value
function readPrefs(form) {
  const has = (name) => form.querySelector(`[name="${name}"]`);
  const checked = (name) => [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => i.value);
  return {
    journals: has("journal") ? checked("journal") : (state.prefs?.journals || [...state.journals.keys()]),
    fields: has("field") ? checked("field") : (state.prefs?.fields || []),
    language: has("language") ? (form.elements.language.value || null) : (state.prefs?.language ?? null),
  };
}

function showOnboarding() {
  state.page = "onboarding";
  document.body.classList.add("signed-out");
  appbar.innerHTML = "";
  const defaults = {
    journals: [...state.journals].filter(([, j]) => j.active).map(([id]) => id),   // all, to untick
    fields: [], language: state.languages.ja ? "ja" : null,   // Japanese if offered, otherwise none
  };
  content.innerHTML = view.onboardingPage(prefsOptions(state.prefs || defaults));
  content.scrollTop = 0;
}

content.addEventListener("click", async (ev) => {
  if (!ev.target.closest('[data-act="onboarding-done"]') || state.page !== "onboarding") return;
  const prefs = readPrefs(content.querySelector("#prefs-form"));
  const msg = content.querySelector(".onboarding > .msg");
  if (!prefs.journals.length) { msg.textContent = "Choose at least one journal."; return; }
  msg.textContent = "Saving…";
  try {
    await data.savePrefs({ ...prefs, onboarded: true });
    state.prefs = { ...prefs, onboarded: true };
    document.body.classList.remove("signed-out");
    applyPrefs();
    if (location.hash && location.hash !== "#/") location.hash = "#/";
    else route();
  } catch (err) {
    msg.textContent = `Could not save: ${errorText(err)}`;
  }
});

function renderPrefs() {
  const section = content.querySelector("#prefs-section");
  const part = ["journals", "fields", "language"].includes(state.settingsSection) ? state.settingsSection : null;
  const saved = state.prefs || { journals: [...state.journals.keys()] };
  if (section) section.innerHTML = view.prefsSections(prefsOptions(saved), part);
}

// Settings: changes to journals, fields or language are saved at once
content.addEventListener("change", async (ev) => {
  const form = ev.target.closest("#prefs-form");
  if (!form || state.page !== "settings") return;
  const prefs = readPrefs(form);
  if (!prefs.journals.length) {
    ev.target.checked = true;
    toast("Keep at least one journal", "error");
    return;
  }
  try {
    await data.savePrefs({ ...prefs, onboarded: true });
    state.prefs = { ...prefs, onboarded: true };
    applyPrefs();
    state.index = null;   // Browse: rebuild the journal list
    toast("Saved");
  } catch (err) {
    toast(`Could not save: ${errorText(err)}`, "error");
    renderPrefs();
  }
});

// ---------- Journals and languages (admins) ----------

async function renderJournals() {
  const section = content.querySelector("#journals-section");
  if (!section) return;
  try {
    const [journals, usage] = await Promise.all([data.listJournals(), data.getMeta("journal_usage")]);
    state.journals = journals;
    const list = [...journals].map(([id, j]) => ({ id, ...j, issns: [j.issn_print, j.issn_online].filter(Boolean) }))
      .sort((a, b) => a.abbr.localeCompare(b.abbr));
    section.innerHTML = view.journalsAdmin({
      journals: list, usage: usage?.counts || {}, usageAt: usage?.updated_at,
      results: state.journalSearch?.results, picked: state.journalSearch?.picked, searchNote: state.journalSearch?.note,
    });
  } catch (err) {
    section.innerHTML = `<p class="msg">Could not load the journals. ${view.e(errorText(err))}</p>`;
  }
}

content.addEventListener("change", async (ev) => {
  if (!ev.target.matches?.("[data-journal-active]") || state.page !== "settings") return;
  const id = ev.target.closest("[data-journal-id]").dataset.journalId;
  try {
    await data.setJournalActive(id, ev.target.checked);
    toast(ev.target.checked ? "Collecting again" : "Paused");
  } catch (err) {
    toast(`Could not save: ${errorText(err)}`, "error");
  }
  await renderJournals();
  renderPrefs();
});

content.addEventListener("click", async (ev) => {
  if (state.page !== "settings") return;
  const del = ev.target.closest('[data-act="journal-delete"]');
  const result = ev.target.closest("[data-result]");
  const removeLang = ev.target.closest('[data-act="language-remove"]');
  if (del) {
    const id = del.closest("[data-journal-id]").dataset.journalId;
    const j = state.journals.get(id);
    const usage = (await data.getMeta("journal_usage").catch(() => null))?.counts?.[id] || 0;
    const question = usage
      ? `${usage} ${usage === 1 ? "user follows" : "users follow"} ${j.abbr}. Delete it from the list? Papers already collected stay.`
      : `Delete ${j.abbr} from the list? Papers already collected stay.`;
    if (!confirm(question)) return;
    try {
      await data.deleteJournal(id);
      toast("Deleted");
    } catch (err) {
      toast(`Could not delete: ${errorText(err)}`, "error");
    }
    await renderJournals();
    applyPrefs();
    renderPrefs();
  } else if (result) {
    state.journalSearch.picked = state.journalSearch.results[Number(result.dataset.result)];
    await renderJournals();
    content.querySelector("#journal-add input[name=abbr]")?.focus();
  } else if (removeLang) {
    const code = removeLang.closest("[data-language]").dataset.language;
    if (!confirm(`Remove ${state.languages[code]}? Users who chose it will see no translations, and new papers will not be translated into it.`)) return;
    const next = { ...state.languages };
    delete next[code];
    try {
      await data.saveLanguages(next);
      state.languages = next;
      applyPrefs();
      renderLanguages();
      renderPrefs();
      toast("Removed");
    } catch (err) {
      toast(`Could not save: ${errorText(err)}`, "error");
    }
  }
});

content.addEventListener("submit", async (ev) => {
  if (state.page !== "settings") return;
  const form = ev.target;
  if (form.id === "journal-search") {
    ev.preventDefault();
    state.journalSearch = { results: [], picked: null, note: "Searching…" };
    await renderJournals();
    try {
      const results = await data.searchSources(form.elements.q.value);
      state.journalSearch = { results, picked: null, note: results.length ? "Choose the journal:" : "Nothing found in OpenAlex." };
    } catch (err) {
      state.journalSearch = { results: [], picked: null, note: `Search failed: ${errorText(err)}` };
    }
    await renderJournals();
  } else if (form.id === "journal-add") {
    ev.preventDefault();
    const msg = form.querySelector(".msg");
    const picked = state.journalSearch?.picked;
    const abbr = form.elements.abbr.value.trim();
    const name = form.elements.name.value.trim();
    const rss = form.elements.rss.value.trim();
    const id = abbr.toLowerCase();
    if (!/^[A-Za-z0-9&.-]{1,20}$/.test(abbr)) { msg.textContent = "Use letters, digits, & . - (up to 20)."; return; }
    if (state.journals.has(id)) { msg.textContent = `${abbr} is already in the list.`; return; }
    if (rss && !/^https?:\/\//.test(rss)) { msg.textContent = "The RSS address must start with http(s)://"; return; }
    try {
      await data.addJournal(id, { name, abbr, issnPrint: picked.issns[0], issnOnline: picked.issns[1], rss, openalexId: picked.id });
      state.journalSearch = null;
      toast(`${abbr} added`);
      await renderJournals();
      renderPrefs();
    } catch (err) {
      msg.textContent = `Could not add: ${errorText(err)}`;
    }
  } else if (form.id === "language-add") {
    ev.preventDefault();
    const code = form.elements.code.value;
    const name = LANGUAGE_CHOICES.find(([c]) => c === code)?.[1];
    if (!name) return;
    const next = { ...state.languages, [code]: name };
    try {
      await data.saveLanguages(next);
      state.languages = next;
      applyPrefs();
      renderLanguages();
      renderPrefs();
      toast(`${name} added`);
    } catch (err) {
      toast(`Could not save: ${errorText(err)}`, "error");
    }
  }
});

function renderLanguages() {
  const section = content.querySelector("#languages-section");
  if (section) section.innerHTML = view.languagesAdmin({ languages: state.languages, choices: LANGUAGE_CHOICES });
}

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
