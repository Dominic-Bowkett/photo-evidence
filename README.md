# Photo Evidence — demo

A single-page web app for domestic energy assessors (DEAs) to collect photo
evidence on site. Every photo is re-rendered with a **date/time and GPS stamp
in the bottom-right corner**, grouped under labelled sections (starting with
*External Elevations*), and exported as a single PDF report.

No server, no build step — open `index.html` in a modern browser.

## Features

- **Date + GPS overlay** burned into each image (canvas compositing, so it
  survives in the exported PDF).
- **Geolocation** via the browser's Geolocation API (tap *Enable GPS* once;
  accuracy is shown in metres).
- **Multiple properties** — create one per job via the picker in the header;
  each has its own metadata, groups, and photo set.
- **Autosave to the browser (IndexedDB)** — refresh, close the tab, or come
  back tomorrow and the work is still there. Photos are stored locally too.
- **Groups / categories**: seeded with *External Elevations*; add more on the
  fly (e.g. Loft insulation, Boiler, Meters, Windows).
- **Take photo** (camera directly, uses `capture="environment"`) or
  **Add photos** (multi-select from gallery).
- **Per-photo labels** (default `"{Group} — {n}"`, editable).
- **Drag to reorder** photos within a group.
- **PDF export** with a cover page, a **clickable contents page** (each
  group title links to its section), one group per section, and page numbers.
- **ZIP export** — one archive containing the PDF plus every photo as a
  separate JPEG, grouped into folders by section. **EXIF `DateTimeOriginal`
  and GPS are written into each JPEG** (via piexifjs) so the capture date
  survives when files are extracted and opened in Photos/Explorer/Finder.

## Run locally

Because the file input and Geolocation API work from a file:// URL in most
browsers, you can just open it:

```bash
open index.html   # macOS
xdg-open index.html   # Linux
```

If you want to test it from a phone on your LAN (recommended, so the camera
and GPS both work over HTTPS/localhost), serve it with any static server, e.g.:

```bash
python3 -m http.server 8000
```

Then browse to `http://<your-ip>:8000/`.

> **Note:** iOS Safari only grants `getCurrentPosition` / camera access on
> `https://` origins or `http://localhost`. For on-device testing, either use
> localhost or put the files behind a TLS tunnel (Cloudflare Tunnel, ngrok, etc.).

## Architecture

| File | Responsibility |
| --- | --- |
| `index.html` | Layout, templates for groups/thumbs, loads jsPDF from CDN |
| `style.css` | Mobile-first styling, sticky header, thumbnail grid |
| `app.js` | IndexedDB storage, property switching, geolocation, canvas overlay, PDF generation |

Storage uses the browser's **IndexedDB** (`photo-evidence` database):

- `properties` store — one record per job/property with metadata + group list
  (each group holds an ordered `photoIds[]`).
- `photos` store — one record per image (JPEG data URL + width/height + time +
  GPS + label), indexed by `propertyId`.

The active property id is remembered in `localStorage`. Autosave is debounced
(~400 ms) and a "Saving…" / "Saved" indicator in the Job details card shows
status. There is no server; everything stays on the device until you generate
a PDF.

## Next steps (if you want to productionise)

- Read EXIF `DateTimeOriginal` / GPS tags when photos are picked from gallery,
  so historical shots keep their original metadata instead of "now".
- Install as a PWA (manifest + service worker) for full offline use on site.
- Export/import the IndexedDB dataset so a property can be moved between
  devices.
- Upload to a backend (S3 + signed URLs, or a job-management system) in
  addition to PDF export.
- Add preset groups per assessment type (RdSAP, SAP, retrofit) with required
  shot checklists.
