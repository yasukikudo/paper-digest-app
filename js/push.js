// Notifications on this device: the service worker, permission, the FCM token
// (push_tokens/{sha256 of the token}), a local test notification and the icon badge.

import { getMessaging, getToken, deleteToken, isSupported } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-messaging.js";
import { app, isoNow, getPushToken, savePushToken, deletePushToken } from "./data.js";
import { vapidKey } from "./firebase-config.js";

const DEVICE_KEY = "paper-digest.push-token-id";   // this device's push_tokens document ID

const storage = {
  get() { try { return localStorage.getItem(DEVICE_KEY); } catch { return null; } },
  set(v) { try { localStorage.setItem(DEVICE_KEY, v); } catch { /* not available */ } },
  remove() { try { localStorage.removeItem(DEVICE_KEY); } catch { /* not available */ } },
};

const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent)
  || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

// A short name for the device, stored with its token
export function platformName() {
  const ua = navigator.userAgent;
  const where = isStandalone() ? " (home screen app)" : "";
  if (/iPhone/.test(ua)) return `iPhone${where}`;
  if (isIOS()) return `iPad${where}`;
  if (/Android/.test(ua)) return `Android${where}`;
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return `${os} ${browser}${isStandalone() ? " app" : ""}`.trim().slice(0, 40);
}

// The service worker (notifications and badge only; it caches nothing)
let registration = null;
export async function registerWorker() {
  if (!("serviceWorker" in navigator)) return null;
  try {
    registration = await navigator.serviceWorker.register("./sw.js", { scope: "./" });
  } catch {
    registration = null;
  }
  return registration;
}

// "enabled" | "off" | "blocked" | "ios-browser" | "unsupported".
// "enabled" only if this device's push_tokens document really exists; if it has gone missing,
// the device is registered again here (and reported "off" if that fails).
export async function status() {
  if (isIOS() && !isStandalone()) return "ios-browser";
  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window
    && await isSupported().catch(() => false);
  if (!supported) return "unsupported";
  if (Notification.permission === "denied") return "blocked";
  if (Notification.permission !== "granted" || !storage.get()) return "off";
  if (await getPushToken(storage.get()).catch(() => null)) return "enabled";
  try {
    await register();
    return "enabled";
  } catch {
    storage.remove();
    return "off";
  }
}

async function sha256(text) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Get this device's FCM token and store it (keeping created_at); replaces an old token
async function register() {
  const reg = registration || await registerWorker();
  if (!reg) throw new Error("The service worker could not be registered.");
  const token = await getToken(getMessaging(app), { vapidKey, serviceWorkerRegistration: reg });
  if (!token) throw new Error("No notification token was issued.");
  const id = await sha256(token);
  const previous = storage.get();
  if (previous && previous !== id) await deletePushToken(previous).catch(() => {});
  const existing = await getPushToken(id);
  const now = isoNow();
  await savePushToken(id, { token, platform: platformName(), created_at: existing?.created_at || now, last_used_at: now });
  storage.set(id);
}

// Ask for permission (only when the button is pressed) and register this device
export async function enable() {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "blocked" : "off";
  await register();
  return "enabled";
}

// Remove this device: its token in FCM and its push_tokens document
export async function disable() {
  const id = storage.get();
  try { await deleteToken(getMessaging(app)); } catch { /* already gone */ }
  if (id) await deletePushToken(id).catch(() => {});
  storage.remove();
}

// On app start: keep this device's token current (tokens can change) and its last_used_at
// (status() already registers again if the document has gone missing)
export async function refresh() {
  if (await status() === "enabled") await register().catch(() => {});
}

// A notification shown by this device only (no server involved)
export async function testNotification() {
  const reg = registration || await navigator.serviceWorker.ready;
  await reg.showNotification("Paper digest", {
    body: "Test notification on this device", icon: "icons/icon-192.png", tag: "test", data: { url: "./#/settings" },
  });
}

// The icon badge (Badging API); nothing where it is not supported
export function setBadge(count) {
  if (!("setAppBadge" in navigator)) return;
  (count > 0 ? navigator.setAppBadge(count) : navigator.clearAppBadge()).catch(() => {});
}
