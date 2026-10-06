// HTML for pages and paper cards, following paper_digest/render.py in paper-digest.
// The interface is in English; passages containing Japanese get lang="ja".
// Parts of a card that change with library and requests are in data-slot elements, so live
// updates replace only those (open panels and note drafts stay as they are).

import {
  SECTION_LABELS, SOURCE_LABELS, STATUSES, REQUEST_LABELS, LANGUAGE_NAMES,
} from "./labels.js";

// Who is looking: relevance is shown to admins only (it reflects the admin's interest profile);
// the request button only to users allowed full-text summaries. `remaining` = summaries left
// this month (null = no limit).
// Also the user's favourite fields (listed first, papers marked), their translation language
// and the names of the offered languages.
let viewer = { admin: false, canRequest: false, remaining: null, favFields: new Set(), language: null, languageNames: {} };
export const setViewer = (v) => { viewer = { ...viewer, ...v }; };
export const languageName = (code) => viewer.languageNames[code] || LANGUAGE_NAMES[code] || (code === "en" ? "English" : code);

// The paper's abstract translation in the user's language (older papers: the single Japanese one)
function translationOf(p) {
  const code = viewer.language;
  if (!code) return null;
  return (p.abstract_translations || {})[code] || (code === "ja" ? p.abstract_translation : null) || null;
}

const JAPANESE = /[぀-ヿ㐀-鿿＀-￯]/;
const SHORT_AFFILIATION = 32;

// ---------- Small components ----------

export function e(text) {
  if (text === null || text === undefined) return "";
  return String(text).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export const lang = (text) => (text && JAPANESE.test(String(text)) ? ' lang="ja"' : "");

const para = (text, cls = "") => `<p${cls ? ` class="${cls}"` : ""}${lang(text)}>${e(text)}</p>`;

export const plural = (n, word, words = "") => `${n} ${n === 1 ? word : (words || `${word}s`)}`;

const shorten = (text, n) => (text.length <= n ? text : `${text.slice(0, n - 1)}…`);

// ---------- Names, bylines, labels ----------

// "JESSE C. JOHNSON" -> "Jesse C. Johnson" (names that are entirely upper case only)
export function displayName(name) {
  const text = String(name || "");
  if (!/[A-Z]/.test(text) || text !== text.toUpperCase()) return text;
  return text.toLowerCase().replace(/(^|[\s\-'’.(])(\p{L})/gu, (m, sep, ch) => sep + ch.toUpperCase());
}

// "First Author (Affiliation) and 2 others · JOP · 2026-10-01" (· Field, where there is no heading)
function byline(p, fieldName = "") {
  const ships = p.authorships || [];
  const names = p.authors || [];
  const parts = [];
  if (ships.length || names.length) {
    const first = ships[0] || { name: names[0], institution: null };
    let text = displayName(first.name);
    if (first.institution) text += ` (${shorten(first.institution, SHORT_AFFILIATION)})`;
    const others = (p.author_count || names.length) - 1;
    if (others > 0) text += ` and ${plural(others, "other")}`;
    parts.push(text);
  }
  parts.push(p.journal_abbr || p.journal, p.published_date, fieldName);
  return para(parts.filter(Boolean).join(" · "), "byline");
}

function careerText(info) {
  if (!info) return "";
  const parts = [];
  if (info.first_year) parts.push(`First paper ${info.first_year}`);
  if (info.works_count !== null && info.works_count !== undefined) parts.push(plural(info.works_count, "paper"));
  if (info.h_index !== null && info.h_index !== undefined) parts.push(`h-index ${info.h_index}`);
  return parts.join(" · ");
}

export function authorsBody(p, cache) {
  const ships = p.authorships || [];
  const rows = ships.map((a) => {
    const info = cache.get(a.author_id || "") || {};
    const orcid = a.orcid || info.orcid;
    const shown = displayName(a.name);
    const name = orcid ? `<a href="${e(orcid)}" target="_blank" rel="noopener">${e(shown)}</a>` : e(shown);
    const aff = [a.institution, a.country].filter(Boolean).join(", ") || "No affiliation listed";
    const career = careerText(info);
    return `<li><span class="author-name">${name}</span> <span class="aff"${lang(aff)}>${e(aff)}</span>`
      + (career ? `<span class="career">${e(career)}</span>` : "") + "</li>";
  }).join("");
  const total = p.author_count || ships.length;
  const more = total > ships.length
    ? `<p class="more">${plural(total - ships.length, "more author")} not shown</p>` : "";
  return `<ul class="authors">${rows}</ul>${more}`;
}

// The body of the Full text tab (empty if there is no summary)
export function fulltextBody(entry) {
  const ft = entry?.fulltext;
  if (!ft) return "";
  const meta = [SOURCE_LABELS[ft.source] || ft.source, ft.language ? languageName(ft.language) : "",
    (ft.created_at || "").slice(0, 10)].filter(Boolean).join(" · ");
  let body;
  if (ft.sections) {
    body = '<dl class="sections">' + SECTION_LABELS.filter(([key]) => ft.sections[key])
      .map(([key, label]) => `<dt>${label}</dt><dd${ft.language ? ` lang="${e(ft.language)}"` : lang(ft.sections[key])}>${e(ft.sections[key])}</dd>`)
      .join("") + "</dl>";
    if (ft.one_liner) body = `<p class="ft-oneliner"${lang(ft.one_liner)}>${e(ft.one_liner)}</p>` + body;
  } else {
    body = `<div class="markdown"${lang(ft.markdown)}>${e(ft.markdown)}</div>`;
  }
  return `<p class="pane-meta">${e(meta)}</p>${body}`;
}

export function notesList(entry) {
  const notes = entry?.notes || [];
  if (!notes.length) return "";
  return '<ul class="notes">' + notes.map((n) => (
    `<li${lang(n.text)}><time>${e((n.at || "").slice(0, 16).replace("T", " "))}</time>${e(n.text)}</li>`
  )).join("") + "</ul>";
}

// ---------- Library and request state ----------

// The latest request for a paper (by time; offsets may differ)
export function latestRequest(key, requests) {
  let latest = null;
  for (const r of requests.values()) {
    if (r.doi_key !== key) continue;
    if (!latest || Date.parse(r.requested_at) > Date.parse(latest.requested_at)) latest = r;
  }
  return latest;
}

// The small line above the title: full-text availability (and the saved date in the Library)
export function cardMeta(p, entry, opts = {}) {
  const items = [];
  if (entry?.fulltext) items.push(['<span class="ft">Full text</span>', true]);
  else if (p.fulltext_access === "auto") items.push(["OA", false]);
  else if (p.fulltext_access === "manual") items.push(["OA · PDF needed", false]);
  if (opts.library && entry?.saved_at) items.push([`Saved ${e(entry.saved_at)}`, false]);
  return items.map(([text, html]) => (html ? text : e(text))).join('<span class="sep">·</span>');
}

// Relevance (admins only): five dots and the number, next to the title
function relevanceMeter(p) {
  if (!viewer.admin || p.relevance === null || p.relevance === undefined) return "";
  const filled = Math.round(p.relevance / 2);
  const dots = Array.from({ length: 5 }, (_, i) => `<i class="${i < filled ? "on" : ""}"></i>`).join("");
  return `<span class="rel" title="Relevance ${p.relevance} of 10" aria-label="Relevance ${p.relevance} of 10">${dots}<b>${p.relevance}</b></span>`;
}

// ---------- Icons (inline SVG, stroke-based; colored by currentColor) ----------

const svg = (body, cls = "") => `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
export const ICONS = {
  bookmark: svg('<path d="M6.5 3.5h11a1 1 0 0 1 1 1v16l-6.5-4-6.5 4v-16a1 1 0 0 1 1-1z"/>'),
  bookmarkFilled: svg('<path class="fill" d="M6.5 3.5h11a1 1 0 0 1 1 1v16l-6.5-4-6.5 4v-16a1 1 0 0 1 1-1z"/>'),
  toRead: svg('<path d="M4 5.5c2.7-1 5.3-1 8 .8 2.7-1.8 5.3-1.8 8-.8v13c-2.7-1-5.3-1-8 .8-2.7-1.8-5.3-1.8-8-.8z"/><path d="M12 6.3v13"/>'),
  read: svg('<circle cx="12" cy="12" r="8.5"/><path d="M8.2 12.3l2.6 2.6 5-5.3"/>'),
  note: svg('<path d="M14.5 4.5l5 5L9 20H4v-5z"/><path d="M12.5 6.5l5 5"/>'),
  request: svg('<path d="M7 3.5h7l4.5 4.5v12.5H7z"/><path d="M14 3.5V8h4.5M10 13h5.5M10 16.5h4"/>'),
  pdf: svg('<path d="M7 3.5h7l4.5 4.5v12.5H7z"/><path d="M14 3.5V8h4.5M12.5 11v6.5M10 15l2.5 2.5L15 15"/>'),
  clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  alert: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5.5M12 16.2v.3"/>'),
  chevronLeft: svg('<path d="M14.5 5.5L8 12l6.5 6.5"/>'),
  chevronRight: svg('<path d="M9.5 5.5L16 12l-6.5 6.5"/>'),
  chevronDown: svg('<path d="M6.5 9.5L12 15l5.5-5.5"/>'),
  search: svg('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5l5 5"/>'),
  external: svg('<path d="M13.5 4.5h6v6M19.5 4.5l-8 8"/><path d="M17.5 13.5v5a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18.5V8.5A1.5 1.5 0 0 1 6 7h5"/>'),
  unlock: svg('<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 6.8-1.2"/><circle cx="12" cy="15.5" r="1.2" class="fill"/>'),
  more: svg('<circle cx="6" cy="12" r="1.3" class="fill"/><circle cx="12" cy="12" r="1.3" class="fill"/><circle cx="18" cy="12" r="1.3" class="fill"/>'),
  cards: svg('<rect x="4" y="4.5" width="16" height="6" rx="1.5"/><rect x="4" y="13.5" width="16" height="6" rx="1.5"/>'),
  list: svg('<path d="M5 6.5h14M5 12h14M5 17.5h14"/>'),
  close: svg('<path d="M7 7l10 10M17 7L7 17"/>'),
};

// The row of actions under a paper: save, status, note, request; links on the right
export function actions(p, entry, request, busy) {
  const saved = Boolean(entry?.saved);
  const left = [];
  left.push(saved
    ? `<button type="button" class="btn icon-only on" data-act="unsave" aria-pressed="true" aria-label="Saved (tap to remove)" title="Saved">${ICONS.bookmarkFilled}</button>`
    : `<button type="button" class="btn icon-only" data-act="save" aria-pressed="false" aria-label="Save" title="Save">${ICONS.bookmark}</button>`);
  left.push('<span class="seg" role="group" aria-label="Status">' + STATUSES.map(([code, label]) => {
    const on = saved && entry.status === code;
    return `<button type="button" data-act="status" data-status="${code}" class="${on ? "on" : ""}" aria-pressed="${on}">${label}</button>`;
  }).join("") + "</span>");
  left.push(`<button type="button" class="btn icon-only" data-act="note" aria-label="Add note" title="Add note">${ICONS.note}</button>`);

  const active = request && (request.status === "pending" || request.status === "processing");
  let error = "";
  if (active || (request && request.status === "done" && !entry?.hasOwnSummary)) {
    const label = { pending: "Requested", processing: "Summarizing…", done: "Done" }[request.status];
    left.push(`<span class="pill ${request.status}" title="${e(REQUEST_LABELS[request.status])}">${ICONS.clock}<span>${label}</span></span>`);
    // Only a waiting request can be cancelled (not once it is being summarized)
    if (request.status === "pending") {
      left.push(`<button type="button" class="btn icon-only ghost cancel" data-act="cancel-request" aria-label="Cancel the request" title="Cancel the request">${ICONS.close}</button>`);
    }
  } else if (!entry?.hasOwnSummary && p.fulltext_access === "auto" && viewer.canRequest) {
    const failed = request?.status === "failed";
    const none = viewer.remaining === 0;
    const title = none ? "Monthly limit reached" : failed ? "Request the full-text summary again" : "Request a full-text summary"
      + (viewer.remaining !== null ? ` (${viewer.remaining} left this month)` : "");
    left.push(`<button type="button" class="btn icon-only request" data-act="request"${busy || none ? " disabled" : ""} aria-label="${e(title)}" title="${e(title)}">`
      + `${ICONS.request}${viewer.remaining !== null ? `<span class="count">${viewer.remaining}</span>` : ""}</button>`);
    if (failed) error = `<p class="req-error">${ICONS.alert}<span>${REQUEST_LABELS.failed}: ${e(request.error || "no reason given")}</span></p>`;
  } else if (request?.status === "failed" && !entry?.hasOwnSummary) {
    error = `<p class="req-error">${ICONS.alert}<span>${REQUEST_LABELS.failed}: ${e(request.error || "")}</span></p>`;
  }
  const right = [];
  if (p.url) right.push(`<a class="btn icon-only ghost" href="${e(p.url)}" target="_blank" rel="noopener" aria-label="Article page" title="Article page">${ICONS.external}</a>`);
  if (p.oa_url) right.push(`<a class="btn icon-only ghost" href="${e(p.oa_url)}" target="_blank" rel="noopener" aria-label="Open access version" title="Open access version">${ICONS.unlock}</a>`);
  return `<div class="buttons"><span class="group-l">${left.join("")}</span><span class="group-r">${right.join("")}</span></div>${error}`;
}

// ---------- Cards ----------

// One "Details" panel with tabs: Translation, Abstract, Authors, Full text (when there is one;
// the line above the title says so while the card is closed)
function detailsBlock(p, entry) {
  const translation = translationOf(p);
  const tabs = [];
  if (translation) tabs.push(["tr", "Translation"]);
  if (p.abstract) tabs.push(["ab", "Abstract"]);
  if ((p.authorships || []).length) tabs.push(["au", "Authors"]);
  tabs.push(["ft", "Full text"]);
  const hasFt = Boolean(entry?.fulltext);
  const first = hasFt ? "ft" : (tabs[0][0] === "ft" ? "ft" : tabs[0][0]);
  const tab = ([id, label]) => `<button type="button" role="tab" data-tab="${id}" aria-selected="${id === first}"`
    + `${id === "ft" && !hasFt ? " hidden" : ""}>${label}</button>`;
  const pane = (id, body, attrs = "") => `<div class="pane" role="tabpanel" data-pane="${id}"${id === first ? "" : " hidden"}${attrs}>${body}</div>`;
  const total = p.author_count || (p.authorships || []).length;
  const hints = [translation ? languageName(viewer.language) : "", (p.authorships || []).length ? plural(total, "author") : ""].filter(Boolean);
  return '<details class="more">'
    + `<summary><span>Details<span class="meta">${e(hints.join(" · "))}</span></span></summary>`
    + `<div class="tabs" role="tablist">${tabs.map(tab).join("")}</div>`
    + (translation ? pane("tr", `<p lang="${e(viewer.language)}">${e(translation)}</p>`) : "")
    + (p.abstract ? pane("ab", `<p class="abstract-en">${e(p.abstract)}</p>`) : "")
    + ((p.authorships || []).length ? pane("au", '<p class="more">Loading…</p>', " data-authors") : "")
    + pane("ft", fulltextBody(entry), ' data-slot="fulltext"')
    + "</details>";
}

// A paper card. opts: {showField: field name to show (no heading above), library: true}
export function card(p, state, day, opts = {}) {
  const entry = state.entry;
  const highlighted = viewer.admin && day && (p.relevance ?? 0) >= day.highlight_threshold;
  const oneLiner = (opts.library && entry?.fulltext?.one_liner) || p.one_liner;
  return [
    `<article class="paper${highlighted ? " highlighted" : ""}" data-key="${e(p.doi_key)}"${opts.library ? ' data-library="1"' : ""}>`,
    `<p class="card-meta" data-slot="meta">${cardMeta(p, entry, opts)}</p>`,
    `<h3 class="title"><a href="${e(p.url || "")}" target="_blank" rel="noopener">${e(p.title)}</a>${relevanceMeter(p)}</h3>`,
    byline(p, opts.showField || ""),
    `<div data-slot="oneliner">${oneLiner ? para(oneLiner, "oneliner") : ""}</div>`,
    highlighted && p.relevance_reason ? para(p.relevance_reason, "reason") : "",
    `<div class="actions" data-slot="actions">${actions(p, entry, state.request, state.busy)}</div>`,
    `<div data-slot="notes">${notesList(entry)}</div>`,
    detailsBlock(p, entry),
    "</article>",
  ].join("");
}

export function dayCard(p, day, fieldNames, state, showField = false) {
  return card(p, state, day, { showField: showField ? (fieldNames.get(p.field) || p.field) : "" });
}

export function libraryCard(p, entry, state) {
  return card({ ...p, doi_key: entry.doi_key, title: p.title || entry.doi }, { ...state, entry }, null,
    { library: true, showField: viewer.fieldNames?.get(p.field) || "" });
}

// Compact view: one line per paper (title, journal, one-liner); tapping opens its card
export function compactRow(p, state) {
  const saved = state.entry?.saved;
  return `<button type="button" class="compact-row" data-expand="${e(p.doi_key)}">`
    + `<span class="c-title">${e(p.title)}${relevanceMeter(p)}</span>`
    + `<span class="c-meta"><b>${e(p.journal_abbr || p.journal || "")}</b>${saved ? ICONS.bookmarkFilled : ""}`
    + `${p.one_liner ? `<span${lang(p.one_liner)}>${e(p.one_liner)}</span>` : ""}</span>`
    + "</button>";
}

// Grey placeholder cards shown while data loads
export function skeleton(n = 3) {
  const block = '<div class="sk-card"><div class="sk-line w30"></div><div class="sk-line w90 tall"></div>'
    + '<div class="sk-line w70 tall"></div><div class="sk-line w50"></div><div class="sk-line w100"></div>'
    + '<div class="sk-line w80"></div></div>';
  return `<div class="skeleton" aria-busy="true" aria-label="Loading">${block.repeat(n)}</div>`;
}

// ---------- Top bar ----------

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August",
  "September", "October", "November", "December"];

// "Sunday, October 4"
export function longDate(date) {
  const [y, m, d] = date.split("-").map(Number);
  return `${WEEKDAYS[new Date(y, m - 1, d).getDay()]}, ${MONTH_NAMES[m - 1]} ${d}`;
}

// On a day: ‹ date › (the date opens the calendar). Elsewhere: the page title, with a back
// button on detail pages.
export function appBar({ title, date, prev, next, back, today }) {
  if (date === undefined) {
    return '<div class="appbar-inner">'
      + (back ? `<button type="button" class="appbar-back" data-act="back">${ICONS.chevronLeft}<span>${e(back)}</span></button>` : "")
      + `<h1 class="appbar-title">${e(title)}</h1>`
      + (back ? '<span class="appbar-spacer"></span>' : "")
      + "</div>";
  }
  const arrow = (target, label, icon) => (target
    ? `<a class="appbar-btn" href="#/day/${target}" aria-label="${label}">${icon}</a>`
    : `<span class="appbar-btn off" aria-hidden="true">${icon}</span>`);
  const sub = date ? (date === today ? "Today" : date.slice(0, 4)) : "";
  return '<div class="appbar-inner">'
    + arrow(prev, "Previous day", ICONS.chevronLeft)
    + '<button type="button" class="date-pick" data-act="calendar" aria-haspopup="dialog" aria-label="Open the calendar">'
    + `<span class="date-main">${e(date ? longDate(date) : "No digest")}${ICONS.chevronDown}</span>`
    + (sub ? `<span class="date-sub${sub === "Today" ? " today" : ""}">${e(sub)}</span>` : "")
    + "</button>"
    + arrow(next, "Next day", ICONS.chevronRight)
    + "</div>";
}

// ---------- Calendar ----------

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August",
  "September", "October", "November", "December"];

// A month grid. `days` is meta/calendar.days ({date: {papers, highlights}});
// `month` is "YYYY-MM"; `selected` the open day; `today` the device's date.
export function calendar(month, days, selected, today) {
  const [y, m] = month.split("-").map(Number);
  const first = new Date(y, m - 1, 1).getDay();
  const count = new Date(y, m, 0).getDate();
  const cells = [];
  for (let i = 0; i < first; i++) cells.push('<span class="cal-day blank"></span>');
  for (let d = 1; d <= count; d++) {
    const date = `${month}-${String(d).padStart(2, "0")}`;
    const info = days[date];
    const cls = ["cal-day", info ? "has" : "", info?.highlights ? "hl" : "",
      date === today ? "today" : "", date === selected ? "selected" : ""].filter(Boolean).join(" ");
    const label = `${MONTHS[m - 1]} ${d}`
      + (info ? `: ${plural(info.papers, "paper")}${info.highlights ? `, ${plural(info.highlights, "highlight")}` : ""}` : ": no digest")
      + (date === today ? " (today)" : "");
    cells.push(info
      ? `<button type="button" class="${cls}" data-date="${date}" aria-label="${e(label)}"${date === selected ? ' aria-current="date"' : ""}><span>${d}</span><i class="dot"></i></button>`
      : `<span class="${cls}" aria-label="${e(label)}"><span>${d}</span></span>`);
  }
  const weekdays = ["S", "M", "T", "W", "T", "F", "S"].map((w) => `<span class="cal-wd" aria-hidden="true">${w}</span>`).join("");
  return '<div class="cal">'
    + '<div class="cal-head">'
    + `<button type="button" class="appbar-btn" data-cal="prev" aria-label="Previous month">${ICONS.chevronLeft}</button>`
    + `<span class="cal-title" aria-live="polite">${MONTHS[m - 1]} ${y}</span>`
    + `<button type="button" class="appbar-btn" data-cal="next" aria-label="Next month">${ICONS.chevronRight}</button>`
    + "</div>"
    + `<div class="cal-grid">${weekdays}${cells.join("")}</div>`
    + '<div class="cal-foot">'
    + '<span class="cal-legend"><i class="dot"></i>New papers <i class="dot hl"></i>Highlights</span>'
    + '<button type="button" class="btn" data-cal="today">Today</button>'
    + "</div></div>";
}

// ---------- Pages ----------

// Papers of a day grouped by field: [{id, name, fav, papers}], favourite fields first
export function groupPapers(papers, fieldList) {
  const fieldNames = new Map(fieldList.map((f) => [f.id, f.name]));
  const groups = new Map();
  for (const p of papers) {
    const f = p.field || "other";
    if (!groups.has(f)) groups.set(f, []);
    groups.get(f).push(p);
  }
  // Admins: most relevant first; others: newest publication first
  const byDate = (a, b) => (b.published_date || "").localeCompare(a.published_date || "");
  for (const list of groups.values()) {
    list.sort(viewer.admin ? (a, b) => (b.relevance ?? 0) - (a.relevance ?? 0) || byDate(a, b) : byDate);
  }
  const usual = [...fieldList.map((f) => f.id).filter((f) => groups.has(f)),
    ...[...groups.keys()].filter((f) => !fieldNames.has(f))];
  const order = [...usual.filter((f) => viewer.favFields.has(f)), ...usual.filter((f) => !viewer.favFields.has(f))];
  return order.map((f) => ({ id: f, name: fieldNames.get(f) || f, fav: viewer.favFields.has(f), papers: groups.get(f) }));
}

// The fields of the day as a vertical list (the sidebar on wide screens)
export function sideToc(groups) {
  if (!groups.length) return "";
  return '<p class="side-label">On this day</p><ul class="side-toc">' + groups.map((g) => (
    `<li><a href="#f-${e(g.id)}" data-jump="f-${e(g.id)}">${g.fav ? '<span class="star">★</span>' : ""}`
    + `<span class="name">${e(g.name)}</span><span class="n">${g.papers.length}</span></a></li>`
  )).join("") + "</ul>";
}

// A day: count, Cards/Compact switch, the fields (on narrow screens), groups with sticky headings
export function dayPage(day, papers, fieldList, stateOf, compact = false) {
  const groups = groupPapers(papers, fieldList);
  const fieldNames = new Map(fieldList.map((f) => [f.id, f.name]));
  const toc = groups.map((g) => (
    `<li><a href="#f-${e(g.id)}" data-jump="f-${e(g.id)}">${g.fav ? "★ " : ""}${e(g.name)}<span class="n">${g.papers.length}</span></a></li>`
  )).join("");
  const sections = groups.map((g) => (
    `<section class="group${g.fav ? " fav" : ""}" id="f-${e(g.id)}"><h2>${g.fav ? '<span class="star" aria-label="Favourite field">★</span>' : ""}`
    + `${e(g.name)}<span class="n">${g.papers.length}</span></h2>`
    + (compact
      ? `<div class="compact-list">${g.papers.map((p) => compactRow(p, stateOf(p.doi_key))).join("")}</div>`
      : g.papers.map((p) => dayCard(p, day, fieldNames, stateOf(p.doi_key))).join(""))
    + "</section>"
  )).join("");
  const failed = [...new Set((day.runs || []).flatMap((r) => r.failed_journals || []))];
  const foot = failed.length
    ? `<p class="run-note">Journals that failed to load in this day's runs: ${e(failed.join(", "))}</p>` : "";
  const mode = (value, label, icon) => `<button type="button" data-act="view-mode" data-mode="${value}"`
    + ` class="${(value === "compact") === compact ? "on" : ""}" aria-pressed="${(value === "compact") === compact}" aria-label="${label}" title="${label}">${icon}</button>`;
  return '<header class="page-head day-head">'
    + `<p class="sub">${plural(day.paper_count ?? papers.length, "paper")}`
    + (viewer.admin ? ` · ${plural(day.highlight_count ?? 0, "highlight")}` : "") + "</p>"
    + `<span class="seg view-mode" role="group" aria-label="View">${mode("cards", "Cards", ICONS.cards)}${mode("compact", "Compact", ICONS.list)}</span>`
    + "</header>"
    + (toc ? `<ul class="toc day-toc">${toc}</ul>` : "")
    + (sections || '<p class="empty">No new papers.</p>') + foot;
}

export function libraryPage(groups, counts) {
  const toc = STATUSES.map(([code, label]) => (
    `<li><a href="#s-${code}" data-jump="s-${code}">${label}<span class="n">${groups.get(code).length}</span></a></li>`
  )).join("");
  const sections = STATUSES.map(([code, label]) => (
    `<section class="group" id="s-${code}"><h2>${label}<span class="n">${groups.get(code).length}</span></h2>`
    + (groups.get(code).map((x) => x.html).join("") || '<p class="empty">None</p>') + "</section>"
  )).join("");
  return '<header class="page-head">'
    + `<p class="sub">${counts.saved} saved · ${plural(counts.fulltext, "full-text summary", "full-text summaries")}</p></header>`
    + `<ul class="toc">${toc}</ul>${sections}`;
}

export function loginPage(email, message = "") {
  return '<section class="login">'
    + '<img class="login-icon" src="icons/icon-192.png" alt="" width="72" height="72">'
    + '<h1>Paper digest</h1>'
    + '<form id="login-form" autocomplete="on">'
    + (email
      ? `<p class="who">${e(email)}</p><input type="email" name="email" autocomplete="username" value="${e(email)}" hidden>`
      : '<label>Email<input type="email" name="email" autocomplete="username" required></label>')
    + '<label>PIN<input type="password" name="pin" inputmode="numeric" pattern="[0-9]{6}" maxlength="6"'
    + ' autocomplete="current-password" required autofocus></label>'
    + `<p class="msg" role="alert">${e(message)}</p>`
    + '<button type="submit" class="btn primary wide">Sign in</button>'
    + (email ? '<button type="button" class="btn link" data-act="other-email">Use a different email</button>' : "")
    + "</form></section>";
}

// Settings → Daily digest time. `digest`: {time, timezone, times, zones: {common, rest}, next,
// last, fromApp}; null while loading.
function digestSection(digest) {
  if (!digest) return '<div class="inset"><p class="row"><span>Loading…</span></p></div>';
  const option = (value, label, selected) => `<option value="${e(value)}"${selected ? " selected" : ""}>${e(label)}</option>`;
  const zones = digest.zones.common.includes(digest.timezone) || digest.zones.rest.includes(digest.timezone)
    ? digest.zones : { ...digest.zones, common: [digest.timezone, ...digest.zones.common] };
  return '<form id="digest-form"><div class="inset">'
    + `<label class="row"><span>Time</span><span class="select inline"><select name="time">`
    + digest.times.map(([value, label]) => option(value, label, value === digest.time)).join("")
    + `</select>${ICONS.chevronDown}</span></label>`
    + `<label class="row"><span>Time zone</span><span class="select inline"><select name="timezone">`
    + `<optgroup label="Common">${zones.common.map((z) => option(z, z.replace(/_/g, " "), z === digest.timezone)).join("")}</optgroup>`
    + `<optgroup label="All time zones">${zones.rest.map((z) => option(z, z.replace(/_/g, " "), z === digest.timezone)).join("")}</optgroup>`
    + `</select>${ICONS.chevronDown}</span></label>`
    + `<p class="row"><span>Next run</span><span class="value" data-next>${e(digest.next)}</span></p>`
    + `<p class="row"><span>Last run</span><span class="value small">${e(digest.last)}</span></p>`
    + "</div>"
    + '<p class="hint">The job checks every hour at :17 (UTC) and runs the digest at its first check after this time, '
    + "once a day. GitHub can start it up to about an hour late. The time zone also decides which day a digest belongs to."
    + (digest.fromApp ? "" : " (Not saved yet: these are the defaults from the repository.)") + "</p>"
    + '<p class="msg" role="status"></p><button type="submit" class="btn primary wide">Save digest time</button></form>';
}

// Settings → Notifications. `n`: {status, platform, digestOn, fulltextOn, busy}; null while loading.
const NOTIFY_STATUS = {
  enabled: ["Enabled on this device", "ok"],
  off: ["Not enabled on this device", ""],
  blocked: ["Blocked: allow notifications for this site in the browser (and for the browser in System Settings → Notifications)", "bad"],
  unsupported: ["Not supported in this browser", "bad"],
  "ios-browser": ["Add to Home Screen and open from there to enable notifications", ""],
};

export function notifySection(n) {
  if (!n) return '<div class="inset"><p class="row"><span>Loading…</span></p></div>';
  const [label, cls] = NOTIFY_STATUS[n.status] || [n.status, ""];
  const toggle = (kind, text, on, off = false) => `<label class="row switch-row${off ? " disabled" : ""}"><span>${text}</span>`
    + `<input type="checkbox" class="switch" data-notify="${kind}"${on ? " checked" : ""}${off ? " disabled" : ""}></label>`;
  const buttons = [];
  if (n.status === "off") buttons.push(`<button type="button" class="btn primary wide" data-act="push-enable"${n.busy ? " disabled" : ""}>${n.busy ? "Enabling…" : "Enable notifications"}</button>`);
  if (n.status === "enabled") {
    buttons.push('<button type="button" class="btn wide" data-act="push-test">Show a test notification</button>');
    buttons.push(`<button type="button" class="btn wide link danger" data-act="push-disable"${n.busy ? " disabled" : ""}>Remove this device</button>`);
  }
  return '<div class="inset">'
    + `<p class="row"><span>This device</span><span class="value small">${e(n.platform)}</span></p>`
    + `<p class="row status-row ${cls}"><span>${e(label)}</span></p>`
    + toggle("digest", "New papers each morning", n.digestOn)
    + toggle("empty", "Notify even when there are no new papers", n.emptyOn, !n.digestOn)
    + toggle("fulltext", "Full-text summary ready", n.fulltextOn)
    + "</div>"
    + '<p class="hint">The switches are yours and apply to all your devices. Notifications go to each of your devices where they are enabled. '
    + "The no-new-papers notice confirms that the morning digest ran; it does not change the icon badge.</p>"
    + `<div class="stack">${buttons.join("")}</div>`;
}

// Settings → Members (admins). `m`: {users: [{uid, display_name, role, active, fulltext_allowed,
// monthly_limit, used}], me}; null while loading.
export function membersSection(m) {
  if (!m) return '<div class="inset"><p class="row"><span>Loading…</span></p></div>';
  const rows = m.users.map((u) => {
    const self = u.uid === m.me;
    const limit = u.monthly_limit === null || u.monthly_limit === undefined ? "" : u.monthly_limit;
    return `<div class="inset member${u.active ? "" : " inactive"}" data-uid="${e(u.uid)}">`
      + `<p class="row"><span class="member-name">${e(u.display_name)}</span>`
      + `<span class="value small">${e(u.role)}${u.active ? "" : " · inactive"} · ${u.used} this month</span></p>`
      + `<p class="row uid"><span class="value small mono">${e(u.uid)}</span></p>`
      + `<label class="row"><span>Display name</span><input type="text" data-member="display_name" maxlength="60" required autocomplete="off" value="${e(u.display_name)}"></label>`
      + `<label class="row switch-row${self ? " disabled" : ""}"><span>Active</span><input type="checkbox" class="switch" data-member="active"${u.active ? " checked" : ""}${self ? " disabled" : ""}></label>`
      + `<label class="row switch-row"><span>Full-text summaries</span><input type="checkbox" class="switch" data-member="fulltext_allowed"${u.fulltext_allowed ? " checked" : ""}></label>`
      + `<label class="row"><span>Monthly limit</span><input type="number" class="limit" data-member="monthly_limit" min="0" max="1000" step="1" inputmode="numeric" placeholder="No limit" value="${e(limit)}"></label>`
      + "</div>";
  }).join("");
  return `<div class="members">${rows}</div>`
    + '<p class="hint">An empty monthly limit means no limit. Summaries linked from an existing one are not counted. '
    + "Inactive members cannot use the app; their data is kept.</p>"
    + '<p class="group-label">Add a member</p>'
    + '<form id="member-form"><div class="inset">'
    + '<label class="row"><span>UID</span><input type="text" name="uid" required maxlength="128" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="From the Firebase console"></label>'
    + '<label class="row"><span>Display name</span><input type="text" name="name" required maxlength="60" autocomplete="off"></label>'
    + '<label class="row switch-row"><span>Full-text summaries</span><input type="checkbox" class="switch" name="allowed"></label>'
    + '<label class="row"><span>Monthly limit</span><input type="number" class="limit" name="limit" min="0" max="1000" step="1" inputmode="numeric" placeholder="No limit"></label>'
    + '</div><p class="msg" role="status"></p><button type="submit" class="btn primary wide">Add member</button></form>';
}

export function notRegisteredPage(email) {
  return '<section class="login">'
    + '<img class="login-icon" src="icons/icon-192.png" alt="" width="72" height="72">'
    + '<h1>Paper digest</h1>'
    + `<p class="who">${e(email || "")}</p>`
    + '<p class="msg">This account is not registered as a user yet.</p>'
    + '<button type="button" class="btn wide" data-act="signout">Sign out</button></section>';
}

// Settings, as on a phone: a list of items, each opening its own page (#/settings/{id}).
// `m`: {email, admin, values: {id: short current value}}
export function settingsMenu(m) {
  const row = (id, label, value = "") => `<a class="row menu-row" href="#/settings/${id}"><span>${e(label)}</span>`
    + `<span class="menu-end"><span class="value small">${e(value)}</span>${ICONS.chevronRight}</span></a>`;
  const v = m.values || {};
  return '<section class="settings">'
    + '<p class="group-label">Reading</p><div class="inset">'
    + row("journals", "My journals", v.journals) + row("fields", "Favourite fields", v.fields)
    + row("language", "Translation language", v.language) + "</div>"
    + '<p class="group-label">Notifications</p><div class="inset">' + row("notifications", "Notifications", v.notifications) + "</div>"
    + (m.admin ? '<p class="group-label">Administration</p><div class="inset">'
      + row("digest", "Daily digest time", v.digest) + row("members", "Members", v.members)
      + row("journal-list", "Journals", v.journalList) + row("languages", "Languages", v.languages)
      + row("costs", "Costs", v.costs) + row("run", "Run now", v.run) + "</div>" : "")
    + '<p class="group-label">Account</p><div class="inset">'
    + `<p class="row"><span>Signed in as</span><span class="value">${e(m.email)}</span></p>`
    + row("pin", "Change PIN") + "</div>"
    + '<div class="inset signout"><button type="button" class="row danger" data-act="signout">Sign out</button></div>'
    + '<p class="hint">After signing out, this device remembers the email; you will only need the PIN.</p>'
    + "</section>";
}

// Titles of the settings pages
export const SETTINGS_PAGES = {
  journals: "My journals", fields: "Favourite fields", language: "Translation language",
  notifications: "Notifications", digest: "Daily digest time", members: "Members",
  "journal-list": "Journals", languages: "Languages", costs: "Costs", run: "Run now", pin: "Change PIN",
};

// One settings page: an empty container that the app fills
export function settingsSection(id) {
  if (id === "pin") {
    const pin = (name, label, auto) => `<label class="row"><span>${label}</span><input type="password" name="${name}"`
      + ` inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="${auto}" placeholder="••••••" required></label>`;
    return '<section class="settings"><form id="pin-form"><div class="inset">'
      + pin("current", "Current PIN", "current-password") + pin("next", "New PIN", "new-password")
      + pin("again", "New PIN again", "new-password") + "</div>"
      + '<p class="msg" role="status"></p><button type="submit" class="btn primary wide">Change PIN</button></form></section>';
  }
  const ids = { journals: "prefs-section", fields: "prefs-section", language: "prefs-section",
    notifications: "notify-section", digest: "digest-section", members: "members-section",
    "journal-list": "journals-section", languages: "languages-section", costs: "costs-section",
    run: "run-section" };
  return `<section class="settings"><div id="${ids[id] || "unknown-section"}">${skeleton(1)}</div></section>`;
}

// ---------- Browse ----------

// Search box and filters (rendered once; the list below is redrawn as you type)
export function browseBar(meta, journals, browse) {
  const option = (value, label, selected) => `<option value="${e(value)}"${selected ? " selected" : ""}>${e(label)}</option>`;
  return '<div class="browse-bar">'
    + `<label class="search">${ICONS.search}<input type="search" name="q" value="${e(browse.q)}"`
    + ' placeholder="Search titles, authors, journals, tags" autocomplete="off" autocorrect="off" spellcheck="false"'
    + ' enterkeyhint="search" aria-label="Search papers"></label>'
    + '<div class="filters">'
    + `<span class="select">${'<select name="journal" aria-label="Journal">'}${option("__mine__", "My journals", browse.journal === "__mine__")}`
    + option("", "All journals", !browse.journal)
    + journals.map((j) => option(j.abbr, `${j.abbr} · ${j.name}`, browse.journal === j.abbr)).join("")
    + `</select>${ICONS.chevronDown}</span>`
    + `<span class="select"><select name="field" aria-label="Field">${option("", "All fields", !browse.field)}`
    + (meta.fields || []).map((f) => option(f.id, f.name, browse.field === f.id)).join("")
    + `</select>${ICONS.chevronDown}</span>`
    + "</div></div>";
}

// No search and no filters: journals with their paper counts
export function journalList(journals) {
  if (!journals.length) return '<p class="empty">No papers yet.</p>';
  return `<p class="list-head">${plural(journals.length, "journal")}</p><ul class="rows">`
    + journals.map((j) => (
      `<li><button type="button" class="row-btn" data-journal="${e(j.abbr)}">`
      + `<span class="row-main"><span class="row-title">${e(j.name)}</span><span class="row-meta">${e(j.abbr)}</span></span>`
      + `<span class="count">${j.count}</span>${ICONS.chevronRight}</button></li>`
    )).join("") + "</ul>";
}

// Search results: one row per paper; `isSaved(key)` gives the saved mark
export function resultRows(entries, total, threshold, isSaved, more) {
  if (!total) return '<p class="empty">No matching papers.</p>';
  const rows = entries.map((x) => {
    const hl = viewer.admin && (x.relevance ?? 0) >= threshold;
    const meta = [x.journal_abbr, x.published_date, viewer.fieldNames?.get(x.field) || "",
      viewer.admin && x.relevance !== null && x.relevance !== undefined ? `Relevance ${x.relevance}` : ""]
      .filter(Boolean).join(" · ");
    return `<li><a class="row-btn" href="#/paper/${e(x.doi_key)}" data-key="${e(x.doi_key)}">`
      + '<span class="row-main">'
      + `<span class="row-title serif">${e(x.title)}</span>`
      + `<span class="row-meta">${hl ? '<i class="dot hl" aria-label="Highlight"></i>' : ""}${e(meta)}</span>`
      + "</span>"
      + `<span class="row-mark" data-mark="${e(x.doi_key)}">${isSaved(x.doi_key) ? ICONS.bookmarkFilled : ""}</span>`
      + "</a></li>";
  }).join("");
  return `<p class="list-head">${plural(total, "paper")}</p><ul class="rows">${rows}</ul>`
    + (more ? `<button type="button" class="btn wide more-btn" data-act="more">Show ${more} more</button>` : "");
}

// ---------- One paper (from Browse) ----------

export const digestSettings = digestSection;

export function paperPage(p, ctx, fieldNames, state) {
  const days = (p.appeared_in || []).map((d) => `<a href="#/day/${e(d)}">${e(d)}</a>`).join(", ");
  return dayCard(p, ctx, fieldNames, state, true)
    + (days ? `<p class="appeared">In the digest of ${days}</p>` : "");
}

// ---------- Preferences: journals, favourite fields, translation language ----------

// The checkboxes and select shared by Settings and the first-run screen.
// `o`: {journals: [{id, name, abbr, active}], chosenJournals: Set, fields: [{id, name}],
//       chosenFields: Set, languages: {code: name}, language}
function journalChecks(o) {
  return o.journals.map((j) => (
    `<label class="row check-row${j.active ? "" : " paused"}"><span><span class="j-abbr">${e(j.abbr)}</span> ${e(j.name)}`
    + `${j.active ? "" : ' <span class="tag">paused</span>'}</span>`
    + `<input type="checkbox" class="switch" name="journal" value="${e(j.id)}"${o.chosenJournals.has(j.id) ? " checked" : ""}></label>`
  )).join("");
}

function fieldChecks(o) {
  return o.fields.map((f) => (
    `<label class="row check-row"><span>${e(f.name)}</span>`
    + `<input type="checkbox" class="switch" name="field" value="${e(f.id)}"${o.chosenFields.has(f.id) ? " checked" : ""}></label>`
  )).join("");
}

function languageSelect(o) {
  const option = (value, label) => `<option value="${e(value)}"${(o.language || "") === value ? " selected" : ""}>${e(label)}</option>`;
  return `<label class="row"><span>Translate abstracts into</span><span class="select inline"><select name="language">`
    + option("", "No translation")
    + Object.entries(o.languages).sort((a, b) => a[1].localeCompare(b[1])).map(([code, name]) => option(code, name)).join("")
    + `</select>${ICONS.chevronDown}</span></label>`;
}

// `part`: "journals", "fields" or "language" (a settings page), or all three (first-run screen)
export function prefsSections(o, part = null) {
  const show = (name) => !part || part === name;
  return '<form id="prefs-form">'
    + (show("journals") ? (part ? "" : '<p class="group-label">My journals</p>')
      + `<div class="inset">${journalChecks(o) || '<p class="row"><span>No journals yet.</span></p>'}</div>`
      + '<p class="hint">Today, the calendar, Browse, notifications and the badge show only these journals. '
      + "Paused journals are not collected for now.</p>" : "")
    + (show("fields") ? (part ? "" : '<p class="group-label">Favourite fields</p>')
      + `<div class="inset">${fieldChecks(o)}</div>`
      + '<p class="hint">Listed first on Today and marked ★.</p>' : "")
    + (show("language") ? (part ? "" : '<p class="group-label">Translation language</p>')
      + `<div class="inset">${languageSelect(o)}</div>`
      + '<p class="hint">New papers in your journals get abstract translations in this language (older papers are not '
      + "translated again). Full-text summaries you request are written in it (in English with no translation).</p>" : "")
    + "</form>";
}

export function onboardingPage(o) {
  return '<section class="onboarding">'
    + '<img class="login-icon" src="icons/icon-192.png" alt="" width="64" height="64">'
    + "<h1>Welcome</h1>"
    + '<p class="sub">Choose what to follow. You can change these later in Settings.</p>'
    + prefsSections(o)
    + '<p class="msg" role="status"></p>'
    + '<button type="button" class="btn primary wide" data-act="onboarding-done">Start</button>'
    + "</section>";
}

// ---------- Admins: journals and languages ----------

// `o`: {journals: [{id, name, abbr, active, issns, rss}], usage: {id: n}, usageAt, results}
export function journalsAdmin(o) {
  const rows = o.journals.map((j) => {
    const n = o.usage[j.id] ?? 0;
    return `<div class="inset journal${j.active ? "" : " inactive"}" data-journal-id="${e(j.id)}">`
      + `<p class="row"><span class="member-name">${e(j.abbr)}</span><span class="value small">${n} following${j.active ? "" : " · paused"}</span></p>`
      + `<p class="row"><span class="value small">${e(j.name)}${j.issns?.length ? ` · ${e(j.issns.join(", "))}` : ""}${j.rss ? " · RSS" : ""}</span></p>`
      + `<label class="row switch-row"><span>Collect new papers</span><input type="checkbox" class="switch" data-journal-active${j.active ? " checked" : ""}></label>`
      + `<button type="button" class="row danger" data-act="journal-delete">Delete</button>`
      + "</div>";
  }).join("");
  const results = (o.results || []).map((s, i) => (
    `<button type="button" class="row-btn result" data-result="${i}"><span class="row-main"><span class="row-title">${e(s.name)}</span>`
    + `<span class="row-meta">${e(s.issns.join(", ") || "no ISSN")}${s.publisher ? ` · ${e(s.publisher)}` : ""} · ${s.works} works</span></span></button>`
  )).join("");
  const picked = o.picked;
  return `<div class="members">${rows}</div>`
    + `<p class="hint">"Following" counts active users, updated every hour${o.usageAt ? ` (last ${e(o.usageAt.slice(0, 16).replace("T", " "))})` : ""}. `
    + "Paused journals are skipped by the morning run; deleting does not remove papers already collected.</p>"
    + '<p class="group-label">Add a journal</p>'
    + '<form id="journal-search"><div class="inset">'
    + '<label class="row"><span>ISSN or name</span><input type="text" name="q" required autocomplete="off" placeholder="e.g. 0020-8183"></label>'
    + '</div><button type="submit" class="btn wide">Search OpenAlex</button></form>'
    + (results ? `<ul class="rows results">${results.replace(/<button/g, "<li><button").replace(/<\/button>/g, "</button></li>")}</ul>` : "")
    + (o.searchNote ? `<p class="hint">${e(o.searchNote)}</p>` : "")
    + (picked ? '<form id="journal-add"><div class="inset">'
      + `<p class="row"><span class="value small">${e(picked.name)} · ${e(picked.issns.join(", "))}</span></p>`
      + `<label class="row"><span>Name</span><input type="text" name="name" required maxlength="200" value="${e(picked.name)}"></label>`
      + '<label class="row"><span>Abbreviation</span><input type="text" name="abbr" required maxlength="20" autocomplete="off" placeholder="e.g. IO"></label>'
      + '<label class="row"><span>RSS (optional)</span><input type="text" name="rss" maxlength="500" autocomplete="off" placeholder="https://…"></label>'
      + '</div><p class="msg" role="status"></p><button type="submit" class="btn primary wide">Add journal</button>'
      + '<p class="hint">It is collected from the next morning run on, for users who choose it; earlier papers are not added.</p></form>' : "");
}

// `o`: {languages: {code: name}, choices: [[code, name]]}
export function languagesAdmin(o) {
  const rows = Object.entries(o.languages).sort((a, b) => a[1].localeCompare(b[1])).map(([code, name]) => (
    `<div class="row" data-language="${e(code)}"><span>${e(name)} <span class="value small mono">${e(code)}</span></span>`
    + '<button type="button" class="btn link danger" data-act="language-remove">Remove</button></div>'
  )).join("");
  const left = o.choices.filter(([code]) => !o.languages[code]);
  return `<div class="inset">${rows || '<p class="row"><span>No languages: abstracts are not translated.</span></p>'}</div>`
    + (left.length ? '<form id="language-add"><div class="inset"><label class="row"><span>Add</span><span class="select inline"><select name="code">'
      + left.map(([code, name]) => `<option value="${e(code)}">${e(name)}</option>`).join("")
      + `</select>${ICONS.chevronDown}</span></label></div><button type="submit" class="btn wide">Add language</button></form>` : "")
    + '<p class="hint">Users choose one of these. New papers are translated only into languages that someone following '
    + "the journal has chosen; existing papers are not translated again (use --translate on the Mac).</p>";
}
