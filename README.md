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
- **Groups / categories**: seeded with *External Elevations*; add more on the
  fly (e.g. Loft insulation, Boiler, Meters, Windows).
- **Multi-upload** per group — pick several from the gallery or take new ones
  with the camera (`<input type="file" accept="image/*" multiple>`).
- **Per-photo labels** (default `"{Group} — {n}"`, editable).
- **Drag to reorder** photos within a group.
- **Job metadata** (assessor, property, reference, date) prints on the cover
  and in the footer of the PDF.
- **PDF export** via jsPDF, with a cover page, contents list, one group per
  section, and page numbers.

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
| `app.js` | State, geolocation, canvas overlay, PDF generation |

State lives entirely in memory (`state.groups`) — refreshing the page clears
it. Persisting to `localStorage`/IndexedDB would be a straightforward next
step if offline drafts are needed.

## Next steps (if you want to productionise)

- Persist drafts to IndexedDB so closing the tab doesn't lose work.
- Read EXIF `DateTimeOriginal` / GPS tags when photos are picked from gallery,
  so historical shots keep their original metadata instead of "now".
- Install as a PWA (manifest + service worker) for offline use on site.
- Upload to a backend (S3 + signed URLs, or a job-management system) instead of
  / in addition to PDF export.
- Add preset groups per assessment type (RdSAP, SAP, retrofit) with required
  shot checklists.
