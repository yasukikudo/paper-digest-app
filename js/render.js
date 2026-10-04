// HTML for pages and paper cards, following paper_digest/render.py in paper-digest.
// The interface is in English; passages containing Japanese get lang="ja".
// Parts of a card that change with library and requests are in data-slot elements, so live
// updates replace only those (open panels and note drafts stay as they are).

import {
  SECTION_LABELS, SOURCE_LABELS, STATUSES, REQUEST_LABELS, LANGUAGE_NAMES,
} from "./labels.js";

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

function details(label, body, meta = "", attrs = "") {
  const metaHtml = meta ? `<span class="meta">${e(meta)}</span>` : "";
  return `<details${attrs}><summary><span>${e(label)}${metaHtml}</span></summary>`
    + `<div class="panel">${body}</div></details>`;
}

function badges(items) {
  return items.map(([text, cls]) => `<li class="badge ${cls}"${lang(text)}>${e(text)}</li>`).join("");
}

function byline(p) {
  const ships = p.authorships || [];
  const names = p.authors || [];
  const parts = [];
  if (ships.length || names.length) {
    const first = ships[0] || { name: names[0], institution: null };
    let text = first.name;
    if (first.institution) text += ` (${shorten(first.institution, SHORT_AFFILIATION)})`;
    const others = (p.author_count || names.length) - 1;
    if (others > 0) text += ` and ${plural(others, "other")}`;
    parts.push(text);
  }
  parts.push(p.journal_abbr || p.journal, p.published_date);
  return para(parts.filter(Boolean).join(" · "), "byline");
}

function links(p) {
  const items = [];
  if (p.url) items.push(`<a href="${e(p.url)}" target="_blank" rel="noopener">Article page</a>`);
  if (p.oa_url) items.push(`<a href="${e(p.oa_url)}" target="_blank" rel="noopener">Open access version</a>`);
  return items.length ? `<p class="links">${items.join("")}</p>` : "";
}

function careerText(info) {
  if (!info) return "";
  const parts = [];
  if (info.first_year) parts.push(`First paper ${info.first_year}`);
  if (info.works_count !== null && info.works_count !== undefined) parts.push(plural(info.works_count, "paper"));
  if (info.h_index !== null && info.h_index !== undefined) parts.push(`h-index ${info.h_index}`);
  return parts.join(" · ");
}

// Authors panel; its body is filled when opened (author details are loaded then)
function authorsPanel(p) {
  const total = p.author_count || (p.authorships || []).length;
  if (!(p.authorships || []).length) return "";
  return details("Authors", '<p class="more">Loading…</p>', plural(total, "author"), " data-authors");
}

export function authorsBody(p, cache) {
  const ships = p.authorships || [];
  const rows = ships.map((a) => {
    const info = cache.get(a.author_id || "") || {};
    const orcid = a.orcid || info.orcid;
    const name = orcid ? `<a href="${e(orcid)}" target="_blank" rel="noopener">${e(a.name)}</a>` : e(a.name);
    const aff = [a.institution, a.country].filter(Boolean).join(", ") || "No affiliation listed";
    const career = careerText(info);
    return `<li>${name} <span class="aff"${lang(aff)}>— ${e(aff)}</span>`
      + (career ? `<span class="career">${e(career)}</span>` : "") + "</li>";
  }).join("");
  const total = p.author_count || ships.length;
  const more = total > ships.length
    ? `<p class="more">${plural(total - ships.length, "more author")} not shown</p>` : "";
  return `<ul class="authors">${rows}</ul>${more}`;
}

export function fulltextPanel(entry) {
  const ft = entry?.fulltext;
  if (!ft) return "";
  const meta = `${SOURCE_LABELS[ft.source] || ft.source} · ${(ft.created_at || "").slice(0, 10)}`;
  let body;
  if (ft.sections) {
    body = '<dl class="sections">' + SECTION_LABELS.filter(([key]) => ft.sections[key])
      .map(([key, label]) => `<dt>${label}</dt><dd${lang(ft.sections[key])}>${e(ft.sections[key])}</dd>`)
      .join("") + "</dl>";
    if (ft.one_liner) body = `<p class="ft-oneliner"${lang(ft.one_liner)}>${e(ft.one_liner)}</p>` + body;
  } else {
    body = `<div class="markdown"${lang(ft.markdown)}>${e(ft.markdown)}</div>`;
  }
  return details("Full-text summary", body, meta);
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

export function stateBadges(entry, withSavedDate = false) {
  const items = [];
  if (entry?.fulltext) {
    items.push([withSavedDate ? `Full text · ${SOURCE_LABELS[entry.fulltext.source] || ""}` : "Full text", "ft"]);
  }
  if (entry?.saved) items.push([withSavedDate && entry.saved_at ? `Saved ${entry.saved_at}` : "Saved", "saved"]);
  return items;
}

export function accessBadge(p) {
  if (p.fulltext_access === "auto") return [["OA", ""]];
  if (p.fulltext_access === "manual") return [["OA (manual download)", ""]];
  return [];
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
};

// Buttons and request state under a paper
export function actions(p, entry, request, busy) {
  const saved = Boolean(entry?.saved);
  const out = [];
  out.push(saved
    ? `<button type="button" class="btn on" data-act="unsave" aria-pressed="true">${ICONS.bookmarkFilled}<span>Saved</span></button>`
    : `<button type="button" class="btn" data-act="save" aria-pressed="false">${ICONS.bookmark}<span>Save</span></button>`);
  out.push('<span class="seg" role="group" aria-label="Status">' + STATUSES.map(([code, label]) => {
    const on = saved && entry.status === code;
    return `<button type="button" data-act="status" data-status="${code}" class="${on ? "on" : ""}"`
      + ` aria-pressed="${on}">${code === "read" ? ICONS.read : ICONS.toRead}<span>${label}</span></button>`;
  }).join("") + "</span>");
  out.push(`<button type="button" class="btn icon-only" data-act="note" aria-label="Add note">${ICONS.note}</button>`);

  const active = request && (request.status === "pending" || request.status === "processing");
  let req = "";
  if (active || (request && request.status === "done" && !entry?.fulltext)) {
    req = `<p class="pill ${request.status}">${ICONS.clock}<span>${REQUEST_LABELS[request.status]}</span></p>`;
  } else if (!entry?.fulltext && p.fulltext_access === "auto") {
    const failed = request?.status === "failed";
    req = (failed ? `<p class="req-error">${ICONS.alert}<span>${REQUEST_LABELS.failed}: ${e(request.error || "no reason given")}</span></p>` : "")
      + `<button type="button" class="btn request" data-act="request"${busy ? " disabled" : ""}>${ICONS.request}`
      + `<span>${busy ? "Requesting…" : failed ? "Request again" : "Request full-text summary"}</span></button>`;
  } else if (!entry?.fulltext && p.fulltext_access === "manual") {
    req = `<p class="pill manual">${ICONS.pdf}<span>PDF needed</span></p>`;
    if (request?.status === "failed") req += `<p class="req-error">${ICONS.alert}<span>${REQUEST_LABELS.failed}: ${e(request.error || "")}</span></p>`;
  }
  return `<div class="buttons">${out.join("")}</div>${req ? `<div class="request-state">${req}</div>` : ""}`;
}

// ---------- Cards ----------

export function dayCard(p, day, fieldNames, state) {
  const highlighted = (p.relevance ?? 0) >= day.highlight_threshold;
  const fixed = [[`Relevance ${p.relevance ?? "–"}`, ""], [fieldNames.get(p.field) || p.field || "Other", ""]];
  if (highlighted) fixed.push(["Highlight", "hl"]);
  fixed.push(...accessBadge(p));
  const code = day.languages?.abstract_translation || "ja";
  const parts = [
    `<article class="paper${highlighted ? " highlighted" : ""}" data-key="${e(p.doi_key)}" data-fixed-badges="${e(JSON.stringify(fixed))}">`,
    `<ul class="badges" data-slot="badges">${badges([...fixed, ...stateBadges(state.entry)])}</ul>`,
    `<h3 class="title"><a href="${e(p.url || "")}" target="_blank" rel="noopener">${e(p.title)}</a></h3>`,
    byline(p),
    p.one_liner ? para(p.one_liner, "oneliner") : "",
    highlighted && p.relevance_reason ? para(p.relevance_reason, "reason") : "",
    `<div class="actions" data-slot="actions">${actions(p, state.entry, state.request, state.busy)}</div>`,
    `<div data-slot="notes">${notesList(state.entry)}</div>`,
    links(p),
    '<div class="panels">',
    `<div data-slot="fulltext">${fulltextPanel(state.entry)}</div>`,
    p.abstract_translation
      ? details(`Abstract translation (${LANGUAGE_NAMES[code] || code})`, para(p.abstract_translation)) : "",
    p.abstract ? details("Abstract (original)", `<p class="abstract-en">${e(p.abstract)}</p>`) : "",
    authorsPanel(p),
    "</div></article>",
  ];
  return parts.join("");
}

export function libraryCard(p, entry, state) {
  const fixed = accessBadge(p);
  const oneLiner = entry.fulltext?.one_liner || p.one_liner;
  return [
    `<article class="paper" data-key="${e(entry.doi_key)}" data-library="1" data-fixed-badges="${e(JSON.stringify(fixed))}">`,
    `<ul class="badges" data-slot="badges">${badges([...stateBadges(entry, true), ...fixed])}</ul>`,
    `<h3 class="title"><a href="${e(p.url || "")}" target="_blank" rel="noopener">${e(p.title || entry.doi)}</a></h3>`,
    byline(p),
    `<div data-slot="oneliner">${oneLiner ? para(oneLiner, "oneliner") : ""}</div>`,
    `<div class="actions" data-slot="actions">${actions(p, entry, state.request, state.busy)}</div>`,
    `<div data-slot="notes">${notesList(entry)}</div>`,
    links(p),
    '<div class="panels">',
    `<div data-slot="fulltext">${fulltextPanel(entry)}</div>`,
    authorsPanel(p),
    "</div></article>",
  ].join("");
}

// Badges of a card after a library change (fixed badges + state badges)
export function cardBadges(card, entry) {
  const fixed = JSON.parse(card.dataset.fixedBadges || "[]");
  return card.dataset.library ? badges([...stateBadges(entry, true), ...fixed]) : badges([...fixed, ...stateBadges(entry)]);
}

// Grey placeholder cards shown while data loads
export function skeleton(n = 3) {
  const card = '<div class="sk-card"><div class="sk-line w30"></div><div class="sk-line w90 tall"></div>'
    + '<div class="sk-line w70 tall"></div><div class="sk-line w50"></div><div class="sk-line w100"></div>'
    + '<div class="sk-line w80"></div></div>';
  return `<div class="skeleton" aria-busy="true" aria-label="Loading">${card.repeat(n)}</div>`;
}

// ---------- Top bar ----------

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function weekday(date) {
  const [y, m, d] = date.split("-").map(Number);
  return WEEKDAYS[new Date(y, m - 1, d).getDay()];
}

// On a day: ‹ date › (the date opens a date picker). Elsewhere: the page title.
export function appBar({ title, date, prev, next, min, max }) {
  if (date === undefined) return `<div class="appbar-inner"><h1 class="appbar-title">${e(title)}</h1></div>`;
  const arrow = (target, label, icon) => (target
    ? `<a class="appbar-btn" href="#/day/${target}" aria-label="${label}">${icon}</a>`
    : `<span class="appbar-btn off" aria-hidden="true">${icon}</span>`);
  return '<div class="appbar-inner">'
    + arrow(prev, "Previous day", ICONS.chevronLeft)
    + '<label class="date-pick">'
    + `<span class="date-main">${e(date || "No digest")}</span>`
    + (date ? `<span class="date-sub">${weekday(date)}</span>` : "")
    + `<input type="date" value="${e(date || "")}" min="${e(min || "")}" max="${e(max || "")}" aria-label="Open a date">`
    + "</label>"
    + arrow(next, "Next day", ICONS.chevronRight)
    + "</div>";
}

// ---------- Pages ----------

export function dayPage(day, papers, fieldList, stateOf) {
  const fieldNames = new Map(fieldList.map((f) => [f.id, f.name]));
  const groups = new Map();
  for (const p of papers) {
    const f = p.field || "other";
    if (!groups.has(f)) groups.set(f, []);
    groups.get(f).push(p);
  }
  for (const list of groups.values()) list.sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0));
  const order = [...fieldList.map((f) => f.id).filter((f) => groups.has(f)),
    ...[...groups.keys()].filter((f) => !fieldNames.has(f))];
  const name = (f) => fieldNames.get(f) || f;
  const toc = order.map((f) => (
    `<li><a href="#f-${e(f)}" data-jump="f-${e(f)}">${e(name(f))}<span class="n">${groups.get(f).length}</span></a></li>`
  )).join("");
  const sections = order.map((f) => (
    `<section class="group" id="f-${e(f)}"><h2>${e(name(f))}<span class="n">${groups.get(f).length}</span></h2>`
    + groups.get(f).map((p) => dayCard(p, day, fieldNames, stateOf(p.doi_key))).join("") + "</section>"
  )).join("");
  const failed = [...new Set((day.runs || []).flatMap((r) => r.failed_journals || []))];
  const foot = failed.length
    ? `<p class="run-note">Journals that failed to load in this day's runs: ${e(failed.join(", "))}</p>` : "";
  return '<header class="page-head">'
    + `<p class="sub">${plural(day.paper_count ?? papers.length, "paper")} · ${plural(day.highlight_count ?? 0, "highlight")}</p></header>`
    + (toc ? `<ul class="toc">${toc}</ul>` : "")
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

export function settingsPage(email) {
  const pin = (name, label, auto) => `<label class="row"><span>${label}</span><input type="password" name="${name}"`
    + ` inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="${auto}" placeholder="••••••" required></label>`;
  return '<section class="settings">'
    + `<p class="group-label">Account</p><div class="inset"><p class="row"><span>Signed in as</span><span class="value">${e(email)}</span></p></div>`
    + '<p class="group-label">Change PIN</p><form id="pin-form"><div class="inset">'
    + pin("current", "Current PIN", "current-password") + pin("next", "New PIN", "new-password")
    + pin("again", "New PIN again", "new-password") + "</div>"
    + '<p class="msg" role="status"></p><button type="submit" class="btn primary wide">Change PIN</button></form>'
    + '<div class="inset signout"><button type="button" class="row danger" data-act="signout">Sign out</button></div>'
    + '<p class="hint">After signing out, this device remembers the email; you will only need the PIN.</p>'
    + "</section>";
}
