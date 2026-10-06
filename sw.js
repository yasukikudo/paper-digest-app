// Service worker for notifications only: shows pushed notifications, opens the app when one
// is tapped, and sets the icon badge. It does not cache or serve any files (there is no
// fetch handler), so the app is always loaded fresh from the network.
//
// Messages come from Firebase Cloud Messaging as data-only web pushes sent by the
// paper-digest scripts: {title, body, url, badge, kind}. No Firebase code runs here.
// An empty badge (e.g. a morning run with no new papers) leaves the icon badge as it is.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

function setBadge(count) {
  if (!("setAppBadge" in self.navigator)) return Promise.resolve();
  return (count > 0 ? self.navigator.setAppBadge(count) : self.navigator.clearAppBadge()).catch(() => {});
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    const payload = event.data ? event.data.json() : {};
    data = payload.data || payload;
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const badge = data.badge === undefined || data.badge === "" ? NaN : Number(data.badge);
  event.waitUntil(Promise.all([
    self.registration.showNotification(data.title || "Paper Digest", {
      body: data.body || "",
      icon: "icons/icon-192.png",
      tag: data.kind || "paper-digest",
      data: { url: data.url || "./" },
    }),
    Number.isFinite(badge) ? setBadge(badge) : Promise.resolve(),
  ]));
});

// Tapping a notification opens its page in an open app window, or in a new one
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "./", self.registration.scope).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = windows.find((w) => w.url.startsWith(self.registration.scope));
    if (open) {
      try {
        await open.focus();
        if (open.url !== url && "navigate" in open) await open.navigate(url);
        return;
      } catch { /* fall back to a new window */ }
    }
    await self.clients.openWindow(url);
  })());
});
