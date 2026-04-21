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
  ];

  const BUILDING_SUBGROUPS = [
    { name: "Wall Thickness" },
    { name: "Roof" },
    { name: "Floor" },
  ];
  const MAIN_SECTION = "Main Property";
  const EXTENSION_PREFIX = "Extension ";
  const MAX_EXTENSIONS = 4;
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
    expanded: new Set(), // group ids currently expanded in the accordion
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
    exportZipBtn: document.getElementById("btn-export-zip"),
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
  function makeDefaultGroups() {
    const groups = DEFAULT_GROUPS.map((g) => ({
      id: uid("g"),
      name: g.name,
      photoIds: [],
      protected: true,
    }));
    for (const s of BUILDING_SUBGROUPS) {
      groups.push({
        id: uid("g"),
        name: s.name,
        section: MAIN_SECTION,
        photoIds: [],
        protected: true,
      });
    }
    return groups;
  }

  function makeSubgroupsForSection(section) {
    return BUILDING_SUBGROUPS.map((s) => ({
      id: uid("g"),
      name: s.name,
      section,
      photoIds: [],
      protected: true,
    }));
  }

  function migrateDefaults(property) {
    if (!property || !Array.isArray(property.groups)) return false;
    let changed = false;

    // Add any missing flat default groups.
    const existingFlat = new Set(
      property.groups
        .filter((g) => !g.section)
        .map((g) => (g.name || "").trim().toLowerCase())
    );
    for (const d of DEFAULT_GROUPS) {
      if (!existingFlat.has(d.name.toLowerCase())) {
        property.groups.push({
          id: uid("g"),
          name: d.name,
          photoIds: [],
          protected: true,
        });
        changed = true;
      }
    }

    // Ensure Main Property section has its three sub-groups.
    const mainSubgroups = property.groups.filter((g) => g.section === MAIN_SECTION);
    if (mainSubgroups.length === 0) {
      property.groups.push(...makeSubgroupsForSection(MAIN_SECTION));
      changed = true;
    } else {
      const names = new Set(mainSubgroups.map((g) => (g.name || "").toLowerCase()));
      for (const s of BUILDING_SUBGROUPS) {
        if (!names.has(s.name.toLowerCase())) {
          property.groups.push({
            id: uid("g"),
            name: s.name,
            section: MAIN_SECTION,
            photoIds: [],
            protected: true,
          });
          changed = true;
        }
      }
    }

    // Apply the protected flag to any group that matches a default name.
    const flatDefaultNames = new Set(DEFAULT_GROUPS.map((g) => g.name.toLowerCase()));
    const subDefaultNames = new Set(BUILDING_SUBGROUPS.map((g) => g.name.toLowerCase()));
    for (const group of property.groups) {
      if (group.protected) continue;
      const norm = (group.name || "").trim().toLowerCase();
      const isFlat = !group.section && flatDefaultNames.has(norm);
      const isSubgroup = group.section && subDefaultNames.has(norm);
      if (isFlat || isSubgroup) {
        group.protected = true;
        changed = true;
      }
    }

    return changed;
  }

  function extensionSections() {
    const found = new Set();
    for (const g of state.property.groups) {
      if (g.section && g.section.startsWith(EXTENSION_PREFIX)) found.add(g.section);
    }
    return Array.from(found).sort((a, b) => {
      const na = parseInt(a.slice(EXTENSION_PREFIX.length), 10) || 0;
      const nb = parseInt(b.slice(EXTENSION_PREFIX.length), 10) || 0;
      return na - nb;
    });
  }

  function addExtension() {
    const existing = new Set(extensionSections());
    if (existing.size >= MAX_EXTENSIONS) {
      toast(`Maximum of ${MAX_EXTENSIONS} extensions reached.`, "err");
      return;
    }
    let n = 1;
    while (existing.has(`${EXTENSION_PREFIX}${n}`) && n <= MAX_EXTENSIONS) n++;
    const section = `${EXTENSION_PREFIX}${n}`;
    state.property.groups.push(...makeSubgroupsForSection(section));
    renderGroups();
    updateExportButton();
    saveProperty();
    toast(`${section} added.`);
  }

  async function removeExtension(section) {
    if (!confirm(`Remove ${section} and all its photos? This can't be undone.`)) return;
    const groupsToRemove = state.property.groups.filter((g) => g.section === section);
    for (const group of groupsToRemove) {
      for (const pid of group.photoIds) {
        state.photos.delete(pid);
        IDB.deletePhoto(pid).catch(() => {});
      }
    }
    state.property.groups = state.property.groups.filter((g) => g.section !== section);
    renderGroups();
    updateExportButton();
    saveProperty();
    toast(`${section} removed.`);
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
    } else if (migrateDefaults(state.property)) {
      saveProperty();
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
    const ext = (state.property.groups || []).find(
      (g) => !g.section && (g.name || "").toLowerCase() === "external elevations"
    );
    if (ext) state.expanded.add(ext.id);
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

    // Top-level groups first (no section) in their existing order.
    for (const group of state.property.groups.filter((g) => !g.section)) {
      renderGroup(group, els.groups);
    }

    // Then sections: Main Property, then Extensions in order.
    const sections = [];
    if (state.property.groups.some((g) => g.section === MAIN_SECTION)) {
      sections.push(MAIN_SECTION);
    }
    sections.push(...extensionSections());

    for (const section of sections) {
      const wrap = createSectionElement(section);
      els.groups.appendChild(wrap);
      const body = wrap.querySelector(".section-body");
      for (const g of state.property.groups.filter((gg) => gg.section === section)) {
        renderGroup(g, body);
      }
    }

    renderAddExtensionRow();
  }

  function createSectionElement(section) {
    const wrap = document.createElement("section");
    wrap.className = "section-wrap";
    wrap.dataset.section = section;

    const header = document.createElement("div");
    header.className = "section-header";
    const title = document.createElement("h2");
    title.className = "section-title";
    title.textContent = section;
    header.appendChild(title);
    if (section.startsWith(EXTENSION_PREFIX)) {
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "btn btn-danger-ghost";
      rm.textContent = `Remove ${section}`;
      rm.addEventListener("click", () => removeExtension(section));
      header.appendChild(rm);
    }
    wrap.appendChild(header);

    const body = document.createElement("div");
    body.className = "section-body";
    wrap.appendChild(body);
    return wrap;
  }

  function renderAddExtensionRow() {
    const count = extensionSections().length;
    const row = document.createElement("div");
    row.className = "add-extension-row";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-primary-soft";
    btn.disabled = count >= MAX_EXTENSIONS;
    btn.textContent =
      count >= MAX_EXTENSIONS
        ? `Maximum of ${MAX_EXTENSIONS} extensions added`
        : `+ Add extension (${count}/${MAX_EXTENSIONS})`;
    btn.addEventListener("click", addExtension);
    row.appendChild(btn);
    els.groups.appendChild(row);
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
      const newOrder = Array.from(thumbsEl.querySelectorAll(".thumb"))
        .map((el) => el.dataset.photoId)
        .filter(Boolean);
      group.photoIds = newOrder.slice();
      saveProperty();
    });

    const addTile = thumbsEl.querySelector(".thumb-add");
    if (addTile) thumbsEl.insertBefore(node, addTile);
    else thumbsEl.appendChild(node);
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
    els.exportZipBtn.disabled = disabled;
  }

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
      dataUrl,
      width: outW,
      height: outH,
      takenAt: stampDate.toISOString(),
      gps: state.gps ? { ...state.gps } : null,
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

  async function buildPdf() {
    if (!window.jspdf || !window.jspdf.jsPDF) {
      throw new Error("PDF library failed to load.");
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
      const displayName = g.section ? `${g.section} — ${g.name}` : g.name;
      addOutline(displayName, startPage);

      doc.setFont("helvetica", "bold");
      doc.setFontSize(16);
      doc.text(displayName, margin, margin + 6);
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
    let currentSection = undefined;
    for (const g of groupsWithPhotos) {
      // Section heading (non-clickable) when we move into a new section.
      if (g.section !== currentSection) {
        currentSection = g.section;
        if (currentSection) {
          cy += 4;
          if (cy > pageH - margin - 40) break;
          doc.setFont("helvetica", "bold");
          doc.setFontSize(12);
          doc.setTextColor(60);
          doc.text(currentSection, margin, cy);
          doc.setDrawColor(210);
          doc.setLineWidth(0.4);
          doc.line(margin, cy + 2, pageW - margin, cy + 2);
          doc.setLineWidth(0.2);
          doc.setFont("helvetica", "normal");
          doc.setTextColor(0);
          cy += 16;
        }
      }

      const target = groupStartPages.get(g.id);
      const title = g.name;
      const countText = `${g.photoIds.length} photo${g.photoIds.length === 1 ? "" : "s"}`;
      const pageText = `p. ${target}`;
      total += g.photoIds.length;

      const rowLeft = g.section ? margin + 16 : margin;
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

  async function exportPdf() {
    try {
      const { doc, filename } = await buildPdf();
      doc.save(filename);
      toast("PDF saved.");
    } catch (err) {
      console.error(err);
      toast(err.message || "Failed to build PDF.", "err");
    }
  }

  async function exportZip() {
    if (typeof JSZip === "undefined") {
      toast("ZIP library failed to load.", "err");
      return;
    }
    try {
      toast("Building ZIP…");
      const { doc, filename: pdfName } = await buildPdf();
      const pdfBlob = doc.output("blob");

      const zip = new JSZip();
      zip.file(pdfName, pdfBlob);

      const groupsWithPhotos = state.property.groups.filter((g) => g.photoIds.length > 0);
      const usedGroupDirs = new Map();
      for (const g of groupsWithPhotos) {
        const parts = [];
        if (g.section) parts.push(slugify(g.section));
        parts.push(slugify(g.name));
        let dir = parts.join("/");
        const n = (usedGroupDirs.get(dir) || 0) + 1;
        usedGroupDirs.set(dir, n);
        if (n > 1) dir = `${dir}-${n}`;
        const folder = zip.folder(dir);

        let index = 0;
        for (const pid of g.photoIds) {
          const photo = state.photos.get(pid);
          if (!photo) continue;
          index += 1;
          const stampedDataUrl = buildExifDataUrl(photo);
          const bytes = dataUrlToBytes(stampedDataUrl);
          const label = slugify(photo.label || `${g.name}-${index}`);
          const name = `${String(index).padStart(2, "0")}_${label}.jpg`;
          const entryDate = photo.takenAt ? new Date(photo.takenAt) : new Date();
          folder.file(name, bytes, { date: entryDate });
        }
      }

      const zipBlob = await zip.generateAsync({
        type: "blob",
        compression: "STORE", // JPEGs don't compress; skip to keep it fast.
      });
      saveBlob(zipBlob, `${reportBaseName()}.zip`);
      toast("ZIP saved.");
    } catch (err) {
      console.error(err);
      toast(err.message || "Failed to build ZIP.", "err");
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

  els.exportBtn.addEventListener("click", () => {
    exportPdf();
  });

  els.exportZipBtn.addEventListener("click", () => {
    exportZip();
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
