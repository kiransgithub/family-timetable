# Family Timetable

A small installable web app (PWA) for a family's weekly routine: school drop-offs and pickups,
lessons and classes, each school's calendar, and **"leave by" alerts that account for the
drive**. It runs on GitHub Pages and installs like an app on iPhone, iPad, Mac, Windows and
Linux.

- **Today:** a countdown to the next departure ("Leave in 12 min"), each run with its leave-by
  time and a Directions button (Apple Maps on Apple devices, Google Maps elsewhere).
- **Week / Month:** everything at a glance, with school days off, early releases, holidays and
  birthdays marked.
- **Kids:** ages, birthday countdowns, weekly routine and upcoming days off per child.
- **Rewards:** each child's balance (100 points = $1), what it was earned for, every deduction
  with its reason, when and by whom. Everyone can look; only the parents, with a password, can
  add, deduct or void.
- **Per-date changes:** mark a makeup class (longer session), cancel one date, move a time,
  confirm a class is on during a holiday, set an early-release pickup time.
- **Alerts:** popups, a chime and notifications while the app is open, plus a private
  **calendar feed** with alarms so iPhone/Mac Calendar alerts you even when the app is closed.

## How the data stays private

This repo (the app) is public and holds **no personal data**. Everything about the family lives
in `db.json` in a **separate private repo**, which the app reads and writes through the GitHub API
with a token saved only on each device. The calendar feed is a **secret gist**: anyone with its
link can read it, so keep the link private.

```
GitHub Pages (public)            Private repo                     Secret gist
kiransgithub.github.io/   ──►    family-timetable-data/db.json    family-timetable.ics
family-timetable/          ◄──   (every edit = a commit)    ──►   (Calendar subscribes)
```

## Setup (about 15 minutes)

1. **App repo:** push this folder to a public repo named `family-timetable`, then
   Settings → Pages → *Deploy from a branch* → `main` / `(root)`. The app appears at
   `https://<you>.github.io/family-timetable/`.
2. **Data repo:** create a **private** repo `family-timetable-data` and add `db.json` and
   `.github/workflows/calendar-feed.yml` (provided separately). Or leave it empty and use
   *Upload db.json* in the app.
3. **Tokens** (GitHub → Settings → Developer settings → Fine-grained tokens):
   | Token | Repository access | Permissions |
   |---|---|---|
   | Parents' devices | Only `family-timetable-data` | Contents: **Read and write**; Account → Gists: **Read and write** |
   | Kids' iPad (view only) | Only `family-timetable-data` | Contents: **Read-only** |
   | Feed Action (`GIST_TOKEN` secret in the data repo) | Public repositories | Account → Gists: **Read and write** |

   Set a long expiry and a reminder to renew. When a token expires the app says so.
4. **Connect:** open the app → enter owner, repo and token → *Connect*.
5. **Home address:** Manage → Places & drives → Home. The app finds every place on the map
   and works out drive times.
6. **Calendar feed:** Manage → Calendar feed → *Create my private calendar feed*, then
   *Subscribe on this device* on each iPhone/iPad/Mac. **Turn off "Remove Alarms"**
   (iPhone/iPad) or **uncheck "Remove: Alerts"** (Mac), or the alarms get stripped.
7. **Install:**
   - iPhone/iPad: open in Safari → Share → *Add to Home Screen*.
   - Mac: Safari → File → *Add to Dock* (or Chrome's install button).
   - Windows/Linux: Chrome or Edge → the install icon in the address bar.
8. **More devices:** Manage → Data & sync → *Copy setup code*, send it to yourself, and paste it
   into the installed app on the other device (home-screen apps on iOS have their own storage,
   so paste it inside the installed app, not in Safari).

## Rewards

The Rewards tab shows each child's balance, a breakdown by activity and by deduction reason,
month-by-month totals, who gave what, and the full history (date, time, category, note, given
by, balance after). *Export CSV* downloads the history for a spreadsheet.

- **Parents only:** adding a reward, deducting, voiding an entry, editing categories and
  changing passwords all ask for a parent password. Each parent has their own, so every entry
  records who gave it. An unlock lasts 5 minutes (restarted by each change) and ends as soon as
  the app goes to the background or reloads. After 5 wrong tries the app makes you wait.
- **First time:** the first parent to open Rewards on a device with write access sets their
  password, then sets the other parent's under *Passwords* (the other parent can change it after
  unlocking). A forgotten password is reset by the other parent. If both are forgotten, set both
  `password` values to `null` in `rewards.json` on GitHub and set them again in the app.
- **Deductions** need a reason and can't take a balance below $0. Nothing is ever deleted: a
  mistake is *voided* (with a reason), stays in the history crossed out and stops counting.
- **Where it lives:** `rewards.json` next to `db.json` in the private data repo, kept separate so
  timetable edits and imports can never touch balances. Only salted PBKDF2-SHA256 hashes of the
  passwords are stored. Every change is a commit naming the parent and the device.
- This is a family-level lock: it keeps the kids (and any view-only device) from changing
  balances in the app. Someone with a write token and developer tools could still edit the file
  directly, and the commit history would show it.

### `rewards.json` reference

| Field | What it is |
|---|---|
| `pointsPerDollar` | `100` |
| `unlockMinutes` | How long an unlock lasts (1–60, default 5) |
| `parents[]` | `id`, `name`, `password` (`null` or `{ alg, iterations, salt, hash, setAt, setBy }`) |
| `kids[]` | Member ids from `db.json` |
| `categories[]` | `id`, `label`, `emoji`, `group`, `type` (`earn` / `deduct` / `both`; `system` for the opening balance), `hidden`, `schedule` (the weekly activity it came from) |
| `entries[]` | `id`, `kid`, `points` (whole points; negative = deduction), `category`, `note` (required for deductions), `at` (ISO time), `by` (parent id), `void: { at, by, reason }` |
| `log[]` | Password changes: `at`, `by`, `action`, `target` |

## How leave-by times are worked out

```
leave by = arrive target − drive minutes × traffic padding − buffer at the place
```

- **Arrive target:** the item's `arrive` time (e.g. 7:15 for a 7:00–7:30 drop-off window), or
  start time minus `arriveEarlyMin`.
- **Drive minutes**, best first: your own override for that pair of places, then the
  OpenStreetMap road route (OSRM, cached in `db.json`), then a straight-line estimate, then
  `defaultDriveMin`. The card says when it is using an estimate.
- **Traffic padding:** ×1.10 normally, ×1.30 on weekday mornings 6:30–9:00 and ×1.35 on weekday
  afternoons 2:30–6:30 (all editable in Manage → Alerts).
- **Back-to-back runs chain:** if a run starts within 45 minutes of the previous one ending, the
  drive is planned from the previous stop (e.g. preschool pickup → school pickup), and the app
  warns if the connection is too tight.
- For live traffic on the day, tap **Directions**.

Each item's alerts: *Heads-up + leave now* (10 min before leaving, and at leave time),
*Leave now only*, or *None*. Items that need a decision (an activity on a holiday, an early
release with no pickup time yet, a TBD time) also get a reminder at 7 PM the evening before.

## `db.json` reference

Dates are `YYYY-MM-DD`, times are 24-hour `HH:MM` in `meta.timezone`, days are
`MO TU WE TH FR SA SU`. Unknown fields are kept, so you can add notes anywhere.

| Section | Fields |
|---|---|
| `meta` | `title`, `timezone` (IANA, e.g. `America/Phoenix`), `updatedAt`, `updatedBy` |
| `members[]` | `id`, `name`, `role` (`kid` / `parent` / `other`), `dob`, `color`, `school: { place, calendar, grade }`, `notes` |
| `places[]` | `id`, `name`, `short`, `address`, `lat`, `lng`, `bufferMin`, `phone`, `notes`. The place with id `home` is required. |
| `calendars[]` | `id`, `name`, `short`, `color`, `firstDay`, `lastDay`, `verify`, `source`, `notes`, `days[]: { type: no_school \| early_release \| event, label, start, end?, dismissal? }` |
| `schedules[]` (weekly) | `id`, `title`, `emoji`, `kind` (`school` / `activity` / `other`), `who[]`, `place`, `days[]`, `start`, `end` or `durationMin`, `arrive` or `arriveEarlyMin`, `calendar`, `calendarMode` (`school_days` = skip days off; `flag` = keep but mark), `earlyRelease: "pickup"` (move to the dismissal time), `from`, `until`, `tbd`, `alarms` (`both` / `leave` / `none`), `origin` (`auto` / `home` / a place id), `variants[]: { id, label, durationMin }`, `notes` |
| `events[]` (one-off) | `id`, `title`, `emoji`, `date`, `start`, `end`, `allDay`, `who[]`, `place`, `travel` (false = no drive), `alarms`, `cancelled`, `notes` |
| `exceptions[]` (one date of a weekly item) | `schedule`, `date`, `status` (`cancelled` / `confirmed` / `check`), `variant`, `start`, `end`, `durationMin`, `arrive`, `place`, `origin`, `note` |
| `holidays[]` | `date`, `name`. Activities on these dates ask "is it on?" |
| `settings` | `alerts { headsUpMin, eveningReminder }`, `commute { bufferMin, chainGapMin, defaultDriveMin, baseFactor, traffic[] }`, `feed { enabled, gistId, gistOwner, filename, calendarName, daysBack, daysAhead, appUrl }`, `display { weekStartsOn }` |
| `routes` | `cache` (road routes, filled by the app), `overrides` (`"home>gym": 18` = your own minutes) |

Example: one makeup class on a Saturday:

```json
{ "schedule": "swim", "date": "2026-12-05", "variant": "makeup" }
```

## Development

```bash
python3 -m http.server 8080   # then open http://localhost:8080
npm test                      # unit tests: scheduling, commute, calendar feed, rewards, passwords
node tools/validate-db.mjs ../family-timetable-data/db.json
node tools/validate-rewards.mjs ../family-timetable-data/rewards.json ../family-timetable-data/db.json
node tools/publish-feed.mjs ../family-timetable-data/db.json --out feed.ics
python3 tools/make-icons.py   # redraw the icons (needs Pillow)
```

- Preview the app at another moment with `?now=2026-11-23T14:20` (family time zone).
- After changing files, bump `VERSION` in `sw.js` so installed apps pick up the new version
  (they show "A new version is ready").
- No build step and no dependencies: plain ES modules. `js/core/` runs in both the browser and
  Node (the GitHub Action uses it to publish the feed).

## Limits worth knowing

- The free map services (Nominatim and the OSRM demo server) are used lightly: each address is
  looked up once and routes are cached. If one is down, drive times fall back to estimates.
- Calendar apps refresh subscribed calendars on their own schedule (often every 5–60 minutes),
  so a change made seconds before a departure may not reach the phone's alarms in time. The
  in-app popup is immediate.
- iPhone home-screen web apps can't fire alerts in the background on their own. That's what the
  calendar feed is for.
