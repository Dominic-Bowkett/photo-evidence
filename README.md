# Photo Evidence

A single-page web app for domestic energy assessors (DEAs) to collect photo
evidence on site. Every photo is taken with an in-app camera and re-rendered
with a **date/time and GPS stamp in the bottom-right corner**, grouped under
labelled sections, and exported as a PDF report and/or a ZIP bundle
containing the PDF plus every stamped JPEG with EXIF metadata.

No server, no build step — it's three static files (`index.html`, `style.css`,
`app.js`) plus three CDN libraries (jsPDF, JSZip, piexifjs).

Live demo via GitHub Pages: <https://dominic-bowkett.github.io/photo-evidence/>

## What it does

### Capture
- **In-app camera** using `getUserMedia`. Tap *Take photo* on any group and a
  full-screen camera overlay opens with a live video preview.
- **Burst capture** — snap as many shots in a row as you like; each one gets
  the date + GPS overlay burned in on the canvas and appears as a thumbnail in
  the bottom strip. Tap × on a thumb to discard it before committing.
- **Done (N)** commits the batch to the group; **Cancel** discards it (with
  a confirm if there are captures).
- Camera switcher (back/front). On desktop, **Space / Enter** capture and
  **Esc** cancels.
- Camera-only by design — there is no gallery picker, so every photo in the
  report was taken at the moment of capture, not uploaded after the fact.

### Geolocation
- On page load the browser's native location permission prompt is triggered
  (with a short alert explaining why).
- Accuracy is shown in metres next to the *Enable GPS* button. If the user
  had previously blocked location, the alert tells them how to unblock it.
- The GPS coordinates and accuracy are stamped onto each photo and also
  written into the EXIF metadata when exporting the ZIP.

### Groups and sections
Every new property is seeded with this fixed structure:

**Top-level protected groups** (locked name, no delete):
External Elevations, Meters, Windows, Doors, Conservatory, Renewables,
Mains Heating, Secondary Heating, Water Heating, Ventilation, Lighting.

**Main Property section** (also protected), containing three sub-groups:
Walls, Roof, Floor.

**Extensions (clone of Main Property)**: a `+ Add extension` button beneath
the Main Property section clones the three sub-groups into `Extension 1`,
`Extension 2`, `Extension 3`, `Extension 4` — capped at four. Cloning only
copies the sub-group structure; no photos carry over. Each extension has a
`Remove Extension N` button that deletes the section and its photos (after
a confirm).

**User-added groups**: the *Add group* row at the bottom creates an
unprotected group that can be renamed inline and deleted. The rest of the
workflow (camera capture, labels, reorder, export) is identical.

### Persistence
- Everything is **autosaved to the browser** via IndexedDB — property
  metadata, groups, photo records, the lot. Refresh, close the tab, or come
  back tomorrow and your work is still there.
- Photos are stored as JPEG data URLs locally; nothing leaves the device
  until you export a PDF or ZIP.
- A *Saving… / Saved* indicator in the Job details card reports autosave
  status. Debounced ~400 ms.

### Multi-property support
- Create a new property with `+ New` in the header. Each property has its
  own metadata block, group set (same defaults), and photos.
- The header dropdown switches between properties; the active one is
  remembered in `localStorage`.
- `Delete property` removes the current property and all its photos after
  a confirm.

### Per-photo controls
- Default label `"{Group} — {n}"`, editable inline.
- Drag thumbnails to reorder them within a group.
- × button deletes a photo after a confirm naming the photo and its group.

### Exports
- **Download PDF** — cover page with the job metadata, a **clickable
  contents page** (each row is a link to that section, page numbers shown
  as `p. N`, with PDF bookmarks as a guaranteed-clickable fallback in any
  PDF viewer), one section per group, and page numbers. Section sub-groups
  are indented under a section heading in the contents. Every group page
  shows the section-qualified name (`Main Property — Wall Thickness`,
  `Extension 1 — Roof`, …).
- **Download ZIP** — a single archive containing:
  - The full PDF report at the root.
  - Every stamped JPEG under a folder structure that mirrors the groups:
    `main-property/walls/01_front-wall-north.jpg`, etc.
  - **EXIF `DateTimeOriginal`, `DateTimeDigitized`, `DateTime`, GPS
    lat/lon, `GPSDateStamp`, `GPSTimeStamp`** written into each JPEG
    via piexifjs, so when the files are extracted and opened in Photos,
    Finder, Explorer, Google Photos, etc. the capture date and location
    are recognised automatically.
  - Zip entry modification times are also set to each photo's capture
    timestamp as a secondary hint.

## Run locally

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

The in-app camera, GPS, and saving all work over `http://localhost` or any
`https://` origin. They **do not** work over `file://`.

For on-device testing, either hit the localhost server over your LAN (after
setting up a local HTTPS tunnel like Cloudflare Tunnel or ngrok) or use the
GitHub Pages deployment — both are HTTPS so iOS/Android browsers will allow
camera and location access.

## Deploying

The repo ships with `.github/workflows/pages.yml`, which deploys to GitHub
Pages on every push to `main` or the demo branch.

One-time setup in the repo settings:
- *Settings → Pages → Source* = **GitHub Actions**.

Then push; the workflow publishes to
`https://<user>.github.io/<repo>/`. Re-runs on each push. A manual
*Run workflow* trigger is also wired up.

## Architecture

| File | Responsibility |
| --- | --- |
| `index.html` | Layout, templates for groups/thumbs, camera overlay, CDN libraries |
| `style.css` | Mobile-first styling, sticky header, sections, camera HUD |
| `app.js`    | IndexedDB storage, property switching, geolocation, in-app camera, canvas overlay, PDF and ZIP export |

### Storage

IndexedDB database `photo-evidence` with two stores:

- **`properties`** — one record per job/property with metadata
  (`assessor`, `address`, `ref`, `date`) and a `groups[]` list. Each group
  has `{ id, name, photoIds[], protected, section? }`. `protected` means
  the name is locked and the Remove button is hidden. `section` puts the
  group under a shared heading (`Main Property`, `Extension N`).
- **`photos`** — one record per image: `{ id, propertyId, dataUrl, width,
  height, takenAt (ISO), gps { latitude, longitude, accuracy }, label }`.
  Indexed by `propertyId` for fast lookup when switching properties.

Active property id is persisted in `localStorage` so the app reopens where
it was left.

### Migration
On load, each property is passed through `migrateDefaults()` which:
- Adds any missing top-level default groups to the end of the list.
- Seeds the Main Property sub-groups if they're absent.
- Sets `protected: true` on any group whose name matches a default (so
  properties saved before the protected-groups feature get locked down
  retroactively).
- Persists the changes.

### Libraries
Loaded from jsDelivr in `index.html`:

- [jsPDF 2.5.1](https://github.com/parallax/jsPDF) — PDF generation.
- [JSZip 3.10.1](https://stuk.github.io/jszip/) — ZIP creation.
- [piexifjs 1.0.6](https://github.com/hMatoba/piexifjs) — EXIF read/write on
  data URLs.

## Browser support

Requires a modern mobile browser with support for:

- `navigator.mediaDevices.getUserMedia` (for the in-app camera).
- `navigator.geolocation` (for GPS).
- `IndexedDB` (for autosave).
- `canvas.toDataURL("image/jpeg")`.

All current iOS Safari and Android Chrome versions qualify. Desktop
Chrome/Firefox/Edge work for demo purposes (the camera falls back to the
machine's webcam).

## Next steps (if you want to productionise)

- Install as a **PWA** (manifest + service worker) so it works fully offline
  on site with no tunnel or LAN server.
- **Export / import** of the IndexedDB dataset so a property can be moved
  between devices.
- **Backend upload**: push the ZIP to S3 (signed URL) or a job-management
  system instead of / alongside local download.
- **Assessment presets**: per-scheme group templates (RdSAP, SAP, retrofit)
  with checklists of required shots.
- **Original-EXIF preservation** option if/when a gallery picker is added
  back (so historical shots keep their original `DateTimeOriginal`).
