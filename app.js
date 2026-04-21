(() => {
  "use strict";

  const DB_NAME = "photo-evidence";
  const DB_VERSION = 1;
  const STORE_PROPERTIES = "properties";
  const STORE_PHOTOS = "photos";
  const ACTIVE_KEY = "photo-evidence:active-property";

  const DEFAULT_GROUPS = [{ name: "External Elevations" }];
  const MAX_DIMENSION = 2000;
  const JPEG_QUALITY = 0.88;

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
      dataUrl,
      width: w,
      height: h,
      takenAt: stampDate.toISOString(),
      gps: state.gps ? { ...state.gps } : null,
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
      groups: DEFAULT_GROUPS.map((g) => ({
        id: uid("g"),
        name: g.name,
        photoIds: [],
      })),
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
  function renderGroups() {
    els.groups.innerHTML = "";
    for (const group of state.property.groups) renderGroup(group);
  }

  function renderGroup(group) {
    const node = els.groupTpl.content.firstElementChild.cloneNode(true);
    node.dataset.groupId = group.id;

    const title = node.querySelector(".group-title");
    title.textContent = group.name;
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

    const galleryInput = node.querySelector(".file-input-gallery");
    galleryInput.addEventListener("change", async (e) => {
      const files = Array.from(e.target.files || []);
      galleryInput.value = "";
      if (files.length) await addPhotos(group, files);
    });
    const cameraInput = node.querySelector(".file-input-camera");
    cameraInput.addEventListener("change", async (e) => {
      const files = Array.from(e.target.files || []);
      cameraInput.value = "";
      if (files.length) await addPhotos(group, files);
    });

    node.querySelector(".btn-remove-group").addEventListener("click", () => removeGroup(group.id));

    els.groups.appendChild(node);
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

  function renderThumb(group, photo) {
    const thumbsEl = els.groups.querySelector(`[data-group-id="${group.id}"] .thumbs`);
    if (!thumbsEl) return;
    const node = els.thumbTpl.content.firstElementChild.cloneNode(true);
    node.dataset.photoId = photo.id;
    const img = node.querySelector("img");
    img.src = photo.dataUrl;
    img.alt = photo.label;
    const labelInput = node.querySelector(".thumb-label");
    labelInput.value = photo.label || "";

    const saveLabel = debounce(() => savePhotoNow(photo), 500);
    labelInput.addEventListener("input", () => {
      photo.label = labelInput.value;
      saveLabel();
      saveProperty();
    });

    node.querySelector(".thumb-remove").addEventListener("click", async () => {
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
    });

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
      const newOrder = Array.from(thumbsEl.querySelectorAll(".thumb")).map((el) => el.dataset.photoId);
      group.photoIds = newOrder.slice();
      saveProperty();
    });

    thumbsEl.appendChild(node);
  }

  async function addPhotos(group, files) {
    const imageFiles = files.filter((f) => f.type.startsWith("image/"));
    if (!imageFiles.length) {
      toast("Please select image files.", "err");
      return;
    }
    if (!state.gps) toast("Tip: enable GPS for geolocation stamps.");
    toast(`Processing ${imageFiles.length} photo${imageFiles.length === 1 ? "" : "s"}…`);

    for (const file of imageFiles) {
      try {
        const photo = await processFile(file);
        photo.propertyId = state.property.id;
        photo.label = `${group.name} — ${group.photoIds.length + 1}`;
        state.photos.set(photo.id, photo);
        group.photoIds.push(photo.id);
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
  }

  function addGroup(name) {
    const group = { id: uid("g"), name: name || "Untitled group", photoIds: [] };
    state.property.groups.push(group);
    renderGroup(group);
    updateExportButton();
    saveProperty();
  }

  function removeGroup(groupId) {
    const idx = state.property.groups.findIndex((g) => g.id === groupId);
    if (idx === -1) return;
    const group = state.property.groups[idx];
    if (group.photoIds.length) {
      if (!confirm(`Remove "${group.name}" and its ${group.photoIds.length} photo(s)?`)) return;
    }
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
    if (!state.property) {
      els.exportBtn.disabled = true;
      return;
    }
    const anyPhotos = state.property.groups.some((g) => g.photoIds.length > 0);
    els.exportBtn.disabled = !anyPhotos;
  }

  // -------------------- PDF export with linked contents --------------------
  async function exportPdf() {
    if (!window.jspdf || !window.jspdf.jsPDF) {
      toast("PDF library failed to load.", "err");
      return;
    }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: "pt", format: "a4", compress: true });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const margin = 40;
    const meta = state.property.meta;
    const groupsWithPhotos = state.property.groups.filter((g) => g.photoIds.length > 0);

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

    const groupStartPages = new Map();

    for (const g of groupsWithPhotos) {
      doc.addPage();
      groupStartPages.set(g.id, doc.internal.getNumberOfPages());

      doc.setFont("helvetica", "bold");
      doc.setFontSize(16);
      doc.text(g.name, margin, margin + 6);
      doc.setDrawColor(11, 61, 46);
      doc.setLineWidth(1.2);
      doc.line(margin, margin + 12, pageW - margin, margin + 12);
      doc.setLineWidth(0.2);

      let cursorY = margin + 32;
      let index = 0;
      for (const pid of g.photoIds) {
        const photo = state.photos.get(pid);
        if (!photo) continue;
        index += 1;
        const labelText = `${index}. ${photo.label || g.name}`;
        const capH = 16;
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
          doc.text(`${g.name} (cont.)`, margin, margin - 8);
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
          doc.addImage(photo.dataUrl, "JPEG", x, cursorY, drawW, drawH, undefined, "FAST");
        } catch (err) {
          console.error("addImage failed", err);
          continue;
        }

        doc.setFont("helvetica", "normal");
        doc.setFontSize(10);
        doc.setTextColor(40);
        doc.text(labelText, margin, cursorY + drawH + 14);

        const stampLine = [];
        if (photo.takenAt) stampLine.push(new Date(photo.takenAt).toLocaleString());
        if (photo.gps) stampLine.push(formatGps(photo.gps));
        if (stampLine.length) {
          doc.setTextColor(110);
          doc.text(stampLine.join("   ·   "), pageW - margin, cursorY + drawH + 14, { align: "right" });
        }
        doc.setTextColor(0);

        cursorY += drawH + capH + 18;

        const isLast = g.photoIds[g.photoIds.length - 1] === pid;
        if (!isLast && cursorY + 180 > pageH - margin) {
          doc.addPage();
          doc.setFont("helvetica", "bold");
          doc.setFontSize(12);
          doc.text(`${g.name} (cont.)`, margin, margin - 8);
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

    if (!groupsWithPhotos.length) {
      doc.setTextColor(120);
      doc.text("No photos in this report.", margin, cy);
      doc.setTextColor(0);
    }

    let total = 0;
    for (const g of groupsWithPhotos) {
      const target = groupStartPages.get(g.id);
      const title = g.name;
      const count = `${g.photoIds.length}`;
      total += g.photoIds.length;

      const textW = doc.getTextWidth(title);
      doc.setTextColor(11, 61, 46);
      doc.textWithLink(title, margin, cy, { pageNumber: target });
      doc.setTextColor(80);
      doc.text(count, colRight, cy, { align: "right" });

      // Dotted leader between title and page/count
      const dotsStartX = margin + textW + 8;
      const dotsEndX = colRight - doc.getTextWidth(count) - 8;
      if (dotsEndX > dotsStartX) {
        doc.setTextColor(160);
        doc.setFontSize(10);
        const dotStr = " .".repeat(Math.max(1, Math.floor((dotsEndX - dotsStartX) / 3)));
        doc.text(dotStr, dotsStartX, cy);
        doc.setFontSize(12);
      }

      // Make the entire line clickable
      doc.link(margin, cy - 12, colRight - margin, 18, { pageNumber: target });
      doc.setTextColor(0);
      cy += 20;
      if (cy > pageH - margin - 40) break; // one-page cap
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

    const nameParts = [
      "photo-evidence",
      slugify(state.property.name || "property"),
      meta.ref ? slugify(meta.ref) : null,
      meta.date || todayISO(),
    ].filter(Boolean);
    doc.save(`${nameParts.join("_")}.pdf`);
    toast("PDF saved.");
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
    const name = els.addGroupName.value.trim();
    if (!name) {
      toast("Enter a group name.", "err");
      return;
    }
    addGroup(name);
    els.addGroupName.value = "";
  });
  els.addGroupName.addEventListener("keydown", (e) => {
    if (e.key === "Enter") els.addGroupBtn.click();
  });

  els.exportBtn.addEventListener("click", () => {
    exportPdf().catch((err) => {
      console.error(err);
      toast("Failed to build PDF.", "err");
    });
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
  (async function boot() {
    try {
      const list = await IDB.listProperties();
      list.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
      state.properties = list.map((p) => ({ id: p.id, name: p.name }));

      if (!list.length) {
        await createProperty("Property 1");
        return;
      }
      const savedId = localStorage.getItem(ACTIVE_KEY);
      const chosen = list.find((p) => p.id === savedId) || list[0];
      await switchProperty(chosen.id);
    } catch (err) {
      console.error(err);
      toast("Couldn't load saved data — starting fresh.", "err");
      // Fall back to in-memory property so UI still works
      state.property = makeNewProperty("Property 1");
      state.properties = [{ id: state.property.id, name: state.property.name }];
      state.currentId = state.property.id;
      renderMeta();
      renderGroups();
      renderPropertySelect();
    }
  })();
})();
