(() => {
  "use strict";

  const DB_NAME = "photo-evidence";
  const DB_VERSION = 1;
  const STORE_PROPERTIES = "properties";
  const STORE_PHOTOS = "photos";
  const ACTIVE_KEY = "photo-evidence:active-property";

  const DEFAULT_GROUPS = [
    { name: "External Elevations" },
    { name: "Meters" },
    { name: "Windows" },
    { name: "Doors" },
    { name: "Conservatory" },
    { name: "Renewables" },
    { name: "Mains Heating" },
    { name: "Secondary Heating" },
    { name: "Water Heating" },
    { name: "Ventilation" },
    { name: "Lighting" },
    { name: "Walls" },
    { name: "Loft" },
    { name: "Floor" },
  ];

  const BUILDING_TAGS = ["Main", "Ext1", "Ext2", "Ext3", "Ext4"];
  const DEFAULT_BUILDING = "Main";
  // Storage / export quality: keep individual exported images at near-original
  // fidelity. Camera captures are re-encoded once when the date/GPS overlay is
  // burned in; uploads keep their original bytes unless they exceed the ceiling.
  const MAX_DIMENSION = 5000;
  const JPEG_QUALITY = 1.0;
  // PDF embedding: re-encode each image at a smaller dimension and lower
  // quality so the report PDF stays compact (compress: true is also set on
  // the jsPDF doc itself).
  const PDF_MAX_DIMENSION = 1400;
  const PDF_JPEG_QUALITY = 0.6;

  // -------------------- IndexedDB --------------------
  const IDB = (() => {
    let dbp = null;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_PROPERTIES)) {
            db.createObjectStore(STORE_PROPERTIES, { keyPath: "id" });
          }
          if (!db.objectStoreNames.contains(STORE_PHOTOS)) {
            const s = db.createObjectStore(STORE_PHOTOS, { keyPath: "id" });
            s.createIndex("propertyId", "propertyId", { unique: false });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return dbp;
    }
    function req(storeName, mode, fn) {
      return open().then(
        (db) =>
          new Promise((resolve, reject) => {
            const t = db.transaction(storeName, mode);
            const store = t.objectStore(storeName);
            let result;
            Promise.resolve(fn(store)).then((r) => (result = r));
            t.oncomplete = () => resolve(result);
            t.onerror = () => reject(t.error);
            t.onabort = () => reject(t.error);
          })
      );
    }
    return {
      async listProperties() {
        return req(STORE_PROPERTIES, "readonly", (s) => {
          return new Promise((resolve, reject) => {
            const r = s.getAll();
            r.onsuccess = () => resolve(r.result || []);
            r.onerror = () => reject(r.error);
          });
        });
      },
      async getProperty(id) {
        return req(STORE_PROPERTIES, "readonly", (s) => {
          return new Promise((resolve, reject) => {
            const r = s.get(id);
            r.onsuccess = () => resolve(r.result || null);
            r.onerror = () => reject(r.error);
          });
        });
      },
      async putProperty(p) {
        return req(STORE_PROPERTIES, "readwrite", (s) => s.put(p));
      },
      async deleteProperty(id) {
        return req(STORE_PROPERTIES, "readwrite", (s) => s.delete(id));
      },
      async putPhoto(photo) {
        return req(STORE_PHOTOS, "readwrite", (s) => s.put(photo));
      },
      async deletePhoto(id) {
        return req(STORE_PHOTOS, "readwrite", (s) => s.delete(id));
      },
      async getPhotosByProperty(propertyId) {
        return req(STORE_PHOTOS, "readonly", (s) => {
          return new Promise((resolve, reject) => {
            const idx = s.index("propertyId");
            const r = idx.getAll(IDBKeyRange.only(propertyId));
            r.onsuccess = () => resolve(r.result || []);
            r.onerror = () => reject(r.error);
          });
        });
      },
      async deletePhotosByProperty(propertyId) {
        return req(STORE_PHOTOS, "readwrite", (s) => {
          return new Promise((resolve, reject) => {
            const idx = s.index("propertyId");
            const r = idx.openCursor(IDBKeyRange.only(propertyId));
            r.onsuccess = () => {
              const cur = r.result;
              if (!cur) return resolve();
              cur.delete();
              cur.continue();
            };
            r.onerror = () => reject(r.error);
          });
        });
      },
    };
  })();

  // -------------------- State --------------------
  const state = {
    properties: [], // [{ id, name }] — summary for switcher
    currentId: null,
    property: null, // full active property { id, name, meta, groups }
    photos: new Map(), // photoId -> photo record
    expanded: new Set(), // group ids currently expanded in the accordion
    view: "group", // "group" | "tag"
    gps: null,
    gpsWatchId: null,
  };

  // -------------------- Elements --------------------
  const els = {
    groups: document.getElementById("groups"),
    groupTpl: document.getElementById("group-template"),
    thumbTpl: document.getElementById("thumb-template"),
    addGroupName: document.getElementById("new-group-name"),
    addGroupBtn: document.getElementById("btn-add-group"),
    gpsBtn: document.getElementById("btn-enable-gps"),
    gpsDot: document.getElementById("gps-dot"),
    gpsLabel: document.getElementById("gps-label"),
    exportBtn: document.getElementById("btn-export"),
    exportPhotosBtn: document.getElementById("btn-export-photos"),
    exportPhotosDialog: document.getElementById("export-photos-dialog"),
    exportPhotosBackdrop: document.getElementById("export-photos-backdrop"),
    exportPhotosShareBtn: document.getElementById("export-photos-share"),
    exportPhotosZipBtn: document.getElementById("export-photos-zip"),
    exportPhotosCancelBtn: document.getElementById("export-photos-cancel"),
    exportPhotosHelp: document.getElementById("export-photos-help"),
    pdfLayoutDialog: document.getElementById("pdf-layout-dialog"),
    pdfLayoutBackdrop: document.getElementById("pdf-layout-backdrop"),
    pdfLayoutGroupBtn: document.getElementById("pdf-layout-group"),
    pdfLayoutTagBtn: document.getElementById("pdf-layout-tag"),
    pdfLayoutCancelBtn: document.getElementById("pdf-layout-cancel"),
    viewToggleBtns: Array.from(document.querySelectorAll(".view-toggle-btn")),
    lightbox: document.getElementById("lightbox"),
    lightboxImg: document.getElementById("lightbox-img"),
    lightboxCaption: document.getElementById("lightbox-caption"),
    lightboxCloseBtn: document.querySelector(".lightbox-close"),
    lightboxPrevBtn: document.querySelector(".lightbox-prev"),
    lightboxNextBtn: document.querySelector(".lightbox-next"),
    toast: document.getElementById("toast"),
    propSelect: document.getElementById("property-select"),
    newPropBtn: document.getElementById("btn-new-property"),
    delPropBtn: document.getElementById("btn-delete-property"),
    saveStatus: document.getElementById("save-status"),
    metaName: document.getElementById("meta-name"),
    metaAssessor: document.getElementById("meta-assessor"),
    metaAddress: document.getElementById("meta-address"),
    metaRef: document.getElementById("meta-ref"),
    metaDate: document.getElementById("meta-date"),
  };

  // -------------------- Utils --------------------
  function uid(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function slugify(s) {
    return (
      String(s)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "")
        .slice(0, 40) || "group"
    );
  }

  function todayISO() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function formatStamp(date) {
    const pad = (n) => String(n).padStart(2, "0");
    return (
      `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ` +
      `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    );
  }

  function formatGps(gps) {
    if (!gps) return "GPS: unavailable";
    const lat = gps.latitude.toFixed(5);
    const lon = gps.longitude.toFixed(5);
    const acc = gps.accuracy ? `±${Math.round(gps.accuracy)}m` : "";
    return `${lat}°, ${lon}°  ${acc}`.trim();
  }

  let toastTimer = null;
  function toast(message, variant) {
    els.toast.textContent = message;
    els.toast.classList.toggle("err", variant === "err");
    els.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove("show"), 2600);
  }

  function setSaveStatus(kind) {
    els.saveStatus.classList.remove("saving", "error");
    if (kind === "saving") {
      els.saveStatus.classList.add("saving");
      els.saveStatus.textContent = "Saving…";
    } else if (kind === "error") {
      els.saveStatus.classList.add("error");
      els.saveStatus.textContent = "Save failed";
    } else {
      els.saveStatus.textContent = "Saved";
    }
  }

  function debounce(fn, ms) {
    let t = null;
    const debounced = (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
    debounced.flush = () => {
      clearTimeout(t);
      t = null;
    };
    return debounced;
  }

  // -------------------- GPS --------------------
  function setGpsStatus(status, text) {
    els.gpsDot.classList.remove("ok", "err");
    if (status === "ok") els.gpsDot.classList.add("ok");
    if (status === "err") els.gpsDot.classList.add("err");
    if (text) els.gpsLabel.textContent = text;
  }

  function enableGps() {
    if (!("geolocation" in navigator)) {
      setGpsStatus("err", "No GPS support");
      toast("This device/browser does not support geolocation.", "err");
      return;
    }
    setGpsStatus(null, "Locating…");

    const onSuccess = (pos) => {
      state.gps = {
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        timestamp: pos.timestamp,
      };
      setGpsStatus("ok", `GPS on (±${Math.round(pos.coords.accuracy)}m)`);
    };
    const onError = (err) => {
      setGpsStatus("err", "GPS off");
      toast(`GPS error: ${err.message}`, "err");
    };

    navigator.geolocation.getCurrentPosition(onSuccess, onError, {
      enableHighAccuracy: true,
      maximumAge: 10000,
      timeout: 15000,
    });

    if (state.gpsWatchId !== null) {
      navigator.geolocation.clearWatch(state.gpsWatchId);
    }
    state.gpsWatchId = navigator.geolocation.watchPosition(onSuccess, onError, {
      enableHighAccuracy: true,
      maximumAge: 5000,
    });
  }

  // -------------------- Image processing --------------------
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = (e) => {
        URL.revokeObjectURL(url);
        reject(e);
      };
      img.src = url;
    });
  }

  function loadImageFromDataUrl(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = (e) => reject(e);
      img.src = dataUrl;
    });
  }

  async function reencodeForPdf(dataUrl) {
    try {
      const img = await loadImageFromDataUrl(dataUrl);
      const longest = Math.max(img.naturalWidth, img.naturalHeight);
      const scale = longest > PDF_MAX_DIMENSION ? PDF_MAX_DIMENSION / longest : 1;
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      return canvas.toDataURL("image/jpeg", PDF_JPEG_QUALITY);
    } catch (err) {
      console.warn("PDF re-encode failed; embedding original.", err);
      return dataUrl;
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawOverlay(ctx, width, height, dateText, gpsText) {
    const pad = Math.round(Math.min(width, height) * 0.015);
    const fontPx = Math.max(14, Math.round(Math.min(width, height) * 0.028));
    ctx.font = `600 ${fontPx}px -apple-system, Roboto, "Segoe UI", Arial, sans-serif`;
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "right";

    const lineGap = Math.round(fontPx * 0.35);
    const lines = [dateText, gpsText];
    const metrics = lines.map((l) => ctx.measureText(l));
    const maxWidth = Math.max(...metrics.map((m) => m.width));
    const boxH = lines.length * fontPx + (lines.length - 1) * lineGap + pad * 2;
    const boxW = maxWidth + pad * 2;
    const x = width - pad;
    const yTop = height - pad - boxH;

    ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
    roundRect(ctx, x - boxW + pad, yTop, boxW, boxH, Math.round(pad * 0.6));
    ctx.fill();

    ctx.fillStyle = "#fff";
    ctx.shadowColor = "rgba(0,0,0,0.75)";
    ctx.shadowBlur = 2;
    let y = yTop + pad + fontPx;
    for (const line of lines) {
      ctx.fillText(line, x, y);
      y += fontPx + lineGap;
    }
    ctx.shadowBlur = 0;
  }

  async function processFile(file) {
    const img = await loadImage(file);
    const longest = Math.max(img.naturalWidth, img.naturalHeight);
    const scale = longest > MAX_DIMENSION ? MAX_DIMENSION / longest : 1;
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, w, h);

    const stampDate = new Date();
    drawOverlay(ctx, w, h, formatStamp(stampDate), formatGps(state.gps));

    const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
    return {
      id: uid("p"),
      source: "camera",
      dataUrl,
      width: w,
      height: h,
      takenAt: stampDate.toISOString(),
      gps: state.gps ? { ...state.gps } : null,
      building: DEFAULT_BUILDING,
      label: "",
    };
  }

  // -------------------- Upload / EXIF read helpers --------------------
  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
  }

  function dmsToDeg(arr) {
    if (!Array.isArray(arr) || arr.length !== 3) return null;
    try {
      const [[dN, dD], [mN, mD], [sN, sD]] = arr;
      return dN / dD + mN / mD / 60 + sN / sD / 3600;
    } catch (_) {
      return null;
    }
  }

  function parseExifDateTime(str) {
    if (!str || typeof str !== "string") return null;
    const m = str.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
    if (!m) return null;
    const [, y, mo, d, h, mi, s] = m;
    const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}`);
    return isNaN(date.getTime()) ? null : date.toISOString();
  }

  function readExifFromDataUrl(dataUrl) {
    if (typeof piexif === "undefined") return { takenAt: null, gps: null, rawExif: null };
    try {
      const exif = piexif.load(dataUrl);
      const dtStr =
        (exif.Exif && exif.Exif[piexif.ExifIFD.DateTimeOriginal]) ||
        (exif.Exif && exif.Exif[piexif.ExifIFD.DateTimeDigitized]) ||
        (exif["0th"] && exif["0th"][piexif.ImageIFD.DateTime]) ||
        null;
      const takenAt = parseExifDateTime(dtStr);

      let gps = null;
      if (exif.GPS && exif.GPS[piexif.GPSIFD.GPSLatitude] && exif.GPS[piexif.GPSIFD.GPSLongitude]) {
        const lat = dmsToDeg(exif.GPS[piexif.GPSIFD.GPSLatitude]);
        const lon = dmsToDeg(exif.GPS[piexif.GPSIFD.GPSLongitude]);
        if (lat != null && lon != null) {
          const latRef = exif.GPS[piexif.GPSIFD.GPSLatitudeRef] || "N";
          const lonRef = exif.GPS[piexif.GPSIFD.GPSLongitudeRef] || "E";
          gps = {
            latitude: latRef === "S" ? -lat : lat,
            longitude: lonRef === "W" ? -lon : lon,
            accuracy: null,
          };
        }
      }

      let rawExif = null;
      try {
        rawExif = piexif.dump(exif);
      } catch (_) {
        rawExif = null;
      }
      return { takenAt, gps, rawExif };
    } catch (err) {
      return { takenAt: null, gps: null, rawExif: null };
    }
  }

  async function processUploadedFile(file) {
    const originalDataUrl = await readFileAsDataUrl(file);
    const { takenAt, gps, rawExif } = readExifFromDataUrl(originalDataUrl);

    const img = await loadImage(file);
    const longest = Math.max(img.naturalWidth, img.naturalHeight);
    const scale = longest > MAX_DIMENSION ? MAX_DIMENSION / longest : 1;

    let dataUrl = originalDataUrl;
    let w = img.naturalWidth;
    let h = img.naturalHeight;

    if (scale < 1) {
      w = Math.round(img.naturalWidth * scale);
      h = Math.round(img.naturalHeight * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
      if (rawExif) {
        try {
          dataUrl = piexif.insert(rawExif, dataUrl);
        } catch (_) {
          /* fall back to no-exif resized copy */
        }
      }
    }

    return {
      id: uid("p"),
      source: "upload",
      dataUrl,
      width: w,
      height: h,
      takenAt, // from EXIF, may be null
      gps, // from EXIF, may be null
      uploadedAt: new Date().toISOString(),
      originalName: file.name || "",
      building: DEFAULT_BUILDING,
      label: "",
    };
  }

  // -------------------- Persistence --------------------
  const saveProperty = debounce(async () => {
    if (!state.property) return;
    state.property.updatedAt = new Date().toISOString();
    try {
      setSaveStatus("saving");
      await IDB.putProperty(state.property);
      refreshPropertyList();
      setSaveStatus("saved");
    } catch (err) {
      console.error(err);
      setSaveStatus("error");
      toast("Couldn't save — storage may be full.", "err");
    }
  }, 400);

  async function savePhotoNow(photo) {
    try {
      await IDB.putPhoto(photo);
    } catch (err) {
      console.error(err);
      toast("Couldn't save photo to local storage.", "err");
    }
  }

  function refreshPropertyList() {
    if (!state.property) return;
    const entry = state.properties.find((p) => p.id === state.property.id);
    if (entry) entry.name = state.property.name;
    renderPropertySelect();
  }

  // -------------------- Property manager --------------------
  function makeDefaultGroups() {
    return DEFAULT_GROUPS.map((g) => ({
      id: uid("g"),
      name: g.name,
      photoIds: [],
      protected: true,
    }));
  }

  // Rename legacy top-level names that have changed. (Historically these
  // were sub-group renames; now they're top-level too.)
  const LEGACY_RENAMES = {
    "wall thickness": "Walls",
    roof: "Loft",
  };

  function migrateDefaults(property, photosMap) {
    if (!property || !Array.isArray(property.groups)) {
      return { changed: false, dirtyPhotoIds: [] };
    }
    let changed = false;
    const dirtyPhotoIds = [];

    // Rename legacy group names.
    for (const g of property.groups) {
      const norm = (g.name || "").trim().toLowerCase();
      if (LEGACY_RENAMES[norm]) {
        g.name = LEGACY_RENAMES[norm];
        changed = true;
      }
    }

    // Collapse the old Main Property / Extension N sections into flat
    // top-level groups, stamping each affected photo with its building tag.
    const sectioned = property.groups.filter((g) => g.section);
    if (sectioned.length) {
      const findOrCreateFlat = (name) => {
        const lower = (name || "").toLowerCase();
        let top = property.groups.find(
          (g) => !g.section && (g.name || "").toLowerCase() === lower
        );
        if (!top) {
          top = { id: uid("g"), name, photoIds: [], protected: true };
          property.groups.push(top);
        }
        return top;
      };
      for (const sg of sectioned) {
        const section = sg.section;
        let building = DEFAULT_BUILDING;
        if (section === "Main Property") building = "Main";
        else if (section.startsWith("Extension ")) {
          const n = section.slice("Extension ".length).trim();
          if (/^\d+$/.test(n)) building = `Ext${n}`;
        }
        const target = findOrCreateFlat(sg.name);
        for (const pid of sg.photoIds) {
          const photo = photosMap && photosMap.get(pid);
          if (photo) {
            photo.building = building;
            if (photo.propertyId === property.id) dirtyPhotoIds.push(pid);
          }
          if (!target.photoIds.includes(pid)) target.photoIds.push(pid);
        }
      }
      property.groups = property.groups.filter((g) => !g.section);
      changed = true;
    }

    // Add any missing flat default groups.
    const existingNames = new Set(
      property.groups.map((g) => (g.name || "").trim().toLowerCase())
    );
    for (const d of DEFAULT_GROUPS) {
      if (!existingNames.has(d.name.toLowerCase())) {
        property.groups.push({
          id: uid("g"),
          name: d.name,
          photoIds: [],
          protected: true,
        });
        changed = true;
      }
    }

    // Apply the protected flag to any group that matches a default name.
    const flatDefaultNames = new Set(DEFAULT_GROUPS.map((g) => g.name.toLowerCase()));
    for (const group of property.groups) {
      if (group.protected) continue;
      const norm = (group.name || "").trim().toLowerCase();
      if (flatDefaultNames.has(norm)) {
        group.protected = true;
        changed = true;
      }
    }

    return { changed, dirtyPhotoIds };
  }

  function makeNewProperty(name) {
    const id = uid("prop");
    const property = {
      id,
      name: name || `Property ${state.properties.length + 1}`,
      meta: {
        assessor: "",
        address: "",
        ref: "",
        date: todayISO(),
      },
      groups: makeDefaultGroups(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    return property;
  }

  async function createProperty(name) {
    const p = makeNewProperty(name);
    await IDB.putProperty(p);
    state.properties.push({ id: p.id, name: p.name });
    renderPropertySelect();
    await switchProperty(p.id);
  }

  async function deleteCurrentProperty() {
    if (!state.property) return;
    const name = state.property.name;
    if (!confirm(`Delete "${name}" and all its photos? This can't be undone.`)) return;
    const id = state.property.id;
    await IDB.deletePhotosByProperty(id);
    await IDB.deleteProperty(id);
    state.properties = state.properties.filter((p) => p.id !== id);

    if (!state.properties.length) {
      await createProperty("Property 1");
      return;
    }
    const next = state.properties[0].id;
    await switchProperty(next);
    toast(`Deleted "${name}".`);
  }

  async function switchProperty(id) {
    saveProperty.flush();
    const prop = await IDB.getProperty(id);
    if (!prop) {
      toast("Property not found.", "err");
      return;
    }
    state.currentId = id;
    state.property = prop;
    state.photos = new Map();
    const photos = await IDB.getPhotosByProperty(id);
    for (const p of photos) state.photos.set(p.id, p);
    localStorage.setItem(ACTIVE_KEY, id);

    if (!state.property.groups || !state.property.groups.length) {
      state.property.groups = makeDefaultGroups();
      saveProperty();
    } else {
      const migration = migrateDefaults(state.property, state.photos);
      if (migration.changed) {
        for (const pid of migration.dirtyPhotoIds) {
          const photo = state.photos.get(pid);
          if (photo) {
            try {
              await IDB.putPhoto(photo);
            } catch (err) {
              console.warn("Failed to persist migrated photo", err);
            }
          }
        }
        saveProperty();
      }
    }

    initExpandedForProperty();
    renderMeta();
    renderGroups();
    renderPropertySelect();
    updateExportButton();
    setSaveStatus("saved");
  }

  function renderPropertySelect() {
    els.propSelect.innerHTML = "";
    for (const p of state.properties) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name || "(untitled)";
      if (p.id === state.currentId) opt.selected = true;
      els.propSelect.appendChild(opt);
    }
  }

  function renderMeta() {
    const p = state.property;
    els.metaName.value = p.name || "";
    els.metaAssessor.value = p.meta.assessor || "";
    els.metaAddress.value = p.meta.address || "";
    els.metaRef.value = p.meta.ref || "";
    els.metaDate.value = p.meta.date || todayISO();
  }

  // -------------------- Groups / photos rendering --------------------
  function initExpandedForProperty() {
    state.expanded.clear();
    if (state.view === "tag") {
      for (const t of BUILDING_TAGS) state.expanded.add(tagGroupId(t));
    } else {
      const ext = (state.property.groups || []).find(
        (g) => !g.section && (g.name || "").toLowerCase() === "external elevations"
      );
      if (ext) state.expanded.add(ext.id);
    }
  }

  function tagGroupId(tag) {
    return `tag-${tag}`;
  }

  function photoBuildingOf(photo) {
    return BUILDING_TAGS.includes(photo.building) ? photo.building : DEFAULT_BUILDING;
  }

  function setView(view) {
    if (view !== "group" && view !== "tag") return;
    if (state.view === view) return;
    state.view = view;
    for (const btn of els.viewToggleBtns) {
      const active = btn.dataset.view === view;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", String(active));
    }
    initExpandedForProperty();
    renderGroups();
  }

  function toggleGroup(group, node) {
    const nowExpanded = !state.expanded.has(group.id);
    if (nowExpanded) state.expanded.add(group.id);
    else state.expanded.delete(group.id);
    node.classList.toggle("collapsed", !nowExpanded);
    const header = node.querySelector(".group-header");
    if (header) header.setAttribute("aria-expanded", String(nowExpanded));
  }

  function expandGroup(group) {
    state.expanded.add(group.id);
    const node = els.groups.querySelector(`[data-group-id="${group.id}"]`);
    if (node) {
      node.classList.remove("collapsed");
      const header = node.querySelector(".group-header");
      if (header) header.setAttribute("aria-expanded", "true");
    }
  }

  function renderGroups() {
    els.groups.innerHTML = "";
    if (state.view === "tag") {
      renderByTag();
    } else {
      for (const group of state.property.groups) {
        renderGroup(group, els.groups);
      }
    }
  }

  function renderByTag() {
    // Bucket every photo by its building tag, tracking the originating group
    // so the thumb can still show a hint and delete/reorder correctly.
    const buckets = new Map();
    for (const t of BUILDING_TAGS) buckets.set(t, []);
    for (const group of state.property.groups) {
      for (const pid of group.photoIds) {
        const photo = state.photos.get(pid);
        if (!photo) continue;
        buckets.get(photoBuildingOf(photo)).push({ group, photo });
      }
    }
    for (const tag of BUILDING_TAGS) {
      const entries = buckets.get(tag);
      if (!entries.length) continue;
      const synthetic = {
        id: tagGroupId(tag),
        name: tag,
        photoIds: entries.map((e) => e.photo.id),
        protected: true,
        virtual: true,
        tag,
      };
      renderTagGroup(synthetic, entries);
    }
  }

  function renderTagGroup(synthetic, entries) {
    const node = els.groupTpl.content.firstElementChild.cloneNode(true);
    node.dataset.groupId = synthetic.id;
    node.classList.add("group-virtual");

    const header = node.querySelector(".group-header");
    const expanded = state.expanded.has(synthetic.id);
    if (!expanded) node.classList.add("collapsed");
    header.setAttribute("aria-expanded", String(expanded));
    header.addEventListener("click", (e) => {
      if (e.target.closest("button, input, [contenteditable='true']")) return;
      toggleGroup(synthetic, node);
    });
    header.addEventListener("keydown", (e) => {
      if (e.target !== header) return;
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        toggleGroup(synthetic, node);
      }
    });

    const title = node.querySelector(".group-title");
    title.textContent = synthetic.name;
    title.setAttribute("contenteditable", "false");
    title.classList.add("group-title-locked");

    // No Take photo / Upload / Remove buttons in virtual tag groups.
    const actions = node.querySelector(".group-actions");
    if (actions) actions.remove();
    const addTile = node.querySelector(".thumb-add");
    if (addTile) addTile.remove();

    els.groups.appendChild(node);

    for (const { group, photo } of entries) {
      renderThumb(group, photo, { hint: group.name });
    }
    updateGroupCount(synthetic);
  }

  function renderGroup(group, container) {
    const node = els.groupTpl.content.firstElementChild.cloneNode(true);
    node.dataset.groupId = group.id;

    const header = node.querySelector(".group-header");
    const expanded = state.expanded.has(group.id);
    if (!expanded) node.classList.add("collapsed");
    header.setAttribute("aria-expanded", String(expanded));
    header.addEventListener("click", (e) => {
      if (e.target.closest("button, input, [contenteditable='true']")) return;
      toggleGroup(group, node);
    });
    header.addEventListener("keydown", (e) => {
      if (e.target !== header) return;
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        toggleGroup(group, node);
      }
    });

    const title = node.querySelector(".group-title");
    title.textContent = group.name;
    if (group.protected) {
      // Default group names are fixed to keep the report structure consistent.
      title.setAttribute("contenteditable", "false");
      title.classList.add("group-title-locked");
    } else {
      title.addEventListener("blur", () => {
        const v = title.textContent.trim();
        group.name = v || "Untitled group";
        title.textContent = group.name;
        saveProperty();
      });
      title.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          title.blur();
        }
      });
    }

    const takeButtons = node.querySelectorAll(".btn-take-photo, .btn-take-photo-tile");
    takeButtons.forEach((btn) => {
      btn.addEventListener("click", () => openCamera(group));
    });

    const uploadInput = node.querySelector(".file-input-upload");
    if (uploadInput) {
      uploadInput.addEventListener("change", async (e) => {
        const files = Array.from(e.target.files || []);
        uploadInput.value = "";
        if (files.length) await addUploadedPhotos(group, files);
      });
    }

    const removeBtn = node.querySelector(".btn-remove-group");
    if (group.protected) {
      removeBtn.remove();
    } else {
      removeBtn.addEventListener("click", () => removeGroup(group.id));
    }

    (container || els.groups).appendChild(node);
    for (const id of group.photoIds) {
      const photo = state.photos.get(id);
      if (photo) renderThumb(group, photo);
    }
    updateGroupCount(group);
  }

  function updateGroupCount(group) {
    const node = els.groups.querySelector(`[data-group-id="${group.id}"] .group-count`);
    if (!node) return;
    const n = group.photoIds.length;
    node.textContent = `${n} photo${n === 1 ? "" : "s"}`;
  }

  function renderThumb(group, photo, opts) {
    const options = opts || {};
    const containerId = options.containerGroupId || group.id;
    const thumbsEl = els.groups.querySelector(`[data-group-id="${containerId}"] .thumbs`);
    if (!thumbsEl) return;
    const node = els.thumbTpl.content.firstElementChild.cloneNode(true);
    node.dataset.photoId = photo.id;
    const img = node.querySelector("img");
    img.src = photo.dataUrl;
    img.alt = photo.label;
    img.addEventListener("click", () => openLightbox(group, photo));

    const hint = node.querySelector(".thumb-group-hint");
    if (hint) {
      if (options.hint) hint.textContent = options.hint;
      else hint.remove();
    }

    const labelInput = node.querySelector(".thumb-label");
    labelInput.value = photo.label || "";

    const saveLabel = debounce(() => savePhotoNow(photo), 500);
    labelInput.addEventListener("input", () => {
      photo.label = labelInput.value;
      saveLabel();
      saveProperty();
    });

    const buildingSelect = node.querySelector(".thumb-building");
    if (buildingSelect) {
      const current = BUILDING_TAGS.includes(photo.building) ? photo.building : DEFAULT_BUILDING;
      buildingSelect.value = current;
      if (photo.building !== current) {
        photo.building = current;
      }
      buildingSelect.addEventListener("change", () => {
        photo.building = buildingSelect.value;
        savePhotoNow(photo).catch((err) => console.warn("Failed to save building tag", err));
        if (state.view === "tag") {
          // Re-categorise so the thumb moves into the right bucket.
          renderGroups();
        }
      });
    }

    node.querySelector(".thumb-remove").addEventListener("click", async () => {
      const label = photo.label || `photo ${group.photoIds.indexOf(photo.id) + 1}`;
      if (!confirm(`Delete "${label}" from ${group.name}? This can't be undone.`)) return;
      const i = group.photoIds.indexOf(photo.id);
      if (i !== -1) group.photoIds.splice(i, 1);
      state.photos.delete(photo.id);
      node.remove();
      updateGroupCount(group);
      updateExportButton();
      try {
        await IDB.deletePhoto(photo.id);
      } catch (err) {
        console.error(err);
      }
      saveProperty();
      if (state.view === "tag") renderGroups();
    });

    // Drag-to-reorder is only meaningful in the default "by group" layout
    // where all thumbs belong to the same group.
    if (state.view === "group") {
      node.addEventListener("dragstart", () => node.classList.add("dragging"));
      node.addEventListener("dragend", () => node.classList.remove("dragging"));
      node.addEventListener("dragover", (e) => {
        e.preventDefault();
        const dragging = thumbsEl.querySelector(".thumb.dragging");
        if (!dragging || dragging === node) return;
        const rect = node.getBoundingClientRect();
        const before = e.clientY < rect.top + rect.height / 2;
        thumbsEl.insertBefore(dragging, before ? node : node.nextSibling);
      });
      node.addEventListener("drop", () => {
        const newOrder = Array.from(thumbsEl.querySelectorAll(".thumb"))
          .map((el) => el.dataset.photoId)
          .filter(Boolean);
        group.photoIds = newOrder.slice();
        saveProperty();
      });
    } else {
      node.draggable = false;
    }

    const addTile = thumbsEl.querySelector(".thumb-add");
    if (addTile) thumbsEl.insertBefore(node, addTile);
    else thumbsEl.appendChild(node);
  }

  async function addUploadedPhotos(group, files) {
    const imageFiles = files.filter((f) => f.type.startsWith("image/"));
    if (!imageFiles.length) {
      toast("Please select image files.", "err");
      return;
    }
    toast(`Uploading ${imageFiles.length} photo${imageFiles.length === 1 ? "" : "s"}…`);

    // Make sure the receiving group is visible so the new thumbs appear.
    expandGroup(group);

    let missingExifCount = 0;
    for (const file of imageFiles) {
      try {
        const photo = await processUploadedFile(file);
        photo.propertyId = state.property.id;
        photo.label = `${group.name} — ${group.photoIds.length + 1}`;
        state.photos.set(photo.id, photo);
        group.photoIds.push(photo.id);
        if (!photo.takenAt || !photo.gps) missingExifCount += 1;
        await savePhotoNow(photo);
        renderThumb(group, photo);
        updateGroupCount(group);
      } catch (err) {
        console.error(err);
        toast(`Failed to process ${file.name}`, "err");
      }
    }
    updateExportButton();
    saveProperty();
    if (missingExifCount) {
      toast(
        `${missingExifCount} upload${missingExifCount === 1 ? "" : "s"} missing date/GPS in metadata — shown as “not in photo metadata” in the PDF.`
      );
    } else {
      toast(`Uploaded ${imageFiles.length} photo${imageFiles.length === 1 ? "" : "s"}.`);
    }
  }

  function addGroup(name) {
    const group = { id: uid("g"), name: name || "Untitled group", photoIds: [] };
    state.property.groups.push(group);
    state.expanded.add(group.id);
    renderGroup(group);
    updateExportButton();
    saveProperty();
  }

  function removeGroup(groupId) {
    const idx = state.property.groups.findIndex((g) => g.id === groupId);
    if (idx === -1) return;
    const group = state.property.groups[idx];
    if (group.protected) {
      toast("This is a default group and can't be removed.", "err");
      return;
    }
    if (!confirm(`Remove the "${group.name}" group${group.photoIds.length ? ` and its ${group.photoIds.length} photo(s)` : ""}? This can't be undone.`)) return;
    (async () => {
      for (const pid of group.photoIds) {
        state.photos.delete(pid);
        try {
          await IDB.deletePhoto(pid);
        } catch (err) {
          console.error(err);
        }
      }
      state.property.groups.splice(idx, 1);
      const el = els.groups.querySelector(`[data-group-id="${groupId}"]`);
      if (el) el.remove();
      updateExportButton();
      saveProperty();
    })();
  }

  function updateExportButton() {
    const disabled = !state.property || !state.property.groups.some((g) => g.photoIds.length > 0);
    els.exportBtn.disabled = disabled;
    els.exportPhotosBtn.disabled = disabled;
  }

  // -------------------- Lightbox (full-size photo viewer) --------------------
  const lightbox = {
    photos: [], // array of photo records currently being browsed
    index: 0,
  };

  function openLightbox(group, photo) {
    // Browse the photos that share the same DOM container as the tapped thumb
    // (the "group" in by-group view, or the building tag bucket in tag view).
    const containerSelector = state.view === "tag"
      ? `[data-group-id="${tagGroupId(photoBuildingOf(photo))}"] .thumb`
      : `[data-group-id="${group.id}"] .thumb:not(.thumb-add)`;
    const ids = Array.from(document.querySelectorAll(containerSelector))
      .map((n) => n.dataset.photoId)
      .filter(Boolean);
    const list = ids.map((id) => state.photos.get(id)).filter(Boolean);
    if (!list.length) return;
    lightbox.photos = list;
    lightbox.index = Math.max(0, list.findIndex((p) => p.id === photo.id));
    updateLightbox();
    els.lightbox.hidden = false;
    els.lightbox.setAttribute("aria-hidden", "false");
  }

  function updateLightbox() {
    const p = lightbox.photos[lightbox.index];
    if (!p) return closeLightbox();
    els.lightboxImg.src = p.dataUrl;
    els.lightboxImg.alt = p.label || "";
    const pieces = [];
    if (p.label) pieces.push(p.label);
    const tag = photoBuildingOf(p);
    pieces.push(tag);
    if (p.takenAt) pieces.push(new Date(p.takenAt).toLocaleString());
    else if (p.uploadedAt) pieces.push(`Uploaded ${new Date(p.uploadedAt).toLocaleString()}`);
    if (p.gps) pieces.push(formatGps(p.gps));
    els.lightboxCaption.textContent = pieces.join(" · ") +
      `  (${lightbox.index + 1} of ${lightbox.photos.length})`;
    els.lightboxPrevBtn.disabled = lightbox.index === 0;
    els.lightboxNextBtn.disabled = lightbox.index === lightbox.photos.length - 1;
  }

  function stepLightbox(delta) {
    const next = lightbox.index + delta;
    if (next < 0 || next >= lightbox.photos.length) return;
    lightbox.index = next;
    updateLightbox();
  }

  function closeLightbox() {
    els.lightbox.hidden = true;
    els.lightbox.setAttribute("aria-hidden", "true");
    els.lightboxImg.src = "";
    lightbox.photos = [];
  }

  els.lightboxCloseBtn.addEventListener("click", closeLightbox);
  els.lightboxPrevBtn.addEventListener("click", () => stepLightbox(-1));
  els.lightboxNextBtn.addEventListener("click", () => stepLightbox(1));
  els.lightbox.addEventListener("click", (e) => {
    if (e.target === els.lightbox) closeLightbox();
  });
  document.addEventListener("keydown", (e) => {
    if (els.lightbox.hidden) return;
    if (e.key === "Escape") closeLightbox();
    else if (e.key === "ArrowLeft") stepLightbox(-1);
    else if (e.key === "ArrowRight") stepLightbox(1);
  });

  // -------------------- In-app camera --------------------
  const camera = {
    stream: null,
    facingMode: "environment",
    group: null,
    buffer: [],
    els: {
      overlay: document.getElementById("camera-overlay"),
      video: document.getElementById("camera-video"),
      flash: document.getElementById("camera-flash"),
      title: document.getElementById("camera-title"),
      count: document.getElementById("camera-count"),
      thumbs: document.getElementById("camera-thumbs"),
      shutter: document.getElementById("camera-shutter"),
      done: document.getElementById("camera-done"),
      cancel: document.getElementById("camera-cancel"),
      switch: document.getElementById("camera-switch"),
    },
  };

  async function openCamera(group) {
    camera.group = group;
    camera.buffer = [];
    camera.els.title.textContent = group.name;
    updateCameraCount();
    renderCameraBuffer();
    camera.els.overlay.hidden = false;
    camera.els.overlay.setAttribute("aria-hidden", "false");
    try {
      await startCameraStream(camera.facingMode);
    } catch (err) {
      console.warn("getUserMedia failed", err);
      camera.els.overlay.hidden = true;
      camera.els.overlay.setAttribute("aria-hidden", "true");
      toast("Can't open the in-app camera — check camera permission.", "err");
      return;
    }
  }

  async function startCameraStream(facingMode) {
    if (camera.stream) {
      camera.stream.getTracks().forEach((t) => t.stop());
      camera.stream = null;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("Camera API not available");
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: facingMode },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    });
    camera.stream = stream;
    camera.facingMode = facingMode;
    camera.els.video.srcObject = stream;
    try {
      await camera.els.video.play();
    } catch (_) {
      /* autoplay quirks ignored */
    }
  }

  function closeCamera(save) {
    if (camera.stream) {
      camera.stream.getTracks().forEach((t) => t.stop());
      camera.stream = null;
    }
    camera.els.video.srcObject = null;
    camera.els.overlay.hidden = true;
    camera.els.overlay.setAttribute("aria-hidden", "true");

    if (save && camera.buffer.length && camera.group) {
      commitBufferedPhotos(camera.group, camera.buffer);
    }
    camera.buffer = [];
    camera.group = null;
    renderCameraBuffer();
    updateCameraCount();
  }

  function flashScreen() {
    camera.els.flash.classList.add("show");
    setTimeout(() => camera.els.flash.classList.remove("show"), 110);
  }

  function captureFrame() {
    const video = camera.els.video;
    if (!video.videoWidth || !video.videoHeight) return;
    const w = video.videoWidth;
    const h = video.videoHeight;
    const longest = Math.max(w, h);
    const scale = longest > MAX_DIMENSION ? MAX_DIMENSION / longest : 1;
    const outW = Math.round(w * scale);
    const outH = Math.round(h * scale);
    const canvas = document.createElement("canvas");
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, outW, outH);
    const stampDate = new Date();
    drawOverlay(ctx, outW, outH, formatStamp(stampDate), formatGps(state.gps));
    const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
    const photo = {
      id: uid("p"),
      source: "camera",
      dataUrl,
      width: outW,
      height: outH,
      takenAt: stampDate.toISOString(),
      gps: state.gps ? { ...state.gps } : null,
      building: DEFAULT_BUILDING,
      label: "",
    };
    camera.buffer.push(photo);
    flashScreen();
    renderCameraBuffer();
    updateCameraCount();
  }

  function updateCameraCount() {
    const n = camera.buffer.length;
    camera.els.count.textContent = n ? `${n} captured` : "0 captured";
    camera.els.done.textContent = n ? `Done (${n})` : "Done";
  }

  function renderCameraBuffer() {
    const el = camera.els.thumbs;
    el.innerHTML = "";
    camera.buffer.forEach((photo, i) => {
      const wrap = document.createElement("div");
      wrap.className = "cam-thumb";
      const img = document.createElement("img");
      img.src = photo.dataUrl;
      wrap.appendChild(img);
      const rm = document.createElement("button");
      rm.type = "button";
      rm.textContent = "×";
      rm.addEventListener("click", () => {
        camera.buffer.splice(i, 1);
        renderCameraBuffer();
        updateCameraCount();
      });
      wrap.appendChild(rm);
      el.appendChild(wrap);
    });
  }

  async function commitBufferedPhotos(group, photos) {
    // Auto-expand the group so newly-captured thumbs are immediately visible.
    expandGroup(group);
    for (const photo of photos) {
      photo.propertyId = state.property.id;
      photo.label = `${group.name} — ${group.photoIds.length + 1}`;
      state.photos.set(photo.id, photo);
      group.photoIds.push(photo.id);
      try {
        await savePhotoNow(photo);
      } catch (err) {
        console.error(err);
      }
      renderThumb(group, photo);
      updateGroupCount(group);
    }
    updateExportButton();
    saveProperty();
    toast(`Added ${photos.length} photo${photos.length === 1 ? "" : "s"} to ${group.name}.`);
  }

  camera.els.shutter.addEventListener("click", captureFrame);
  camera.els.done.addEventListener("click", () => closeCamera(true));
  camera.els.cancel.addEventListener("click", () => {
    if (camera.buffer.length && !confirm("Discard all captured photos?")) return;
    closeCamera(false);
  });
  camera.els.switch.addEventListener("click", async () => {
    try {
      await startCameraStream(camera.facingMode === "environment" ? "user" : "environment");
    } catch (err) {
      console.warn(err);
      toast("Couldn't switch camera.", "err");
    }
  });
  document.addEventListener("keydown", (e) => {
    if (camera.els.overlay.hidden) return;
    if (e.key === "Escape") {
      e.preventDefault();
      camera.els.cancel.click();
    } else if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      captureFrame();
    }
  });

  // -------------------- EXIF / binary helpers --------------------
  function exifDateTime(iso) {
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, "0");
    return (
      `${d.getFullYear()}:${pad(d.getMonth() + 1)}:${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    );
  }

  function degToDmsRational(deg) {
    const abs = Math.abs(deg);
    const d = Math.floor(abs);
    const mFloat = (abs - d) * 60;
    const m = Math.floor(mFloat);
    const s = Math.round((mFloat - m) * 60 * 10000);
    return [
      [d, 1],
      [m, 1],
      [s, 10000],
    ];
  }

  function buildExifDataUrl(photo) {
    if (typeof piexif === "undefined") return photo.dataUrl;
    try {
      const dt = exifDateTime(photo.takenAt || new Date().toISOString());
      const zeroth = {
        [piexif.ImageIFD.DateTime]: dt,
        [piexif.ImageIFD.Software]: "Photo Evidence",
      };
      const exif = {
        [piexif.ExifIFD.DateTimeOriginal]: dt,
        [piexif.ExifIFD.DateTimeDigitized]: dt,
      };
      const gps = {};
      if (photo.gps) {
        const lat = photo.gps.latitude;
        const lon = photo.gps.longitude;
        gps[piexif.GPSIFD.GPSLatitudeRef] = lat >= 0 ? "N" : "S";
        gps[piexif.GPSIFD.GPSLatitude] = degToDmsRational(lat);
        gps[piexif.GPSIFD.GPSLongitudeRef] = lon >= 0 ? "E" : "W";
        gps[piexif.GPSIFD.GPSLongitude] = degToDmsRational(lon);
        const d = new Date(photo.takenAt || Date.now());
        const pad = (n) => String(n).padStart(2, "0");
        gps[piexif.GPSIFD.GPSDateStamp] =
          `${d.getUTCFullYear()}:${pad(d.getUTCMonth() + 1)}:${pad(d.getUTCDate())}`;
        gps[piexif.GPSIFD.GPSTimeStamp] = [
          [d.getUTCHours(), 1],
          [d.getUTCMinutes(), 1],
          [d.getUTCSeconds(), 1],
        ];
      }
      const exifStr = piexif.dump({ "0th": zeroth, Exif: exif, GPS: gps });
      return piexif.insert(exifStr, photo.dataUrl);
    } catch (err) {
      console.warn("EXIF injection failed; using plain JPEG.", err);
      return photo.dataUrl;
    }
  }

  function dataUrlToBytes(dataUrl) {
    const base64 = dataUrl.split(",")[1] || "";
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // -------------------- PDF export with linked contents --------------------
  function reportBaseName() {
    const meta = state.property.meta;
    const parts = [
      "photo-evidence",
      slugify(state.property.name || "property"),
      meta.ref ? slugify(meta.ref) : null,
      meta.date || todayISO(),
    ].filter(Boolean);
    return parts.join("_");
  }

  async function buildPdf(options = {}) {
    const photoPaths = options.photoPaths instanceof Map ? options.photoPaths : null;
    const layout = options.layout === "tag" ? "tag" : "group";
    if (!window.jspdf || !window.jspdf.jsPDF) {
      throw new Error("PDF library failed to load.");
    }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: "pt", format: "a4", compress: true });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const margin = 40;
    const meta = state.property.meta;

    // For the PDF we treat layout == "group" (the default) as one section per
    // real group, and layout == "tag" as one virtual section per building
    // tag that actually has photos. Each entry in the section carries the
    // source photo plus (in tag mode) a subtitle pointing back at the
    // original group, e.g. "1. Walls — Rear elevation".
    let groupsWithPhotos;
    if (layout === "tag") {
      const buckets = new Map();
      for (const t of BUILDING_TAGS) buckets.set(t, []);
      for (const g of state.property.groups) {
        for (const pid of g.photoIds) {
          const photo = state.photos.get(pid);
          if (!photo) continue;
          buckets.get(photoBuildingOf(photo)).push({ photo, source: g });
        }
      }
      groupsWithPhotos = [];
      for (const tag of BUILDING_TAGS) {
        const entries = buckets.get(tag);
        if (!entries.length) continue;
        groupsWithPhotos.push({
          id: tagGroupId(tag),
          name: tag,
          photoIds: entries.map((e) => e.photo.id),
          virtual: true,
          entries,
        });
      }
    } else {
      groupsWithPhotos = state.property.groups.filter((g) => g.photoIds.length > 0);
    }

    // Cover page (page 1)
    doc.setFont("helvetica", "bold");
    doc.setFontSize(22);
    doc.text("Photo Evidence Report", margin, margin + 10);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    let y = margin + 44;
    const lines = [
      ["Property", state.property.name || "—"],
      ["Assessor", meta.assessor || "—"],
      ["Address", meta.address || "—"],
      ["Job ref", meta.ref || "—"],
      ["Date", meta.date || "—"],
      ["Generated", new Date().toLocaleString()],
    ];
    for (const [k, v] of lines) {
      doc.setFont("helvetica", "bold");
      doc.text(`${k}:`, margin, y);
      doc.setFont("helvetica", "normal");
      doc.text(String(v), margin + 80, y);
      y += 18;
    }

    // Reserve contents page (page 2) — heading only; we'll fill the list at the end.
    doc.addPage();
    const contentsPageNumber = doc.internal.getNumberOfPages();
    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    doc.text("Contents", margin, margin + 6);
    doc.setDrawColor(11, 61, 46);
    doc.setLineWidth(1.2);
    doc.line(margin, margin + 12, pageW - margin, margin + 12);
    doc.setLineWidth(0.2);

    // Bookmarks / outline (always clickable in a viewer's sidebar, even when
    // inline annotation links are not honoured).
    const addOutline = (label, pageNumber) => {
      try {
        if (doc.outline && typeof doc.outline.add === "function") {
          doc.outline.add(null, label, { pageNumber });
        }
      } catch (_) {
        /* outline plugin unavailable */
      }
    };
    addOutline("Cover", 1);
    addOutline("Contents", contentsPageNumber);

    const groupStartPages = new Map();

    for (const g of groupsWithPhotos) {
      doc.addPage();
      const startPage = doc.internal.getNumberOfPages();
      groupStartPages.set(g.id, startPage);
      const displayName = g.name;
      addOutline(displayName, startPage);

      doc.setFont("helvetica", "bold");
      doc.setFontSize(16);
      doc.text(displayName, margin, margin + 6);
      doc.setDrawColor(11, 61, 46);
      doc.setLineWidth(1.2);
      doc.line(margin, margin + 12, pageW - margin, margin + 12);
      doc.setLineWidth(0.2);

      // In tag layout, iterate the prebuilt entries (so we can see the source
      // group) instead of plain photoIds.
      const iterator = g.virtual
        ? g.entries.map((e) => ({ photo: e.photo, source: e.source }))
        : g.photoIds.map((pid) => ({ photo: state.photos.get(pid), source: g }));

      let cursorY = margin + 32;
      let index = 0;
      for (const entry of iterator) {
        const photo = entry.photo;
        const sourceGroup = entry.source;
        if (!photo) continue;
        index += 1;
        const isUpload = photo.source === "upload";
        const building = BUILDING_TAGS.includes(photo.building) ? photo.building : DEFAULT_BUILDING;
        // In group layout, prefix non-Main tags. In tag layout, prefix with
        // the source group name so the reader knows which group it came from.
        const prefix = layout === "tag"
          ? `${sourceGroup.name} — `
          : building !== DEFAULT_BUILDING
            ? `[${building}] `
            : "";
        const labelText = `${index}. ${prefix}${photo.label || sourceGroup.name}`;
        // Captions: single line for camera captures, a 3-line stack for
        // uploaded photos so Captured / Location / Uploaded each get their own line.
        const capH = isUpload ? 58 : 16;
        const maxImgW = pageW - margin * 2;
        const maxImgH = pageH - cursorY - margin - capH - 10;

        const ratio = photo.width / photo.height;
        let drawW = maxImgW;
        let drawH = drawW / ratio;
        if (drawH > maxImgH) {
          drawH = maxImgH;
          drawW = drawH * ratio;
        }

        if (drawH < 120) {
          doc.addPage();
          doc.setFont("helvetica", "bold");
          doc.setFontSize(12);
          doc.text(`${displayName} (cont.)`, margin, margin - 8);
          cursorY = margin;
          drawW = maxImgW;
          drawH = drawW / ratio;
          const avail = pageH - cursorY - margin - capH - 10;
          if (drawH > avail) {
            drawH = avail;
            drawW = drawH * ratio;
          }
        }

        const x = margin + (maxImgW - drawW) / 2;
        try {
          // Re-encode to a smaller / lower-quality JPEG just for PDF
          // embedding so the report stays compact, while the stored image
          // we use for ZIP / share exports keeps full fidelity.
          const pdfDataUrl = await reencodeForPdf(photo.dataUrl);
          doc.addImage(pdfDataUrl, "JPEG", x, cursorY, drawW, drawH, undefined, "FAST");
          // When built as part of a ZIP export, link the embedded image to
          // the corresponding full-resolution JPEG sitting alongside the PDF
          // in the archive. Tapping the photo in a PDF viewer opens the file
          // directly. Ignored silently by viewers that don't support it.
          if (photoPaths && photoPaths.has(photo.id)) {
            doc.link(x, cursorY, drawW, drawH, { url: photoPaths.get(photo.id) });
          }
        } catch (err) {
          console.error("addImage failed", err);
          continue;
        }

        doc.setFont("helvetica", "normal");
        doc.setFontSize(10);
        doc.setTextColor(40);
        doc.text(labelText, margin, cursorY + drawH + 14);

        if (isUpload) {
          doc.setFontSize(9);
          doc.setTextColor(110);
          const fmt = (iso) => (iso ? new Date(iso).toLocaleString() : "not in photo metadata");
          const uploadLines = [
            `Date taken: ${fmt(photo.takenAt)}`,
            `Location taken: ${photo.gps ? formatGps(photo.gps) : "not in photo metadata"}`,
            `Uploaded: ${fmt(photo.uploadedAt)}`,
          ];
          let infoY = cursorY + drawH + 28;
          for (const line of uploadLines) {
            doc.text(line, margin, infoY);
            infoY += 12;
          }
          doc.setFontSize(10);
        } else {
          const stampLine = [];
          if (photo.takenAt) stampLine.push(new Date(photo.takenAt).toLocaleString());
          if (photo.gps) stampLine.push(formatGps(photo.gps));
          if (stampLine.length) {
            doc.setTextColor(110);
            doc.text(stampLine.join("   ·   "), pageW - margin, cursorY + drawH + 14, { align: "right" });
          }
        }
        doc.setTextColor(0);

        cursorY += drawH + capH + 18;

        const isLast = entry === iterator[iterator.length - 1];
        if (!isLast && cursorY + 180 > pageH - margin) {
          doc.addPage();
          doc.setFont("helvetica", "bold");
          doc.setFontSize(12);
          doc.text(`${displayName} (cont.)`, margin, margin - 8);
          cursorY = margin;
        }
      }
    }

    // Fill in the contents page (clickable links)
    doc.setPage(contentsPageNumber);
    let cy = margin + 36;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(12);
    const colRight = pageW - margin;
    const LINK_R = 22;
    const LINK_G = 82;
    const LINK_B = 178;

    if (!groupsWithPhotos.length) {
      doc.setTextColor(120);
      doc.text("No photos in this report.", margin, cy);
      doc.setTextColor(0);
    }

    doc.setTextColor(120);
    doc.setFontSize(9);
    doc.text(
      "Tap a section title to jump to that page. Bookmarks are also available in your PDF viewer's sidebar.",
      margin,
      cy
    );
    doc.setFontSize(12);
    doc.setTextColor(0);
    cy += 18;

    let total = 0;
    const ROW_HEIGHT = 26;
    for (const g of groupsWithPhotos) {
      const target = groupStartPages.get(g.id);
      const title = g.name;
      const countText = `${g.photoIds.length} photo${g.photoIds.length === 1 ? "" : "s"}`;
      const pageText = `p. ${target}`;
      total += g.photoIds.length;

      const rowLeft = margin;
      const titleW = doc.getTextWidth(title);
      const pageW_text = doc.getTextWidth(pageText);
      const countW = doc.getTextWidth(countText);

      // Title in blue, underlined
      doc.setTextColor(LINK_R, LINK_G, LINK_B);
      doc.text(title, rowLeft, cy);
      doc.setDrawColor(LINK_R, LINK_G, LINK_B);
      doc.setLineWidth(0.6);
      doc.line(rowLeft, cy + 2, rowLeft + titleW, cy + 2);

      // Right-aligned page number in blue, underlined
      const pageX = colRight - pageW_text;
      doc.text(pageText, pageX, cy);
      doc.line(pageX, cy + 2, colRight, cy + 2);

      // Count, muted grey, sits left of the page number
      doc.setTextColor(110);
      const countRightX = pageX - 10;
      doc.text(countText, countRightX, cy, { align: "right" });

      // Dotted leader between title and count
      const dotsStartX = rowLeft + titleW + 8;
      const dotsEndX = countRightX - countW - 8;
      if (dotsEndX > dotsStartX) {
        doc.setTextColor(170);
        doc.setFontSize(10);
        const dotStr = " .".repeat(Math.max(1, Math.floor((dotsEndX - dotsStartX) / 3)));
        doc.text(dotStr, dotsStartX, cy);
        doc.setFontSize(12);
      }

      // ONE generous clickable rectangle covering the whole row.
      doc.link(rowLeft - 4, cy - 14, colRight - rowLeft + 8, ROW_HEIGHT, {
        pageNumber: target,
      });

      doc.setLineWidth(0.2);
      doc.setTextColor(0);
      doc.setDrawColor(0);
      cy += ROW_HEIGHT;
      if (cy > pageH - margin - 40) break;
    }

    if (groupsWithPhotos.length) {
      doc.setDrawColor(210);
      doc.line(margin, cy + 2, pageW - margin, cy + 2);
      cy += 20;
      doc.setFont("helvetica", "bold");
      doc.text(`Total photos: ${total}`, margin, cy);
    }

    // Footer page numbers
    const pageCount = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
      doc.setPage(i);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.setTextColor(130);
      doc.text(`Page ${i} of ${pageCount}`, pageW - margin, pageH - 18, { align: "right" });
      if (meta.ref) doc.text(meta.ref, margin, pageH - 18);
      doc.setTextColor(0);
    }

    return { doc, filename: `${reportBaseName()}.pdf` };
  }

  async function exportPdf(opts) {
    const layout = (opts && opts.layout) || "group";
    try {
      const { doc, filename } = await buildPdf({ layout });
      doc.save(filename);
      toast(`PDF saved (${layout === "tag" ? "by tag" : "by group"}).`);
    } catch (err) {
      console.error(err);
      toast(err.message || "Failed to build PDF.", "err");
    }
  }

  function openPdfLayoutDialog() {
    els.pdfLayoutDialog.hidden = false;
    els.pdfLayoutDialog.setAttribute("aria-hidden", "false");
  }
  function closePdfLayoutDialog() {
    els.pdfLayoutDialog.hidden = true;
    els.pdfLayoutDialog.setAttribute("aria-hidden", "true");
  }


  // -------------------- Export photos (share or photos-only ZIP) --------------------
  function photoExportItems() {
    const items = [];
    for (const g of state.property.groups) {
      if (!g.photoIds.length) continue;
      let index = 0;
      for (const pid of g.photoIds) {
        const photo = state.photos.get(pid);
        if (!photo) continue;
        index += 1;
        const dataUrl =
          photo.source === "upload" ? photo.dataUrl : buildExifDataUrl(photo);
        const bytes = dataUrlToBytes(dataUrl);
        const stamp = photo.takenAt || photo.uploadedAt || new Date().toISOString();
        items.push({ photo, group: g, index, bytes, stamp });
      }
    }
    return items;
  }

  function photosSupportShare(files) {
    try {
      return (
        typeof navigator !== "undefined" &&
        typeof navigator.canShare === "function" &&
        typeof navigator.share === "function" &&
        typeof File === "function" &&
        files.length > 0 &&
        navigator.canShare({ files })
      );
    } catch (_) {
      return false;
    }
  }

  function openExportPhotosDialog() {
    els.exportPhotosDialog.hidden = false;
    els.exportPhotosDialog.setAttribute("aria-hidden", "false");
    // Adjust the share button to reflect support so users aren't misled.
    const probeFile = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], "probe.jpg", {
      type: "image/jpeg",
    });
    const canShare =
      typeof navigator !== "undefined" &&
      typeof navigator.canShare === "function" &&
      navigator.canShare({ files: [probeFile] });
    els.exportPhotosShareBtn.disabled = !canShare;
    els.exportPhotosShareBtn.title = canShare
      ? ""
      : "Your browser can't share files — try the ZIP option.";
    if (!canShare) {
      els.exportPhotosHelp.innerHTML =
        "Your browser doesn't support sharing files to Photos. <strong>Download ZIP</strong> saves a single archive of all photos, grouped into folders.";
    }
  }

  function closeExportPhotosDialog() {
    els.exportPhotosDialog.hidden = true;
    els.exportPhotosDialog.setAttribute("aria-hidden", "true");
  }

  function exportPhotosShareNow() {
    // Called synchronously from a user click so navigator.share retains its
    // user-gesture credit on iOS / Android.
    const items = photoExportItems();
    if (!items.length) {
      toast("No photos to export.", "err");
      return;
    }
    const files = items.map(({ photo, group, index, bytes, stamp }) => {
      const d = new Date(stamp);
      const pad = (n) => String(n).padStart(2, "0");
      const dateStr =
        `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_` +
        `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
      const filename = `${slugify(group.name)}_${dateStr}_${String(index).padStart(2, "0")}.jpg`;
      return new File([new Blob([bytes], { type: "image/jpeg" })], filename, {
        type: "image/jpeg",
        lastModified: d.getTime(),
      });
    });
    if (!photosSupportShare(files)) {
      toast("This browser can't share these files — try Download ZIP.", "err");
      return;
    }
    const payload = {
      files,
      title: `${state.property.name || "Property"} — Photo evidence`,
      text: "Photo evidence",
    };
    navigator
      .share(payload)
      .then(() => {
        toast("Shared — tap Save Image / Save to Gallery in the sheet to back up.");
      })
      .catch((err) => {
        if (err && err.name !== "AbortError") {
          console.warn("Share failed", err);
          toast("Share failed — use Download ZIP instead.", "err");
        }
      });
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[c]);
  }

  function buildHtmlIndex(photoPaths, opts) {
    const options = opts || {};
    const layout = options.layout === "tag" ? "tag" : "group";
    const otherHref = options.otherHref || null;
    const otherLabel = options.otherLabel || null;

    const meta = state.property.meta || {};
    const fmtIso = (iso) => (iso ? new Date(iso).toLocaleString() : "not in photo metadata");

    // Build sections list. For layout == "group" each real group is a section.
    // For layout == "tag" each non-empty building tag is a section whose
    // photo entries carry their source group for the sub-title.
    let sections;
    if (layout === "tag") {
      const buckets = new Map();
      for (const t of BUILDING_TAGS) buckets.set(t, []);
      for (const g of state.property.groups) {
        for (const pid of g.photoIds) {
          const photo = state.photos.get(pid);
          if (!photo) continue;
          buckets.get(photoBuildingOf(photo)).push({ photo, source: g });
        }
      }
      sections = [];
      for (const tag of BUILDING_TAGS) {
        const entries = buckets.get(tag);
        if (!entries.length) continue;
        sections.push({
          id: `tag-${tag}`,
          name: tag,
          entries,
        });
      }
    } else {
      sections = state.property.groups
        .filter((g) => g.photoIds.length > 0)
        .map((g) => ({
          id: g.id,
          name: g.name,
          entries: g.photoIds
            .map((pid) => {
              const photo = state.photos.get(pid);
              return photo ? { photo, source: g } : null;
            })
            .filter(Boolean),
        }));
    }

    // Contents list.
    let totalPhotos = 0;
    let tocHtml = "<ul>";
    for (const s of sections) {
      const n = s.entries.length;
      totalPhotos += n;
      tocHtml += `<li><a href="#g-${escapeHtml(s.id)}">${escapeHtml(s.name)}</a> <span class="count">${n} photo${n === 1 ? "" : "s"}</span></li>`;
    }
    tocHtml += "</ul>";

    // Section bodies with photo figures.
    let sectionsHtml = "";
    for (const s of sections) {
      sectionsHtml += `<section id="g-${escapeHtml(s.id)}" class="group"><h2>${escapeHtml(s.name)}</h2><div class="photos">`;
      let index = 0;
      for (const { photo, source } of s.entries) {
        index += 1;
        const path = photoPaths.get(photo.id) || "";
        const building = photoBuildingOf(photo);
        const hrefEsc = escapeHtml(path);
        // Label: in tag layout prefix the source group, in group layout use the photo label.
        const baseLabel = layout === "tag"
          ? `${source.name} — ${photo.label || ""}`.trim().replace(/— $/, "")
          : (photo.label || source.name);
        const label = `${index}. ${baseLabel}`;
        const labelEsc = escapeHtml(label);
        const tagClass = building === DEFAULT_BUILDING ? "tag tag-main" : "tag tag-ext";
        sectionsHtml += `<figure>`;
        sectionsHtml += `<a href="${hrefEsc}" target="_blank" rel="noopener"><img src="${hrefEsc}" alt="${labelEsc}" loading="lazy"></a>`;
        sectionsHtml += `<figcaption><div class="label"><span class="${tagClass}">${escapeHtml(building)}</span> ${labelEsc}</div>`;
        if (photo.source === "upload") {
          sectionsHtml += `<div class="meta-line">Date taken: ${escapeHtml(fmtIso(photo.takenAt))}</div>`;
          sectionsHtml += `<div class="meta-line">Location taken: ${escapeHtml(photo.gps ? formatGps(photo.gps) : "not in photo metadata")}</div>`;
          sectionsHtml += `<div class="meta-line">Uploaded: ${escapeHtml(fmtIso(photo.uploadedAt))}</div>`;
        } else {
          const parts = [];
          if (photo.takenAt) parts.push(new Date(photo.takenAt).toLocaleString());
          if (photo.gps) parts.push(formatGps(photo.gps));
          if (parts.length) sectionsHtml += `<div class="meta-line">${escapeHtml(parts.join("  ·  "))}</div>`;
        }
        sectionsHtml += `<a class="open-link" href="${hrefEsc}" target="_blank" rel="noopener">Open photo →</a>`;
        sectionsHtml += `</figcaption></figure>`;
      }
      sectionsHtml += `</div></section>`;
    }

    // Top-of-page link to the sibling layout.
    const switchHtml = otherHref
      ? `<p class="layout-switch">Layout: <strong>${layout === "tag" ? "by tag" : "by group"}</strong> · <a href="${escapeHtml(otherHref)}">Switch to ${escapeHtml(otherLabel || "other layout")}</a></p>`
      : "";

    const css = `
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#f4f5f4;color:#13241d;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;font-size:15px;line-height:1.45}
.wrap{max-width:980px;margin:0 auto;padding:16px}
header.cover{background:#0b3d2e;color:#fff;padding:18px 20px;border-radius:12px;margin-bottom:16px;box-shadow:0 2px 10px rgba(0,0,0,0.05)}
header.cover h1{margin:0 0 8px;font-size:1.35rem}
.layout-switch{background:#fff;border:1px solid #dde3e0;border-radius:10px;padding:10px 14px;margin:0 0 16px;font-size:0.88rem;color:#5b6b65}
.layout-switch strong{color:#13241d;margin:0 4px}
.layout-switch a{color:#1652b2;text-decoration:underline}
.cover dl{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;margin:6px 0 0;font-size:0.9rem}
.cover dt{font-weight:600;opacity:0.85}
.cover dd{margin:0}
.toc,section.group{background:#fff;border:1px solid #dde3e0;border-radius:12px;padding:16px;margin-bottom:16px;box-shadow:0 1px 2px rgba(0,0,0,0.04)}
.toc h2,section.group h2{margin:0 0 10px;font-size:1.1rem}
.toc ul{list-style:none;padding:0;margin:0}
.toc li{padding:3px 0}
.toc .toc-section{font-weight:700;margin-top:6px}
.toc .toc-section-name{display:inline-block;margin-bottom:4px}
.toc .toc-section > ul{margin:4px 0 6px;padding-left:14px;font-weight:normal}
.toc a{color:#1652b2;text-decoration:underline}
.toc .count{color:#5b6b65;font-size:0.85rem;margin-left:6px}
.total{margin:10px 0 0;font-weight:700;font-size:0.95rem;color:#0b3d2e}
.photos{display:grid;grid-template-columns:1fr;gap:16px}
@media (min-width:720px){.photos{grid-template-columns:1fr 1fr}}
figure{margin:0;border:1px solid #eef3f0;border-radius:10px;overflow:hidden;background:#fff;display:flex;flex-direction:column}
figure img{display:block;width:100%;height:auto;background:#000}
figcaption{padding:10px 12px;font-size:0.88rem}
.label{font-weight:600;margin-bottom:4px}
.tag{display:inline-block;font-size:0.7rem;font-weight:700;padding:1px 6px;border-radius:999px;margin-right:6px;vertical-align:middle;letter-spacing:0.3px}
.tag-main{background:#eef5ef;color:#0b3d2e}
.tag-ext{background:#fff2d6;color:#7a5200}
.meta-line{color:#5b6b65;font-size:0.82rem;margin:2px 0}
.open-link{display:inline-block;margin-top:6px;color:#1652b2;text-decoration:underline;font-size:0.82rem}
`;

    const title = state.property.name || meta.address || "Photo Evidence";
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — Photo Evidence</title>
<style>${css}</style>
</head>
<body>
<div class="wrap">
<header class="cover">
<h1>${escapeHtml(title)}</h1>
<dl>
<dt>Assessor</dt><dd>${escapeHtml(meta.assessor || "—")}</dd>
<dt>Property</dt><dd>${escapeHtml(meta.address || "—")}</dd>
<dt>Job ref</dt><dd>${escapeHtml(meta.ref || "—")}</dd>
<dt>Date</dt><dd>${escapeHtml(meta.date || "—")}</dd>
<dt>Generated</dt><dd>${escapeHtml(new Date().toLocaleString())}</dd>
</dl>
</header>
${switchHtml}
<nav class="toc"><h2>Contents</h2>${tocHtml}<p class="total">Total photos: ${totalPhotos}</p></nav>
<main>${sectionsHtml}</main>
</div>
</body>
</html>`;
  }

  async function exportPhotosAsZip() {
    if (typeof JSZip === "undefined") {
      toast("ZIP library failed to load.", "err");
      return;
    }
    const items = photoExportItems();
    if (!items.length) {
      toast("No photos to export.", "err");
      return;
    }
    try {
      toast("Building photos ZIP…");
      const zip = new JSZip();

      // First pass: drop every photo into its folder and record the
      // archive-relative path so the PDF and HTML index can link back to it.
      const dirForGroup = new Map(); // group.id -> dir
      const dirTaken = new Map(); // dir -> count
      const photoPaths = new Map(); // photo.id -> "dir/name.jpg"
      for (const { photo, group, index, bytes, stamp } of items) {
        let dir = dirForGroup.get(group.id);
        if (!dir) {
          dir = slugify(group.name);
          const n = (dirTaken.get(dir) || 0) + 1;
          dirTaken.set(dir, n);
          if (n > 1) dir = `${dir}-${n}`;
          dirForGroup.set(group.id, dir);
        }
        const folder = zip.folder(dir);
        const labelSlug = slugify(photo.label || `${group.name}-${index}`);
        const name = `${String(index).padStart(2, "0")}_${labelSlug}.jpg`;
        folder.file(name, bytes, { date: new Date(stamp) });
        photoPaths.set(photo.id, `${dir}/${name}`);
      }

      // Ship two PDFs (one per layout) and two HTML indices so the user
      // can pick whichever is more useful after extraction.
      try {
        const { doc, filename: pdfName } = await buildPdf({ photoPaths, layout: "group" });
        zip.file(pdfName.replace(/\.pdf$/, "_by-group.pdf"), doc.output("blob"));
      } catch (err) {
        console.warn("Group-layout PDF failed", err);
      }
      try {
        const { doc, filename: pdfName } = await buildPdf({ photoPaths, layout: "tag" });
        zip.file(pdfName.replace(/\.pdf$/, "_by-tag.pdf"), doc.output("blob"));
      } catch (err) {
        console.warn("Tag-layout PDF failed", err);
      }

      // Lightweight HTML indices referencing the same photo files by
      // relative path. Two layouts; each cross-links to the other.
      try {
        zip.file(
          "index.html",
          buildHtmlIndex(photoPaths, {
            layout: "group",
            otherHref: "index-by-tag.html",
            otherLabel: "by tag (Main / Ext1–4)",
          })
        );
        zip.file(
          "index-by-tag.html",
          buildHtmlIndex(photoPaths, {
            layout: "tag",
            otherHref: "index.html",
            otherLabel: "by group",
          })
        );
      } catch (err) {
        console.warn("HTML index generation failed.", err);
      }

      const zipBlob = await zip.generateAsync({ type: "blob", compression: "STORE" });
      saveBlob(zipBlob, `${reportBaseName()}_photos.zip`);
      toast("Photos ZIP saved.");
    } catch (err) {
      console.error(err);
      toast(err.message || "Failed to build photos ZIP.", "err");
    }
  }

  // -------------------- Wiring --------------------
  function wireMetaInputs() {
    const nameHandler = () => {
      state.property.name = els.metaName.value.trim() || "Untitled property";
      saveProperty();
    };
    els.metaName.addEventListener("input", nameHandler);
    const handler = () => {
      state.property.meta.assessor = els.metaAssessor.value.trim();
      state.property.meta.address = els.metaAddress.value.trim();
      state.property.meta.ref = els.metaRef.value.trim();
      state.property.meta.date = els.metaDate.value;
      saveProperty();
    };
    els.metaAssessor.addEventListener("input", handler);
    els.metaAddress.addEventListener("input", handler);
    els.metaRef.addEventListener("input", handler);
    els.metaDate.addEventListener("change", handler);
  }

  els.gpsBtn.addEventListener("click", enableGps);

  els.addGroupBtn.addEventListener("click", () => {
    if (!state.property) return;
    const typed = els.addGroupName.value.trim();
    const name = typed || `Group ${state.property.groups.length + 1}`;
    try {
      addGroup(name);
      els.addGroupName.value = "";
      const el = els.groups.lastElementChild;
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        const title = el.querySelector(".group-title");
        if (!typed && title) {
          title.focus();
          const range = document.createRange();
          range.selectNodeContents(title);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }
    } catch (err) {
      console.error(err);
      toast("Couldn't add group.", "err");
    }
  });
  els.addGroupName.addEventListener("keydown", (e) => {
    if (e.key === "Enter") els.addGroupBtn.click();
  });

  for (const btn of els.viewToggleBtns) {
    btn.addEventListener("click", () => setView(btn.dataset.view));
  }

  els.exportBtn.addEventListener("click", () => {
    if (els.exportBtn.disabled) return;
    openPdfLayoutDialog();
  });

  els.pdfLayoutCancelBtn.addEventListener("click", closePdfLayoutDialog);
  els.pdfLayoutBackdrop.addEventListener("click", closePdfLayoutDialog);
  els.pdfLayoutGroupBtn.addEventListener("click", () => {
    closePdfLayoutDialog();
    exportPdf({ layout: "group" });
  });
  els.pdfLayoutTagBtn.addEventListener("click", () => {
    closePdfLayoutDialog();
    exportPdf({ layout: "tag" });
  });
  document.addEventListener("keydown", (e) => {
    if (!els.pdfLayoutDialog.hidden && e.key === "Escape") {
      e.preventDefault();
      closePdfLayoutDialog();
    }
  });

  els.exportPhotosBtn.addEventListener("click", () => {
    if (els.exportPhotosBtn.disabled) return;
    openExportPhotosDialog();
  });
  els.exportPhotosCancelBtn.addEventListener("click", closeExportPhotosDialog);
  els.exportPhotosBackdrop.addEventListener("click", closeExportPhotosDialog);
  els.exportPhotosShareBtn.addEventListener("click", () => {
    // Keep synchronous up to navigator.share() so iOS grants the gesture.
    closeExportPhotosDialog();
    exportPhotosShareNow();
  });
  els.exportPhotosZipBtn.addEventListener("click", () => {
    closeExportPhotosDialog();
    exportPhotosAsZip();
  });
  document.addEventListener("keydown", (e) => {
    if (!els.exportPhotosDialog.hidden && e.key === "Escape") {
      e.preventDefault();
      closeExportPhotosDialog();
    }
  });

  els.propSelect.addEventListener("change", () => {
    const id = els.propSelect.value;
    if (id && id !== state.currentId) switchProperty(id);
  });

  els.newPropBtn.addEventListener("click", async () => {
    const name = prompt("Name for the new property (e.g. address or reference):", "");
    if (name === null) return;
    await createProperty(name.trim() || null);
    toast("New property created.");
  });

  els.delPropBtn.addEventListener("click", () => {
    deleteCurrentProperty().catch((err) => {
      console.error(err);
      toast("Failed to delete property.", "err");
    });
  });

  // Flush pending save if the user closes the tab mid-debounce
  window.addEventListener("beforeunload", () => {
    if (state.property) {
      try {
        IDB.putProperty(state.property);
      } catch (_) {
        /* noop */
      }
    }
  });

  wireMetaInputs();

  // -------------------- Boot --------------------
  async function autoRequestGps() {
    if (!("geolocation" in navigator)) {
      setGpsStatus("err", "No GPS support");
      return;
    }
    let state_perm = null;
    if (navigator.permissions && navigator.permissions.query) {
      try {
        const res = await navigator.permissions.query({ name: "geolocation" });
        state_perm = res.state;
      } catch (_) {
        /* ignore */
      }
    }
    if (state_perm === "denied") {
      setGpsStatus("err", "GPS blocked");
      alert(
        "Location is currently blocked for this site.\n\n" +
          "Photos won't carry a GPS stamp until you allow location in your browser settings and tap Enable GPS in the header."
      );
      return;
    }
    if (state_perm !== "granted") {
      alert(
        "Photo Evidence uses your device GPS to stamp each photo with a location.\n\n" +
          "When prompted by the browser, choose Allow. You can change this any time from the Enable GPS button in the header."
      );
    }
    enableGps();
  }

  (async function boot() {
    try {
      const list = await IDB.listProperties();
      list.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
      state.properties = list.map((p) => ({ id: p.id, name: p.name }));

      if (!list.length) {
        await createProperty("Property 1");
      } else {
        const savedId = localStorage.getItem(ACTIVE_KEY);
        const chosen = list.find((p) => p.id === savedId) || list[0];
        await switchProperty(chosen.id);
      }
    } catch (err) {
      console.error(err);
      toast("Couldn't load saved data — starting fresh.", "err");
      state.property = makeNewProperty("Property 1");
      state.properties = [{ id: state.property.id, name: state.property.name }];
      state.currentId = state.property.id;
      initExpandedForProperty();
      renderMeta();
      renderGroups();
      renderPropertySelect();
    }
    autoRequestGps();
  })();
})();
