// Times and time zones for Settings → Daily digest time.
// The hourly job (every hour at :17 UTC) runs the digest at its first check after the set time,
// once a day, in the set time zone (see README "Time zone and schedule" in paper-digest).

// Shown first in the list; the rest follow in alphabetical order
export const COMMON_TIMEZONES = [
  "America/Los_Angeles", "America/Denver", "America/Phoenix", "America/Chicago",
  "America/New_York", "Asia/Tokyo", "Europe/London", "UTC",
];

// The same check as the security rules, so the list never offers a name they would refuse
const ALLOWED = /^(UTC|[A-Z][A-Za-z_]+(\/[A-Za-z0-9_+-]+){1,2})$/;
const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export const validTime = (value) => TIME.test(value || "");

export function validTimezone(name) {
  if (!ALLOWED.test(name || "") || name.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

export function timezoneOptions() {
  let all = [];
  try { all = Intl.supportedValuesOf("timeZone"); } catch { /* older browsers: common ones only */ }
  const rest = all.filter((z) => !COMMON_TIMEZONES.includes(z) && validTimezone(z)).sort();
  return { common: COMMON_TIMEZONES.filter(validTimezone), rest };
}

// Every 15 minutes: [["05:00", "5:00 AM"], ...]
export function timeOptions() {
  const out = [];
  for (let m = 0; m < 24 * 60; m += 15) {
    const h = Math.floor(m / 60);
    const value = `${String(h).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    out.push([value, `${h % 12 || 12}:${String(m % 60).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`]);
  }
  return out;
}

// Calendar date and clock time of an instant in a time zone
function partsIn(timezone, date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    y: Number(parts.year), m: Number(parts.month), d: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second),
  };
}

// The instant when it is y-m-d hh:mm in a time zone
function instantOf(timezone, y, m, d, hour, minute) {
  const guess = Date.UTC(y, m - 1, d, hour, minute);
  const shown = partsIn(timezone, new Date(guess));
  const offset = Date.UTC(shown.y, shown.m - 1, shown.d, shown.hour, shown.minute) - guess;
  return new Date(guess - offset);
}

const fmtTime = (date, timezone) => new Intl.DateTimeFormat("en-US", {
  timeZone: timezone, hour: "numeric", minute: "2-digit", timeZoneName: "short",
}).format(date);

const fmtDay = (date, timezone) => new Intl.DateTimeFormat("en-US", {
  timeZone: timezone, weekday: "short", month: "short", day: "numeric",
}).format(date);

// "Tomorrow 5:00 AM PDT", "Today 5:00 AM PDT" or "Due now (at the next hourly check)".
// `lastRun` is meta/calendar.last_run ({date, finished_at, limit, ...}).
export function nextRunText(digestTime, timezone, lastRun, now = new Date()) {
  const [hour, minute] = digestTime.split(":").map(Number);
  const today = partsIn(timezone, now);
  const ranToday = lastRun && lastRun.date === today.date && (lastRun.limit === null || lastRun.limit === undefined);
  const dueToday = instantOf(timezone, today.y, today.m, today.d, hour, minute);
  if (!ranToday && now < dueToday) return `Today ${fmtTime(dueToday, timezone)}`;
  if (!ranToday) return "Due now (at the next hourly check)";
  const tomorrow = new Date(Date.UTC(today.y, today.m - 1, today.d + 1));
  const due = instantOf(timezone, tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate(), hour, minute);
  return `Tomorrow ${fmtTime(due, timezone)}`;
}

// "YYYY-MM" now in a time zone (for counting this month's full-text summaries)
export function monthIn(timezone, now = new Date()) {
  try {
    return partsIn(timezone, now).date.slice(0, 7);
  } catch {
    return partsIn("UTC", now).date.slice(0, 7);
  }
}

// "Sun, Oct 4, 7:53 AM PDT · 6 new papers · manual run"
export function lastRunText(lastRun, timezone) {
  if (!lastRun?.finished_at) return "No run recorded yet";
  const at = new Date(lastRun.finished_at);
  if (Number.isNaN(at.getTime())) return lastRun.finished_at;
  const parts = [`${fmtDay(at, timezone)}, ${fmtTime(at, timezone)}`];
  if (typeof lastRun.processed === "number") parts.push(`${lastRun.processed} new ${lastRun.processed === 1 ? "paper" : "papers"}`);
  if (lastRun.trigger) parts.push(`${lastRun.trigger} run${lastRun.limit ? ` (limit ${lastRun.limit})` : ""}`);
  return parts.join(" · ");
}
