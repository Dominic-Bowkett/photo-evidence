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

### Groups and building tags
Every new property is seeded with this fixed set of **protected top-level
groups** (locked name, no delete):

External Elevations, Meters, Windows, Doors, Conservatory, Renewables,
Mains Heating, Secondary Heating, Water Heating, Ventilation, Lighting,
Walls, Loft, Floor.

**Building tag on every photo.** Rather than duplicating the building-fabric
groups per extension, each photo carries a small tag — `Main`, `Ext1`,
`Ext2`, `Ext3`, or `Ext4` — selected via a dropdown on the thumb (default
`Main`). Use it in the Walls / Loft / Floor groups (or any other) to
indicate which building on site the shot belongs to. In the PDF / HTML
the tag is shown as a small badge or `[Ext1]` prefix next to non-Main
photos; in the ZIP it's part of the filename bundled alongside the photo
metadata.

**User-added groups**: the *Add group* row at the bottom creates an
unprotected group that can be renamed inline and deleted. Workflow (camera
capture, uploads, labels, reorder, exports, building tag) is identical.

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
- Drag thumbnails to reorder them within a group (disabled in *By tag* view).
- × button deletes a photo after a confirm naming the photo and its group.
- **Tap any photo** to open a full-screen lightbox. Prev / Next buttons and
  the ← / → keys step through the surrounding set; Esc or tap outside to
  close.
- **Building tag select** above each thumb (`Main / Ext1 / Ext2 / Ext3 /
  Ext4`) decides which building the photo belongs to.

### View toggle
Above the groups list, a two-button toggle switches between:
- **By group** — the default app layout: one accordion per group
  (External Elevations, Meters, …, Walls, Loft, Floor). *Take photo /
  Upload / Remove / drag-reorder* all live here.
- **By tag** — photos re-bucketed under accordions for each building tag
  that actually has photos (`Main`, `Ext1`, …). Each thumb shows its
  source group as a small hint. Changing a photo's tag from this view
  re-categorises the thumb instantly.

### Exports
- **Download PDF** — opens a small popup to pick the layout:
  - *By group* (matches the app's default view)
  - *By tag* — one PDF section per building (Main / Ext1–4), each
    photo's label prefixed with its source group (`Walls — Front wall`).

  Both layouts include a cover page, a **clickable contents page**
  (blue-underlined entries linking to each section, with PDF bookmarks as a
  universally-clickable fallback) and page numbers.
- **Export photos** — opens a popup with two options:
  - *Save to Photos* — share sheet for copying the whole batch to the
    device camera roll (iOS / Android with Web Share).
  - *Download ZIP* — a single archive containing:
    - Photo folders (one per group): `walls/01_front-wall-north.jpg`, etc.
    - **Two PDF reports** — `..._by-group.pdf` and `..._by-tag.pdf` — both
      with their embedded photos hyperlinked to the corresponding
      full-resolution JPEGs in the archive.
    - **Two HTML indices** — `index.html` (by group) and `index-by-tag.html`
      (by tag). Each has a small banner at the top linking to the other
      layout, references the photo files via `<img src="…">` so the
      HTML file itself stays small, and works offline in any browser.
    - **EXIF `DateTimeOriginal`, `DateTimeDigitized`, `DateTime`, GPS
      lat/lon, `GPSDateStamp`, `GPSTimeStamp`** written into each
      camera-captured JPEG via piexifjs; uploaded JPEGs ship with their
      original EXIF intact. Zip entry modification times also reflect
      each photo's capture / upload time.

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
