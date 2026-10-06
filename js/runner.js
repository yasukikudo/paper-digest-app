// Run now (admins): start the GitHub Actions job from this device, because GitHub's scheduled
// runs are often late or skipped. Uses the workflow_dispatch API with a fine-grained personal
// access token that the admin enters in Settings -> Run now. The token and the repository name
// (owner/repo) are kept only in this browser's localStorage: never in Firestore, never in this
// code. The token needs only "Actions: Read and write" on that one repository.
// The job runs the morning digest at most once a day however often it is started, so a
// misused token cannot run up costs.

import { e } from "./render.js";

const KEY = {
  repo: "paper-digest.gh.repo", token: "paper-digest.gh.token", branch: "paper-digest.gh.branch",
  expires: "paper-digest.gh.expires", auto: "paper-digest.gh.auto", autoAt: "paper-digest.gh.auto-at",
  run: "paper-digest.gh.run",
};
const WORKFLOW = "digest.yml";
export const AUTO_PAUSE_MS = 30 * 60 * 1000;   // no second automatic start within 30 minutes

const get = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const set = (k, v) => { try { if (v === null || v === undefined) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* not available */ } };
const getJson = (k) => { try { return JSON.parse(get(k) || "null"); } catch { return null; } };

// What this device has (never the token itself)
export function settings() {
  return {
    repo: get(KEY.repo) || "",
    hasToken: Boolean(get(KEY.token)),
    expires: get(KEY.expires) || "",
    auto: get(KEY.auto) !== "off",
    run: getJson(KEY.run),
  };
}

export const setAuto = (on) => set(KEY.auto, on ? "on" : "off");
export const ready = () => Boolean(get(KEY.repo) && get(KEY.token));

async function api(path, { method = "GET", body, token = get(KEY.token), repo = get(KEY.repo) } = {}) {
  const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).message || ""; } catch { /* no body */ }
    const why = res.status === 401 ? "the token is not valid or has expired"
      : res.status === 403 ? "the token lacks the Actions permission for this repository"
        : res.status === 404 ? "repository or workflow not found (check owner/repo and the token's repository access)"
          : `GitHub answered ${res.status}`;
    throw new Error(detail && res.status >= 500 ? `${why}: ${detail}` : why);
  }
  return res.status === 204 ? null : res.json();
}

// Check and keep the repository and token on this device. `expires`: optional YYYY-MM-DD
// (GitHub does not let the browser read the token's expiry, so it is entered by hand).
export async function save(repo, token, expires) {
  repo = repo.trim().replace(/^https:\/\/github\.com\//, "").replace(/\/+$/, "");
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) throw new Error("Enter the repository as owner/repo");
  token = token.trim() || get(KEY.token) || "";
  if (!token) throw new Error("Enter the token");
  const info = await api("", { token, repo });
  await api(`/actions/workflows/${WORKFLOW}`, { token, repo });
  set(KEY.repo, repo);
  set(KEY.token, token);
  set(KEY.branch, info.default_branch || "main");
  set(KEY.expires, expires || null);
}

export function removeToken() {
  set(KEY.token, null);
  set(KEY.run, null);
}

// Start the job. kind: "digest" (today's digest unless it has run, then requests) or
// "requests" (requests only). trigger: "app" or "app-auto". Returns the run being watched.
export async function start(kind, trigger = "app") {
  const since = Date.now() - 10_000;
  const inputs = kind === "digest"
    ? { digest: "today", requests: "true", trigger }
    : { digest: "skip", requests: "true", trigger };
  if (trigger === "app-auto") set(KEY.autoAt, String(Date.now()));   // also pauses retries after a failure
  await api(`/actions/workflows/${WORKFLOW}/dispatches`, { method: "POST", body: { ref: get(KEY.branch) || "main", inputs } });
  const run = { id: null, kind, since, status: "requested", conclusion: null, url: null, startedAt: Date.now() };
  set(KEY.run, JSON.stringify(run));
  return run;
}

// Bring the watched run up to date: find it (the newest dispatched run since it was started),
// then read its status. Returns the run, or null if none is being watched.
export async function refresh() {
  const run = getJson(KEY.run);
  if (!run) return null;
  if (!run.id) {
    const list = await api(`/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=5`);
    const found = (list.workflow_runs || []).find((r) => Date.parse(r.created_at) >= run.since);
    if (!found) {
      // Not listed yet; give up after 2 minutes
      if (Date.now() - run.startedAt > 120_000) { set(KEY.run, null); throw new Error("the run did not appear on GitHub"); }
      return run;
    }
    run.id = found.id;
  }
  const r = await api(`/actions/runs/${run.id}`);
  Object.assign(run, { status: r.status, conclusion: r.conclusion, url: r.html_url });
  set(KEY.run, JSON.stringify(run));
  return run;
}

export const active = (run) => Boolean(run && run.status !== "completed");
export const forget = () => set(KEY.run, null);

// Whether opening the app should start today's digest: token on this device, the switch on,
// not started automatically in the last 30 minutes, and no run being watched
export function mayAutoStart() {
  const s = settings();
  return ready() && s.auto && !active(s.run) && Date.now() - Number(get(KEY.autoAt) || 0) > AUTO_PAUSE_MS;
}

// ---------- The page (Settings -> Run now) ----------

const STATUS = {
  requested: "Starting…", queued: "Queued", waiting: "Waiting", pending: "Queued",
  in_progress: "Running",
};
export function statusText(run) {
  if (!run) return "";
  if (run.status !== "completed") return STATUS[run.status] || "Running";
  return run.conclusion === "success" ? "Succeeded" : run.conclusion === "cancelled" ? "Cancelled" : "Failed";
}

function daysLeft(expires) {
  if (!expires) return null;
  return Math.round((Date.parse(`${expires}T00:00:00`) - Date.now()) / 86_400_000);
}

export function page() {
  const s = settings();
  const busy = active(s.run);
  const left = daysLeft(s.expires);
  const expiry = !s.hasToken ? "" : s.expires
    ? `${e(s.expires)}${left !== null && left <= 30 ? ` · <span class="warn">${left < 0 ? "expired" : `${left} days left: make a new token`}</span>` : ""}`
    : "unknown";
  const status = s.run
    ? `<p class="row run-status ${s.run.status === "completed" ? (s.run.conclusion === "success" ? "ok" : "bad") : "busy"}">`
      + `<span>${s.run.kind === "digest" ? "Today's digest" : "Requests"}: <b>${statusText(s.run)}</b></span>`
      + (s.run.url ? `<a class="value small" href="${e(s.run.url)}" target="_blank" rel="noopener">View on GitHub</a>` : "")
      + "</p>" : "";
  return '<p class="group-label">Start now</p>'
    + `<div class="stack run-buttons">`
    + `<button type="button" class="btn primary wide" data-act="run-digest"${!s.hasToken || busy ? " disabled" : ""}>Run today's digest</button>`
    + `<button type="button" class="btn wide" data-act="run-requests"${!s.hasToken || busy ? " disabled" : ""}>Process requests</button>`
    + "</div>"
    + (status ? `<div class="inset run-inset">${status}</div>` : "")
    + `<p class="hint">${s.hasToken ? "Today's digest runs at most once a day; if it has already run, the job only checks and ends." : "Save a GitHub token below to use these buttons."}</p>`
    + '<p class="group-label">When the app opens</p><div class="inset">'
    + `<label class="row switch-row${s.hasToken ? "" : " disabled"}"><span>Start today's digest if it is late</span>`
    + `<input type="checkbox" class="switch" data-act="run-auto"${s.auto ? " checked" : ""}${s.hasToken ? "" : " disabled"}></label></div>`
    + '<p class="hint">Only on this device, and only when the set time has passed and today\'s digest is missing; not again within 30 minutes.</p>'
    + '<p class="group-label">GitHub token on this device</p>'
    + '<form id="run-form"><div class="inset">'
    + `<label class="row"><span>Repository</span><input type="text" name="repo" placeholder="owner/repo" autocomplete="off" autocapitalize="off" spellcheck="false" value="${e(s.repo)}"></label>`
    + `<label class="row"><span>Token</span><input type="password" class="token" name="token" autocomplete="off" placeholder="${s.hasToken ? "Saved (enter to replace)" : "github_pat_…"}"></label>`
    + `<label class="row"><span>Expires</span><input type="date" name="expires" value="${e(s.expires)}"></label>`
    + `<p class="row"><span>Status</span><span class="value small">${s.hasToken ? `Token saved on this device · expires ${expiry}` : "No token on this device"}</span></p>`
    + '</div><p class="msg" role="status"></p>'
    + '<button type="submit" class="btn wide">Save</button>'
    + (s.hasToken ? '<button type="button" class="btn link danger" data-act="run-forget">Remove token from this device</button>' : "")
    + "</form>"
    + '<p class="hint">The token stays in this browser only (not in Firestore). It needs only "Actions: Read and write" on this one repository. Fine-grained tokens expire; make a new one before then.</p>';
}
