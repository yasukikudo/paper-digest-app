// Firebase: sign-in and Firestore reads, writes and live updates.
// Data formats are described in schema.md in the (private) paper-digest repository.
// Papers are always addressed by the stored doi_key; keys are never computed from DOIs.

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
  EmailAuthProvider, reauthenticateWithCredential, updatePassword,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, addDoc, onSnapshot,
  runTransaction, arrayUnion,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const SCHEMA_VERSION = 6;

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);   // stays signed in on this device until sign-out
const db = getFirestore(app);

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

// ---------- Reads ----------

export async function dayIds() {
  const snap = await getDocs(collection(db, "days"));
  return snap.docs.map((d) => d.id).sort();
}

export async function getDay(date) {
  const snap = await getDoc(doc(db, "days", date));
  return snap.exists() ? snap.data() : null;
}

// Fetch documents by ID, using and filling `cache` (a Map). Missing documents map to null.
export async function getMany(name, ids, cache) {
  const wanted = [...new Set(ids)].filter((id) => id && !cache.has(id));
  const snaps = await Promise.all(wanted.map((id) => getDoc(doc(db, name, id))));
  snaps.forEach((s, i) => cache.set(wanted[i], s.exists() ? s.data() : null));
  return ids.map((id) => cache.get(id));
}

// Live updates of a whole collection (library, requests): callback(Map of id → document)
export function watchCollection(name, callback, onError) {
  return onSnapshot(collection(db, name), (snap) => {
    callback(new Map(snap.docs.map((d) => [d.id, d.data()])));
  }, onError);
}

// ---------- library writes ----------
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
    fulltext: null,
    fulltext_history: [],
    created_at: now,
    updated_at: now,
  };
}

// edit(current entry) → { fields: {...}, notes: [...] } (what to change)
async function changeEntry(paper, edit) {
  const ref = doc(db, "library", paper.doi_key);
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

// ---------- requests ----------

// A full-text request in the schema's shape; the paper is saved as well.
export async function requestFulltext(paper) {
  await addDoc(collection(db, "requests"), {
    schema_version: SCHEMA_VERSION,
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
