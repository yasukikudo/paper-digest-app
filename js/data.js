// Firebase: sign-in and Firestore reads, writes and live updates.
// Data formats are described in schema.md in the (private) paper-digest repository.
// Papers are always addressed by the stored doi_key; keys are never computed from DOIs.
//
// Shared: days, papers, authors, meta, index, journals, settings/app, settings/languages.
// The user list: users/{uid}. Each user's own data: users/{uid}/library, summaries (full-text
// summaries, written by the scripts), settings/seen, settings/notify, settings/prefs,
// push_tokens (only that user can read them).

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
  EmailAuthProvider, reauthenticateWithCredential, updatePassword,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, addDoc, setDoc, updateDoc, deleteDoc, onSnapshot,
  runTransaction, arrayUnion, query, where,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const SCHEMA_VERSION = 13;

export const app = initializeApp(firebaseConfig);
const auth = getAuth(app);   // stays signed in on this device until sign-out
const db = getFirestore(app);

// The signed-in user; every per-user path below is under users/{uid}
let uid = null;
export const setUid = (value) => { uid = value; };
const mine = (...path) => doc(db, "users", uid, ...path);

// ---------- Times (ISO 8601 with the device's UTC offset, like the scripts) ----------

const pad = (n) => String(n).padStart(2, "0");

export function isoNow(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return `${localDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    + `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

export function localDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ---------- Sign-in ----------

export const watchUser = (callback) => onAuthStateChanged(auth, callback);
export const signIn = (email, pin) => signInWithEmailAndPassword(auth, email, pin);
export const signOutUser = () => signOut(auth);

export async function changePin(currentPin, newPin) {
  const user = auth.currentUser;
  await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, currentPin));
  await updatePassword(user, newPin);
}

// ---------- Users (users/{uid}) ----------

// This account's entry in the user list (null if not registered)
export async function getUserEntry(id) {
  const snap = await getDoc(doc(db, "users", id));
  return snap.exists() ? snap.data() : null;
}

// Admins only
export async function listUsers() {
  const snap = await getDocs(collection(db, "users"));
  return new Map(snap.docs.map((d) => [d.id, d.data()]));
}

export function addUser(id, { displayName, fulltextAllowed, monthlyLimit, journalAllowed = true }) {
  return setDoc(doc(db, "users", id), {
    schema_version: SCHEMA_VERSION, display_name: displayName, role: "member", active: true,
    added_at: isoNow(), fulltext_allowed: fulltextAllowed, monthly_limit: monthlyLimit,
    journal_allowed: journalAllowed,
  });
}

export const updateUser = (id, fields) => updateDoc(doc(db, "users", id), fields);

// ---------- Shared reads ----------

export async function dayIds() {
  const snap = await getDocs(collection(db, "days"));
  return snap.docs.map((d) => d.id).sort();
}

export async function getDay(date) {
  const snap = await getDoc(doc(db, "days", date));
  return snap.exists() ? snap.data() : null;
}

// Light documents written by the scripts: meta/calendar, meta/index, meta/journal_usage (null if missing)
export async function getMeta(name) {
  const snap = await getDoc(doc(db, "meta", name));
  return snap.exists() ? snap.data() : null;
}


// One shard of the paper index (index/{id}): its entries, newest first
export async function getIndexShard(id) {
  const snap = await getDoc(doc(db, "index", id));
  return snap.exists() ? snap.data().papers || [] : [];
}

// Fetch shared documents by ID, using and filling `cache` (a Map). Missing documents map to null.
export async function getMany(name, ids, cache) {
  const wanted = [...new Set(ids)].filter((id) => id && !cache.has(id));
  const snaps = await Promise.all(wanted.map((id) => getDoc(doc(db, name, id))));
  snaps.forEach((s, i) => cache.set(wanted[i], s.exists() ? s.data() : null));
  return ids.map((id) => cache.get(id));
}

// ---------- Journals (admins, and members the admin allows) and translation languages (admins) ----------

export async function listJournals() {
  const snap = await getDocs(collection(db, "journals"));
  return new Map(snap.docs.map((d) => [d.id, d.data()]));
}

// `addedBy`: a member's display name (the rules require it for members; admins leave it out)
export function addJournal(id, { name, abbr, issnPrint, issnOnline, rss, openalexId, addedBy }) {
  return setDoc(doc(db, "journals", id), {
    schema_version: SCHEMA_VERSION, name, abbr, issn_print: issnPrint || null, issn_online: issnOnline || null,
    rss: rss || null, active: true, openalex_id: openalexId || null, added_at: isoNow(),
    ...(addedBy ? { added_by: addedBy } : {}),
  });
}

export const renameJournal = (id, name) => updateDoc(doc(db, "journals", id), { name });

export const setJournalActive = (id, active) => updateDoc(doc(db, "journals", id), { active });
export const deleteJournal = (id) => deleteDoc(doc(db, "journals", id));

// {code: name}
export async function getLanguages() {
  const snap = await getDoc(doc(db, "settings", "languages"));
  return snap.exists() ? snap.data().languages || {} : {};
}

export const saveLanguages = (languages) => setDoc(doc(db, "settings", "languages"), { languages, updated_at: isoNow() });

// OpenAlex sources (journals) by ISSN or by name; public API, read directly from the browser
export async function searchSources(text) {
  const q = text.trim();
  const issn = q.match(/^\d{4}-?\d{3}[\dXx]$/);
  const url = issn
    ? `https://api.openalex.org/sources?filter=issn:${q.slice(0, 4)}-${q.slice(-4).toUpperCase()}&per-page=5`
    : `https://api.openalex.org/sources?search=${encodeURIComponent(q)}&filter=type:journal&per-page=8`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OpenAlex answered ${res.status}`);
  return ((await res.json()).results || []).map((s) => ({
    id: (s.id || "").split("/").pop(), name: s.display_name, issns: s.issn || [],
    publisher: s.host_organization_name || "", works: s.works_count || 0,
  }));
}

// ---------- This user's preferences: journals, favourite fields, translation language ----------

export async function getPrefs() {
  const snap = await getDoc(mine("settings", "prefs"));
  return snap.exists() ? snap.data() : null;
}

export function savePrefs({ journals, fields, language, onboarded }) {
  return setDoc(mine("settings", "prefs"), { journals, fields, language, onboarded, updated_at: isoNow() });
}

// ---------- Shared settings (settings/app; admins write) ----------

export async function getAppSettings() {
  const snap = await getDoc(doc(db, "settings", "app"));
  return snap.exists() ? snap.data() : null;
}

export function saveAppSettings(digestTime, timezone) {
  return setDoc(doc(db, "settings", "app"), { digest_time: digestTime, timezone, updated_at: isoNow() }, { merge: true });
}

// ---------- Estimated API costs (admins only) ----------

// costs/{YYYY-MM-DD} from `from` on: Map date → document (costs/alerts has no date and is left out)
export async function listCosts(from) {
  const snap = await getDocs(query(collection(db, "costs"), where("date", ">=", from)));
  return new Map(snap.docs.map((d) => [d.id, d.data()]));
}

// settings/costs: {monthly_budget_usd} (null if never set)
export async function getCostSettings() {
  const snap = await getDoc(doc(db, "settings", "costs"));
  return snap.exists() ? snap.data() : null;
}

export const saveBudget = (usd) => setDoc(doc(db, "settings", "costs"), { monthly_budget_usd: usd, updated_at: isoNow() });

// ---------- This user's settings: notifications and what has been seen ----------

export async function getNotifyChoices() {
  const snap = await getDoc(mine("settings", "notify"));
  return snap.exists() ? snap.data() : {};
}

export function saveNotifyChoice(kind, on) {
  return setDoc(mine("settings", "notify"), { [`notify_${kind}`]: on, updated_at: isoNow() }, { merge: true });
}

// {digest_date, fulltext_at}; live, for the badge and tab dots
export const watchSeen = (callback, onError) => onSnapshot(mine("settings", "seen"),
  (snap) => callback(snap.exists() ? snap.data() : null), onError);

export function markSeen(fields) {
  return setDoc(mine("settings", "seen"), { ...fields, updated_at: isoNow() }, { merge: true });
}

// ---------- This user's devices: users/{uid}/push_tokens/{SHA-256 of the token} ----------

export async function getPushToken(id) {
  const snap = await getDoc(mine("push_tokens", id));
  return snap.exists() ? snap.data() : null;
}

export const savePushToken = (id, data) => setDoc(mine("push_tokens", id), data);
export const deletePushToken = (id) => deleteDoc(mine("push_tokens", id));

// ---------- This user's full-text summaries (live): users/{uid}/summaries/{doi_key} ----------

export const watchMySummaries = (callback, onError) => onSnapshot(collection(db, "users", uid, "summaries"),
  (snap) => callback(new Map(snap.docs.map((d) => [d.id, d.data()]))), onError);

// ---------- This user's library (live) ----------

export const watchLibrary = (callback, onError) => onSnapshot(collection(db, "users", uid, "library"),
  (snap) => callback(new Map(snap.docs.map((d) => [d.id, d.data()]))), onError);

// The scripts write the same documents, so a document is never rewritten whole: in a
// transaction, a missing document is created in the schema's shape, and an existing one
// gets only the changed fields; notes are added with arrayUnion.
function newEntry(paper, now) {
  return {
    schema_version: SCHEMA_VERSION,
    doi: paper.doi ?? null,
    doi_key: paper.doi_key,
    saved: false,
    saved_at: null,
    status: null,
    notes: [],
    summary: null,
    fulltext: null,
    fulltext_history: [],
    created_at: now,
    updated_at: now,
  };
}

// edit(current entry) → { fields: {...}, notes: [...] } (what to change)
async function changeEntry(paper, edit) {
  const ref = mine("library", paper.doi_key);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const now = isoNow();
    const current = snap.exists() ? snap.data() : newEntry(paper, now);
    const { fields = {}, notes = [] } = edit(current);
    if (!snap.exists()) {
      tx.set(ref, { ...current, ...fields, notes: [...current.notes, ...notes], updated_at: now });
      return;
    }
    const update = { ...fields, updated_at: now };
    if (notes.length) update.notes = arrayUnion(...notes);
    tx.update(ref, update);
  });
}

// Saving records the date and sets the status to "to read" if it has none (as the scripts do)
function saveFields(entry) {
  if (entry.saved) return {};
  return { saved: true, saved_at: localDate(), status: entry.status || "to_read" };
}

export const setSaved = (paper, saved) => changeEntry(paper, (entry) => (
  saved ? { fields: saveFields(entry) } : { fields: { saved: false, saved_at: null } }));

export const setStatus = (paper, status) => changeEntry(paper, (entry) => (
  { fields: { ...saveFields(entry), status } }));

export const addNote = (paper, text) => changeEntry(paper, () => (
  { notes: [{ at: isoNow(), text }] }));

// ---------- Requests ----------

// This user's requests (live), each with its document ID as `id`
export const watchMyRequests = (callback, onError) => onSnapshot(
  query(collection(db, "requests"), where("uid", "==", uid)),
  (snap) => callback(new Map(snap.docs.map((d) => [d.id, { ...d.data(), id: d.id }]))), onError);

// Cancel one of this user's pending requests (the rules allow only this change); the paper
// stays saved
export const cancelRequest = (id) => updateDoc(doc(db, "requests", id), { status: "cancelled", cancelled_at: isoNow() });

// Admins only: every request (to count each user's summaries this month)
export async function allRequests() {
  const snap = await getDocs(collection(db, "requests"));
  return snap.docs.map((d) => d.data());
}

// A full-text request in the schema's shape; the paper is saved as well (and stays saved if
// the request is cancelled).
export async function requestFulltext(paper) {
  await addDoc(collection(db, "requests"), {
    schema_version: SCHEMA_VERSION,
    uid,
    doi: paper.doi,
    doi_key: paper.doi_key,
    requested_at: isoNow(),
    requested_by: "app",
    status: "pending",
    error: null,
    processed_at: null,
  });
  await setSaved(paper, true);
}
