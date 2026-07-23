# QC Time Tracker & Retail AdCopy

Two Chromium browser extensions for team time tracking that sync through a **shared OneDrive folder** — no server, no database, no API keys, no Power Automate.

Each person's extension writes their own JSON file into one shared folder. Because nobody writes to the same file, there are no locks, no merge conflicts, and no backend to maintain. A dashboard reads every file in the folder and merges them into one team view.

---

## Why this exists

Most team time trackers need a server, a subscription, or IT approval for an API. This needs none of those — just a browser and a OneDrive folder the team already has.

| | |
|---|---|
| **Backend** | None — a shared OneDrive folder |
| **Cost** | None |
| **Accounts** | Name + email, stored locally |
| **Browsers** | Chrome / Edge (desktop) |

---

## The two extensions

### QC Time Tracker
Ticket, client, ticket type, order counts and order numbers, multi-session tabs, pause/resume, and a **4-minute** long-running-timer reminder.

### Retail AdCopy
Same engine, plus a **Process** selector (SMB / Retail CSM), a **Lines / units / VT / PX / QT** Yes/No field, and a **5-minute** reminder cycle.

---

## Features

- **Auto-start timer** — starts the moment you type a ticket number
- **Unlimited pause / resume** — every pause and resume is timestamped, so duration reflects real hands-on time
- **Order number paste** — paste any format (commas, spaces, newlines); saved comma-separated into a single spreadsheet cell
- **Background reminders** — a desktop notification checks in on long-running timers, without ever pausing them
- **Team dashboard** — full-tab view merging every member's data, with search, user filter, and a date range
- **Edit / delete** — edit any entry; delete is restricted to the entry's owner
- **CSV export** — one row per entry, Excel-ready
- **Dark & light themes**

---

## Install

Neither extension is on the Web Store; both load unpacked.

1. Download or clone this repo
2. Open `chrome://extensions` (or `edge://extensions`)
3. Turn on **Developer mode**
4. Click **Load unpacked** and select the `Qc-Time-Tracker` or `Retail-AdCopy` folder
5. Pin the extension and click **Allow** if the browser asks about notifications

> Keep the folder somewhere permanent — the browser loads the extension from that path on every launch.

---

## Team sync setup

One person (the **File Creator**) sets up the folder once:

1. Create a folder in OneDrive, e.g. `Team-Tracker`
2. Right-click it → **Always keep on this device**
3. Share it with the team using **Can edit** — *not* "Can view"

Each member, once per PC:

1. Open the share link → **Add shortcut to My files**
2. In File Explorer → OneDrive, right-click the folder → **Always keep on this device** (wait for the green check)
3. In the extension: **⚙️ Settings → 📁 Choose Shared Folder** → select that folder
4. Click **🧪 Test Folder Access** to confirm

After a full browser restart, click **🔑 Re-grant Folder Access** once — a File System Access API security requirement, not a bug.

`Extension_Setup_Guide.html` in this repo is a formatted, step-by-step version of the above.

---

## Troubleshooting

| Symptom | Cause & fix |
|---|---|
| "Connected but can't write into it" | Folder shared as **Can view**, or still online-only. Re-share as **Can edit**, then pin with **Always keep on this device** |
| "Permission was not granted" on repeat | The prompt closes the small popup. Use **Re-grant Folder Access** — it opens a full tab automatically |
| Folder not in the picker | The shortcut never synced. Re-do **Add shortcut to My files**, wait 1–2 min |
| No reminder notifications | Use **🔔 Send Test Notification** in Settings; if nothing appears, check Windows notification settings and Focus Assist |
| "File editing" setting greyed out | Group policy is blocking the File System Access API. Requires IT to enable `DefaultFileSystemWriteGuardSetting` |
| Two people overwrite each other | They signed in with the same email — each person needs their own |

---

## How the data works

Each member's file is named from their email:

```
<prefix>-team-<sanitized-email>.json
```

Plain readable JSON — auditable in a text editor, and removing a person is deleting one file.

Data is written locally first, then copied to the shared folder, so nothing is lost if the folder is temporarily unavailable.

---

## Configuration

Ticket types are a plain array at the top of each `popup.js`:

```js
const TICKET_TYPES = ["Ad Copy", "Ad Copy VIP", /* ... */];
```

Reminder interval is at the top of each `background.js`:

```js
const REMINDER_MINUTES = 4;   // QC
const REMINDER_MINUTES = 5;   // Retail AdCopy
```

Edit, then reload the extension.

---

## Limitations

- Chrome/Edge **desktop only** — the folder picker doesn't exist elsewhere
- Folder access must be re-granted once per browser session
- Everyone needs the shared folder synced locally; OneDrive-web alone won't work
- Not a real-time system — the dashboard reflects the last **Refresh Team Data**

---

## License

MIT — see [LICENSE](LICENSE).
