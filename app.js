(() => {
  "use strict";

  const DEFAULT_GROUPS = [
    { id: "external-elevations", name: "External Elevations" },
  ];

  const MAX_DIMENSION = 2000;
  const JPEG_QUALITY = 0.88;

  const state = {
    groups: [],
    gps: null,
    gpsWatchId: null,
  };

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
    metaAssessor: document.getElementById("meta-assessor"),
    metaAddress: document.getElementById("meta-address"),
    metaRef: document.getElementById("meta-ref"),
    metaDate: document.getElementById("meta-date"),
  };

  els.metaDate.valueAsDate = new Date();

  let toastTimer = null;
  function toast(message, variant) {
    els.toast.textContent = message;
    els.toast.classList.toggle("err", variant === "err");
    els.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove("show"), 2600);
  }

  function uid(prefix) {
    return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function slugify(s) {
    return s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 40) || "group";
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
    const dateText = formatStamp(stampDate);
    const gpsText = formatGps(state.gps);
    drawOverlay(ctx, w, h, dateText, gpsText);

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

  function createGroup(name, id) {
    const group = {
      id: id || uid("g"),
      name: name || "Untitled group",
      photos: [],
    };
    state.groups.push(group);
    renderGroup(group);
    updateExportButton();
    return group;
  }

  function removeGroup(groupId) {
    const idx = state.groups.findIndex((g) => g.id === groupId);
    if (idx === -1) return;
    const group = state.groups[idx];
    if (group.photos.length) {
      if (!confirm(`Remove "${group.name}" and its ${group.photos.length} photo(s)?`)) return;
    }
    state.groups.splice(idx, 1);
    const el = els.groups.querySelector(`[data-group-id="${groupId}"]`);
    if (el) el.remove();
    updateExportButton();
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
    });
    title.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        title.blur();
      }
    });

    const fileInput = node.querySelector(".file-input");
    fileInput.addEventListener("change", async (e) => {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      await addPhotos(group, files);
      fileInput.value = "";
    });

    node.querySelector(".btn-remove-group").addEventListener("click", () => removeGroup(group.id));

    els.groups.appendChild(node);
    updateGroupCount(group);
    return node;
  }

  function updateGroupCount(group) {
    const node = els.groups.querySelector(`[data-group-id="${group.id}"] .group-count`);
    if (!node) return;
    const n = group.photos.length;
    node.textContent = `${n} photo${n === 1 ? "" : "s"}`;
  }

  async function addPhotos(group, files) {
    const imageFiles = files.filter((f) => f.type.startsWith("image/"));
    if (!imageFiles.length) {
      toast("Please select image files.", "err");
      return;
    }
    if (!state.gps) {
      toast("Tip: enable GPS before taking photos for geolocation stamps.");
    }

    toast(`Processing ${imageFiles.length} photo${imageFiles.length === 1 ? "" : "s"}…`);

    for (const file of imageFiles) {
      try {
        const photo = await processFile(file);
        photo.label = `${group.name} — ${group.photos.length + 1}`;
        group.photos.push(photo);
        renderThumb(group, photo);
        updateGroupCount(group);
      } catch (err) {
        console.error(err);
        toast(`Failed to process ${file.name}`, "err");
      }
    }
    updateExportButton();
  }

  function renderThumb(group, photo) {
    const thumbsEl = els.groups.querySelector(`[data-group-id="${group.id}"] .thumbs`);
    if (!thumbsEl) return;
    const node = els.thumbTpl.content.firstElementChild.cloneNode(true);
    node.dataset.photoId = photo.id;
    const img = node.querySelector("img");
    img.src = photo.dataUrl;
    img.alt = photo.label;
    const label = node.querySelector(".thumb-label");
    label.value = photo.label;
    label.addEventListener("input", () => {
      photo.label = label.value;
    });
    node.querySelector(".thumb-remove").addEventListener("click", () => {
      const i = group.photos.findIndex((p) => p.id === photo.id);
      if (i !== -1) group.photos.splice(i, 1);
      node.remove();
      updateGroupCount(group);
      updateExportButton();
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
      group.photos.sort((a, b) => newOrder.indexOf(a.id) - newOrder.indexOf(b.id));
    });

    thumbsEl.appendChild(node);
  }

  function updateExportButton() {
    const anyPhotos = state.groups.some((g) => g.photos.length > 0);
    els.exportBtn.disabled = !anyPhotos;
  }

  function getMeta() {
    return {
      assessor: els.metaAssessor.value.trim(),
      address: els.metaAddress.value.trim(),
      ref: els.metaRef.value.trim(),
      date: els.metaDate.value,
    };
  }

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
    const meta = getMeta();

    // Cover page
    doc.setFont("helvetica", "bold");
    doc.setFontSize(22);
    doc.text("Photo Evidence Report", margin, margin + 10);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    let y = margin + 44;
    const lines = [
      ["Assessor", meta.assessor || "—"],
      ["Property", meta.address || "—"],
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

    y += 12;
    doc.setDrawColor(200);
    doc.line(margin, y, pageW - margin, y);
    y += 18;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text("Contents", margin, y);
    y += 18;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    let total = 0;
    for (const g of state.groups) {
      if (!g.photos.length) continue;
      doc.text(`• ${g.name}`, margin + 8, y);
      doc.text(`${g.photos.length}`, pageW - margin, y, { align: "right" });
      y += 16;
      total += g.photos.length;
      if (y > pageH - margin) {
        doc.addPage();
        y = margin;
      }
    }
    doc.setFont("helvetica", "bold");
    doc.text(`Total photos: ${total}`, margin, y + 6);

    // Per-group pages
    for (const g of state.groups) {
      if (!g.photos.length) continue;

      doc.addPage();
      doc.setFont("helvetica", "bold");
      doc.setFontSize(16);
      doc.text(g.name, margin, margin + 6);
      doc.setDrawColor(11, 61, 46);
      doc.setLineWidth(1.2);
      doc.line(margin, margin + 12, pageW - margin, margin + 12);
      doc.setLineWidth(0.2);

      let cursorY = margin + 32;
      let index = 0;
      for (const photo of g.photos) {
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
          doc.text(g.name, margin, margin - 8);
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

        const isLast = g.photos[g.photos.length - 1] === photo;
        if (!isLast && cursorY + 180 > pageH - margin) {
          doc.addPage();
          doc.setFont("helvetica", "bold");
          doc.setFontSize(12);
          doc.text(`${g.name} (cont.)`, margin, margin - 8);
          cursorY = margin;
        }
      }
    }

    // Footer page numbers
    const pageCount = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
      doc.setPage(i);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.setTextColor(130);
      doc.text(`Page ${i} of ${pageCount}`, pageW - margin, pageH - 18, { align: "right" });
      if (meta.ref) {
        doc.text(meta.ref, margin, pageH - 18);
      }
      doc.setTextColor(0);
    }

    const nameParts = [
      "photo-evidence",
      meta.ref ? slugify(meta.ref) : null,
      meta.date || new Date().toISOString().slice(0, 10),
    ].filter(Boolean);
    doc.save(`${nameParts.join("_")}.pdf`);
    toast("PDF saved.");
  }

  // Wiring
  els.gpsBtn.addEventListener("click", enableGps);
  els.addGroupBtn.addEventListener("click", () => {
    const name = els.addGroupName.value.trim();
    if (!name) {
      toast("Enter a group name.", "err");
      return;
    }
    createGroup(name);
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

  // Seed default groups
  for (const g of DEFAULT_GROUPS) createGroup(g.name, g.id);
})();
