// The admins' Costs page: estimated Claude API costs from costs/{YYYY-MM-DD} (written by the
// scripts), totals for today / this week / this month, a bar chart by day, week or month (inline
// SVG), the breakdown of the chosen period and the monthly budget. Dates are in the time zone
// of settings/app, like the documents.

import { e, plural } from "./render.js";

export const KIND_LABELS = {
  digest: "Morning digest",
  fulltext: "Full-text summaries",
  translate: "Added translations",
  other: "Other",
};
export const PERIODS = { day: "Days", week: "Weeks", month: "Months" };
const SPAN = { day: 30, week: 12, month: 12 };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ---------- Dates (YYYY-MM-DD strings, calendar arithmetic in UTC) ----------

export const todayIn = (timezone) => new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
const toDate = (s) => new Date(`${s}T00:00:00Z`);
const fromDate = (d) => d.toISOString().slice(0, 10);
export const addDays = (s, n) => { const d = toDate(s); d.setUTCDate(d.getUTCDate() + n); return fromDate(d); };
export const weekStart = (s) => addDays(s, -((toDate(s).getUTCDay() + 6) % 7));   // Monday
const addMonths = (month, n) => {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return fromDate(d).slice(0, 7);
};

// The key of the period a day belongs to
export const keyOf = (period, date) => (period === "day" ? date : period === "week" ? weekStart(date) : date.slice(0, 7));

// The periods shown in the chart, oldest first
export function periodKeys(period, today) {
  const n = SPAN[period];
  if (period === "day") return Array.from({ length: n }, (_, i) => addDays(today, i - n + 1));
  if (period === "week") return Array.from({ length: n }, (_, i) => addDays(weekStart(today), 7 * (i - n + 1)));
  return Array.from({ length: n }, (_, i) => addMonths(today.slice(0, 7), i - n + 1));
}

// The first day the page needs (12 months back covers 30 days and 12 weeks)
export const firstNeeded = (today) => `${addMonths(today.slice(0, 7), -11)}-01`;

// ---------- Adding up ----------

const plus = (a = {}, b = {}) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] || 0) + (typeof v === "number" ? v : 0);
  return out;
};

// Totals of the days whose key (for `period`) is `key`
export function aggregate(docs, period, key) {
  const sum = { total: 0, estimated: 0, kinds: {}, users: {}, models: {}, days: 0 };
  for (const [date, d] of docs) {
    if (keyOf(period, date) !== key) continue;
    sum.days += 1;
    sum.total += d.total_usd || 0;
    sum.estimated += d.estimated_usd || 0;
    for (const [k, v] of Object.entries(d.kinds || {})) sum.kinds[k] = plus(sum.kinds[k], v);
    for (const [k, v] of Object.entries(d.fulltext_users || {})) sum.users[k] = plus(sum.users[k], v);
    for (const [k, v] of Object.entries(d.models || {})) sum.models[k] = plus(sum.models[k], v);
  }
  return sum;
}

// ---------- HTML ----------

export const usd = (v) => (v >= 100 ? `$${v.toFixed(0)}` : v >= 1 ? `$${v.toFixed(2)}` : v > 0 ? `$${v.toFixed(v < 0.01 ? 4 : 3)}` : "$0");
const num = (n) => Number(n || 0).toLocaleString("en-US");

function label(period, key, short = false) {
  if (period === "month") {
    const [y, m] = key.split("-").map(Number);
    return short ? MONTHS[m - 1] : `${MONTHS[m - 1]} ${y}`;
  }
  const [, m, d] = key.split("-").map(Number);
  const text = `${MONTHS[m - 1]} ${d}`;
  return short || period === "day" ? text : `Week of ${text}`;
}

// Bar chart: one bar per period; the estimated (rebuilt) part of a bar is lighter
function chart(c) {
  const keys = periodKeys(c.period, c.today);
  const sums = keys.map((k) => aggregate(c.docs, c.period, k));
  const max = Math.max(...sums.map((s) => s.total), 0.0001);
  const W = 640, H = 160, top = 8, bottom = 1, gap = c.period === "day" ? 3 : 8;
  const bw = (W - gap * (keys.length - 1)) / keys.length;
  const h = H - top - bottom;
  const every = c.period === "day" ? 7 : c.period === "week" ? 3 : 2;
  const bars = keys.map((k, i) => {
    const s = sums[i];
    const x = i * (bw + gap);
    const full = (s.total / max) * h;
    const est = (Math.min(s.estimated, s.total) / max) * h;
    const y = top + h - full;
    const on = k === c.selected;
    const name = `${label(c.period, k)}: ${usd(s.total)}${s.estimated ? " (partly estimated)" : ""}`;
    return `<g class="bar${on ? " on" : ""}" data-cost-key="${e(k)}" role="button" tabindex="0" aria-label="${e(name)}" aria-pressed="${on}">`
      + `<title>${e(name)}</title>`
      + `<rect class="hit" x="${x}" y="${top}" width="${bw}" height="${h}"></rect>`
      + (full > 0 ? `<rect class="val" x="${x}" y="${y}" width="${bw}" height="${Math.max(full, 1.5)}"></rect>` : "")
      + (est > 0 ? `<rect class="est" x="${x}" y="${y}" width="${bw}" height="${Math.max(est, 1.5)}"></rect>` : "")
      + "</g>";
  }).join("");
  // Date labels in HTML under the bars (SVG text would be stretched with the chart)
  const labels = keys.map((k, i) => (i % every === (keys.length - 1) % every
    ? `<span style="left:${((i * (bw + gap) + bw / 2) / W) * 100}%">${e(label(c.period, k, true))}</span>` : "")).join("");
  return `<svg class="cost-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="group" aria-label="Costs by ${c.period}">`
    + `<line class="base" x1="0" x2="${W}" y1="${top + h}" y2="${top + h}"></line>${bars}</svg>`
    + `<div class="chart-labels" aria-hidden="true">${labels}</div>`
    + `<p class="chart-scale">Highest: ${usd(max === 0.0001 ? 0 : max)}${sums.some((s) => s.estimated) ? " · lighter: estimated" : ""}</p>`;
}

function breakdown(c) {
  const s = aggregate(c.docs, c.period, c.selected);
  const rows = (entries, labelOf) => entries.map(([k, v]) => `<p class="row cost-row"><span>${e(labelOf(k))}`
    + `<span class="value small"> · ${plural(v.calls || 0, "call")}</span></span><span class="value">${usd(v.usd || 0)}</span></p>`).join("");
  const kinds = Object.entries(s.kinds).filter(([, v]) => v.usd || v.calls)
    .sort((a, b) => Object.keys(KIND_LABELS).indexOf(a[0]) - Object.keys(KIND_LABELS).indexOf(b[0]));
  const users = Object.entries(s.users).sort((a, b) => (b[1].usd || 0) - (a[1].usd || 0));
  const models = Object.entries(s.models);
  return `<p class="group-label">${e(label(c.period, c.selected))} · ${usd(s.total)}</p>`
    + (s.estimated ? `<p class="hint">Includes ${usd(s.estimated)} rebuilt from older run logs (estimated).</p>` : "")
    + (kinds.length ? `<div class="inset">${rows(kinds, (k) => KIND_LABELS[k] || k)}</div>`
      : '<div class="inset"><p class="row"><span class="value">No API calls in this period.</span></p></div>')
    + (users.length ? '<p class="group-label">Full-text summaries by user</p>'
      + `<div class="inset">${rows(users, (uid) => c.names.get(uid) || "Former user")}</div>` : "")
    + (models.length ? '<p class="group-label">Tokens by model</p><div class="inset">' + models.map(([m, v]) => (
      `<div class="row model-row"><span class="mono">${e(m)}</span><span class="value small">`
      + `in ${num(v.input)} · cache ${num((v.cache_write || 0) + (v.cache_read || 0))} · out ${num(v.output)}</span></div>`)).join("") + "</div>" : "");
}

function budgetBlock(c) {
  const month = aggregate(c.docs, "month", c.today.slice(0, 7)).total;
  const b = c.budget;
  let meter = "";
  if (b > 0) {
    const pct = (month / b) * 100;
    const scale = Math.max(120, Math.ceil(pct / 10) * 10);
    const pos = (v) => `${Math.min(v, scale) / scale * 100}%`;
    const level = pct >= 100 ? "over" : pct >= 80 ? "near" : "";
    meter = `<div class="meter ${level}" role="img" aria-label="${Math.round(pct)}% of the monthly budget">`
      + `<span class="fill" style="width:${pos(pct)}"></span>`
      + `<i class="tick" style="left:${pos(80)}"></i><i class="tick" style="left:${pos(100)}"></i></div>`
      + `<p class="meter-text"><b>${Math.round(pct)}%</b> of ${usd(b)} this month · notices to admins at 80% and 100%</p>`;
  }
  return '<p class="group-label">Monthly budget</p>'
    + `<form id="budget-form"><div class="inset"><label class="row"><span>Budget (USD per month)</span>`
    + `<input type="number" class="limit" name="budget" min="0" max="100000" step="0.5" inputmode="decimal" placeholder="None" value="${b > 0 ? e(String(b)) : ""}"></label></div>`
    + `${meter}<p class="msg" role="status"></p><button type="submit" class="btn wide">Save budget</button></form>`;
}

// c: {docs: Map, today, period, selected, budget, names: Map uid → display name}
export function costsPage(c) {
  const tot = (period) => aggregate(c.docs, period, keyOf(period, c.today)).total;
  const card = (title, v) => `<div class="cost-card"><span>${title}</span><b>${usd(v)}</b></div>`;
  const seg = Object.entries(PERIODS).map(([p, l]) => (
    `<button type="button" data-cost-period="${p}" class="${p === c.period ? "on" : ""}" aria-pressed="${p === c.period}">${l}</button>`)).join("");
  return '<div class="cost-cards">' + card("Today", tot("day")) + card("This week", tot("week")) + card("This month", tot("month")) + "</div>"
    + `<div class="chart-head"><span class="seg" role="group" aria-label="Chart by">${seg}</span></div>`
    + `<div class="chart-box">${chart(c)}</div>`
    + breakdown(c)
    + budgetBlock(c)
    + '<p class="hint fine">Amounts are estimates from token counts and list prices. Check the exact charges in the Anthropic Console.</p>';
}
