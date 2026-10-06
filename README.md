# paper-digest-app

A small web app for reading the paper-digest data on a phone: each morning's new papers,
grouped by field, a calendar of past digests, a searchable list of all past papers (Browse),
and a personal library of saved papers with full-text summaries.

Live at <https://yasukikudo.com/paper-digest-app/> (GitHub Pages). Only accounts in the user
list (kept by an admin in the app) can use it; this repository holds no data, only the page
code.

## How it works

- **Static files only.** HTML, CSS and JavaScript modules, no build step. The Firebase
  JavaScript SDK (v12.19.0) is loaded as ES modules from `www.gstatic.com`.
- **Data** lives in Cloud Firestore in the Firebase project `paper-digest-a68d0`. A scheduled
  job in a separate private repository writes the papers every morning and processes full-text
  requests a few times a day. The data formats are described in that repository's `schema.md`.
- **Users.** After sign-in the app reads the account's entry in the user list, `users/{uid}`.
  Accounts that are not listed, or not active, see "This account is not registered as a user
  yet." and nothing else. Admins (role `admin`) also see relevance, highlights and relevance
  reasons, set the morning digest time, and manage members (Settings → Members: add by UID,
  display name, active, full-text permission, monthly limit, this month's count). Other users see each
  field's papers newest first. Accounts themselves are created in the Firebase console.
- **Shared and personal data.** Everyone reads the shared `days`, `papers`, `authors`,
  `summaries` (full-text summaries; an existing one is shown to everyone), `meta/*`, `index/*`
  and `settings/app`. Each user's own data is under `users/{uid}/` and only they can read it.
- **The app reads** the shared data, the user's own data and requests, and three kinds of light
  documents written by the scripts, so it never reads every day or paper:
  - `meta/calendar` (one read per session): papers and highlights per day, for the calendar and
    for previous / next day
  - `meta/index` and the `index/{shard}` documents it lists (read when Browse is first opened):
    a short entry per paper (title, authors, journal, dates, field, relevance, one-liner, tags,
    full-text access). Browse lists and searches these in the browser; a paper's full document
    is read from `papers` only when it is opened
  - `meta/summaries` (live): which papers have a shared summary
  The calendar and index are re-read after 10 minutes. **It writes** only:
  - `users/{uid}/library/{doi_key}`: save / unsave, status (to read, read), notes. A missing document is
    created in the full schema shape; existing documents get only changed fields, and notes are
    added with `arrayUnion`, inside a transaction (the scripts write the same documents).
  - `users/{uid}/settings/seen` (what has been viewed), `settings/notify` (which notifications)
    and `push_tokens` (this device's notification token)
  - `requests`: a new request with the user's `uid`, `status: "pending"` and
    `requested_by: "app"`, for papers with no shared summary whose open-access PDF can be
    downloaded automatically (`fulltext_access: "auto"`), only by users allowed full-text
    summaries; the button shows how many are left this month if there is a limit. Requesting
    also saves the paper. A paper with a waiting or running request cannot be requested again.
  - Admins only: `users/{uid}` (members) and `settings/app` (digest time and time zone)
- Papers are always addressed by the stored `doi_key`; keys are never computed from DOIs.
- The user's library, their requests and `meta/summaries` are watched live (`onSnapshot`), so
  saving, notes and finished full-text summaries appear without reloading. Only the affected parts of a card are redrawn.
  Because library writes are transactions (confirmed only after a round trip), the app shows a
  change at once and replaces it with the stored document when the write finishes, or undoes it
  if the write fails.
- **Layout:** a fixed top bar (date with previous / next, or the page title), one scrolling
  content area and a fixed tab bar (Today, Browse, Library, Settings), with safe-area padding for
  iPhone notches. Tapping the date opens a month calendar (dots on days with papers, a
  different color for days with highlights): a bottom sheet on phones, a small window from
  700 px, and always shown on the left of a day page from 1100 px.
- **Browse:** with nothing entered, the journals and their paper counts; a journal, a field
  and/or search words (case-insensitive, all words must match, filtered as you type) list
  papers newest first, 150 at a time. Notes are added in a bottom sheet; short messages appear as a toast.
  Animations stop when the device asks for reduced motion. Icons are inline SVG.
- Field names come from each day document (`days.fields`); days written before that field
  existed use `DEFAULT_FIELDS` in `js/labels.js`.
- **Sign-in** uses Firebase Authentication (email and password), with a 6-digit PIN as the
  password. There is no sign-up screen; the account is created in the Firebase console. The
  email is remembered in this browser's `localStorage` only, so later sign-ins need just the PIN.
  The session lasts until you sign out. Settings (⚙) has *Change PIN* and *Sign out*.
- **Security** is enforced by the Firestore security rules (kept in the private repository),
  which allow only the owner's UID and only the writes listed above. The web configuration in
  `js/firebase-config.js` is public by design.
- **Notifications** (Settings → Notifications): Firebase Cloud Messaging web push, on an iPhone
  home-screen app (iOS 16.4 or later) and in Chrome on the Mac. Enabling asks for permission
  only when the button is pressed, then stores the device's token as `push_tokens/{SHA-256}`.
  *Enabled* is shown only when this device's `push_tokens` document exists; if it has gone
  missing, the app registers the device again (also on every start). The scripts send
  data-only messages after each morning run ("Today's digest: 8 new papers · 1 highlight", or
  "no new papers", which can be turned off and leaves the badge alone) and
  when a full-text summary is ready; `sw.js` shows them, opens the page when one is tapped, and sets
  the icon badge. Each kind can be turned off (`settings/app`). *Show a test notification*
  shows one on this device only; `python digest.py --test-push` in the private repository sends
  one through FCM.
- **Badge and dots:** `settings/seen` (shared by all devices, watched live) records the latest
  day viewed and when the Library was last viewed. Days after it put a dot on the Today tab and
  their number of papers on the icon badge (Badging API, where supported); a newer full-text
  summary puts a dot on the Library tab. Viewing the day / the Library clears them.
- **Service worker:** `sw.js` handles notifications and the badge only. It has no fetch handler
  and caches nothing, so a reload always gets the current code.
- Light and dark mode follow the device; the manifest and icons allow adding the app to the
  home screen.

## Files

```
index.html               page shell; loads js/app.js
sw.js                    service worker: notifications and badge only (no caching)
manifest.webmanifest     home-screen app settings
icons/                   app icons (192, 512, maskable 512, apple-touch-icon 180)
css/style.css            styles (based on the paper-digest HTML pages)
js/firebase-config.js    Firebase web configuration and the Web Push public key
js/push.js               notifications on this device: permission, token, test, badge
js/schedule.js           digest time and time zone helpers for Settings
js/labels.js             labels not stored in Firestore (default field names, summary sections, ...)
js/data.js               sign-in, Firestore reads, live updates and writes
js/render.js             HTML for pages and paper cards
js/app.js                routing (#/day/YYYY-MM-DD, #/browse, #/paper/{doi_key}, #/library, #/settings),
                         calendar, Browse and actions
.nojekyll                serve files as they are on GitHub Pages
```

## Updating

1. Edit the files and test locally:
   ```bash
   cd ~/projects/paper-digest-app
   python3 -m http.server 8000      # then open http://localhost:8000/
   ```
   `localhost` is an authorized domain in Firebase Authentication, so sign-in works locally
   against the real data.
2. Commit and push to `main`; GitHub Pages republishes within a minute or two.
3. To update the Firebase SDK, change the version in the three import URLs in `js/data.js`.

If the data format changes (`schema.md` in the private repository), update `js/data.js`
(`SCHEMA_VERSION`, `newEntry`, the request shape), `js/render.js` and, for the index entries,
`ensureIndex` in `js/app.js`.

## Firebase settings

All in the [Firebase console](https://console.firebase.google.com/), project `paper-digest-a68d0`:

| What | Where |
|---|---|
| Web configuration (`js/firebase-config.js`) | Project settings → General → Your apps → paper-digest-app → Config |
| Sign-in method (Email/Password) | Authentication → Sign-in method |
| The account, its UID, resetting the PIN | Authentication → Users |
| Authorized domains (`localhost`, `yasukikudo.com`) | Authentication → Settings → Authorized domains |
| Sign-up disabled | Authentication → Settings → User actions |
| Security rules | Firestore Database → Rules (source: `firestore.rules` in the private repository) |
| Web Push certificate (`vapidKey` in `js/firebase-config.js`) | Project settings → Cloud Messaging → Web configuration |

Firebase Hosting is not used.
