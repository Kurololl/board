const SUPABASE_URL = "";
const SUPABASE_KEY = "";

const IMAGE_BUCKET = "images";
const MAX_IMAGE_SIDE = 1600;
const CAPTION = 30;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 8;
const CURSOR_INTERVAL = 70;
const LIVE_INTERVAL = 60;
const PALETTE = ["#e8590c", "#d6336c", "#ae3ec9", "#7048e8", "#1c7ed6", "#0c8599", "#2b8a3e", "#f08c00"];

const $ = s => document.querySelector(s);
const stage = $("#stage");
const world = $("#world");
const canvas = $("#canvas");
const ctx = canvas.getContext("2d");
const cursorsEl = $("#cursors");
const colorInput = $("#color");
const widthInput = $("#width");
const fileInput = $("#fileInput");
const nameInput = $("#name");
const toastEl = $("#toast");

const newId = () => crypto.randomUUID
  ? crypto.randomUUID()
  : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
const r = v => Math.round(v * 10) / 10;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); return true; } catch { return false; } },
};

const board = getBoardId();
const uid = newId();
const me = {
  name: store.get("board-name") || "Guest " + uid.slice(0, 4),
  color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
};

const cam = { x: 0, y: 0, zoom: 1 };
const strokes = new Map();
const pins = new Map();
const pinEls = new Map();
const liveStrokes = new Map();
const remoteCursors = new Map();
const cursorEls = new Map();
const pointers = new Map();
const undoStack = [];
const saveTimers = new Map();
const pinLiveTimers = new Map();

let backend = null;
let connState = "CONNECTING";
let usersOnline = 1;
let tool = "select";
let dirty = true;
let current = null;
let gesture = null;
let spaceDown = false;
let draggingPinId = null;
let zTop = 1;
let liveSent = 0;
let liveTimer = 0;
let cursorTimer = 0;
let lastPointer = { x: innerWidth / 2, y: innerHeight / 2 };
let camSaveTimer = 0;
let toastTimer = 0;

function getBoardId() {
  const m = location.hash.match(/b=([\w-]{4,64})/);
  if (m) return m[1];
  const id = newBoardId();
  history.replaceState(null, "", "#b=" + id);
  return id;
}

function newBoardId() {
  return newId().replace(/-/g, "").slice(0, 12);
}

const toWorld = (sx, sy) => ({ x: sx / cam.zoom + cam.x, y: sy / cam.zoom + cam.y });
const toScreen = (wx, wy) => ({ x: (wx - cam.x) * cam.zoom, y: (wy - cam.y) * cam.zoom });
const centerWorld = () => toWorld(innerWidth / 2, innerHeight / 2);

function applyCamera() {
  const tx = -cam.x * cam.zoom;
  const ty = -cam.y * cam.zoom;
  world.style.transform = `translate(${tx}px, ${ty}px) scale(${cam.zoom})`;
  let g = 24 * cam.zoom;
  while (g < 10) g *= 4;
  stage.style.backgroundSize = `${g}px ${g}px`;
  stage.style.backgroundPosition = `${tx}px ${ty}px`;
  updateCursors();
  dirty = true;
  clearTimeout(camSaveTimer);
  camSaveTimer = setTimeout(() => store.set("board-cam:" + board, JSON.stringify(cam)), 300);
}

function restoreCamera() {
  try {
    const saved = JSON.parse(store.get("board-cam:" + board));
    if (saved && isFinite(saved.x) && isFinite(saved.y) && isFinite(saved.zoom)) {
      Object.assign(cam, saved);
      return;
    }
  } catch {}
  cam.x = -innerWidth / 2;
  cam.y = -innerHeight / 2;
  cam.zoom = 1;
}

function zoomAt(sx, sy, factor) {
  const before = toWorld(sx, sy);
  cam.zoom = clamp(cam.zoom * factor, MIN_ZOOM, MAX_ZOOM);
  cam.x = before.x - sx / cam.zoom;
  cam.y = before.y - sy / cam.zoom;
  applyCamera();
}

function resize() {
  const dpr = devicePixelRatio || 1;
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
  canvas.style.width = innerWidth + "px";
  canvas.style.height = innerHeight + "px";
  dirty = true;
}

function frame() {
  if (dirty) {
    dirty = false;
    render();
  }
  requestAnimationFrame(frame);
}

function render() {
  const dpr = devicePixelRatio || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const k = dpr * cam.zoom;
  ctx.setTransform(k, 0, 0, k, -cam.x * k, -cam.y * k);
  const view = { x1: cam.x, y1: cam.y, x2: cam.x + innerWidth / cam.zoom, y2: cam.y + innerHeight / cam.zoom };
  for (const s of strokes.values()) {
    const b = s.bbox;
    if (b.x2 < view.x1 || b.x1 > view.x2 || b.y2 < view.y1 || b.y1 > view.y2) continue;
    drawStroke(s);
  }
  for (const s of liveStrokes.values()) drawStroke(s);
  if (current) drawStroke(current);
}

function drawStroke(s) {
  const p = s.points;
  if (!p || !p.length) return;
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineWidth = s.width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (p.length === 1) {
    ctx.beginPath();
    ctx.arc(p[0][0], p[0][1], s.width / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(p[0][0], p[0][1]);
  for (let i = 1; i < p.length - 1; i++) {
    ctx.quadraticCurveTo(p[i][0], p[i][1], (p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2);
  }
  const last = p[p.length - 1];
  ctx.lineTo(last[0], last[1]);
  ctx.stroke();
}

function withBBox(s) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const [x, y] of s.points) {
    if (x < x1) x1 = x;
    if (y < y1) y1 = y;
    if (x > x2) x2 = x;
    if (y > y2) y2 = y;
  }
  const h = s.width / 2;
  s.bbox = { x1: x1 - h, y1: y1 - h, x2: x2 + h, y2: y2 + h };
  return s;
}

function strokeData(s) {
  return { id: s.id, board: s.board, points: s.points, color: s.color, width: s.width };
}

function segDist(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = dx * dx + dy * dy;
  const t = l ? clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l, 0, 1) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

function simplify(points, eps) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = 0;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = segDist(points[i], points[a], points[b]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > eps) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

function startStroke(w) {
  current = {
    id: newId(),
    board,
    points: [[r(w.x), r(w.y)]],
    color: colorInput.value,
    width: Math.max(0.1, r(widthInput.value / cam.zoom)),
  };
  liveSent = 0;
  dirty = true;
}

function extendStroke(events) {
  for (const ev of events) {
    const w = toWorld(ev.clientX, ev.clientY);
    const last = current.points[current.points.length - 1];
    if (Math.hypot(w.x - last[0], w.y - last[1]) * cam.zoom >= 1.5) current.points.push([r(w.x), r(w.y)]);
  }
  sendLive();
  dirty = true;
}

function finishStroke() {
  const s = current;
  current = null;
  if (!s) return;
  s.points = simplify(s.points, 0.5 / cam.zoom);
  withBBox(s);
  strokes.set(s.id, s);
  dirty = true;
  pushUndo({ type: "stroke", id: s.id });
  flushLive(s);
  backend?.broadcast("liveEnd", { id: s.id });
  backend?.addStroke(strokeData(s));
}

function cancelStroke() {
  if (!current) return;
  backend?.broadcast("liveEnd", { id: current.id });
  current = null;
  dirty = true;
}

function sendLive() {
  if (liveTimer) return;
  liveTimer = setTimeout(() => {
    liveTimer = 0;
    if (current) flushLive(current);
  }, LIVE_INTERVAL);
}

function flushLive(s) {
  const pts = s.points.slice(liveSent);
  if (!pts.length) return;
  backend?.broadcast("live", { id: s.id, color: s.color, width: s.width, from: liveSent, points: pts });
  liveSent = s.points.length;
}

function eraseAt(w, erased) {
  const rad = 8 / cam.zoom;
  const q = [w.x, w.y];
  for (const s of strokes.values()) {
    const b = s.bbox;
    if (w.x < b.x1 - rad || w.x > b.x2 + rad || w.y < b.y1 - rad || w.y > b.y2 + rad) continue;
    const reach = rad + s.width / 2;
    const p = s.points;
    let hit = p.length === 1 && Math.hypot(p[0][0] - w.x, p[0][1] - w.y) <= reach;
    for (let i = 0; !hit && i < p.length - 1; i++) hit = segDist(q, p[i], p[i + 1]) <= reach;
    if (hit) {
      strokes.delete(s.id);
      erased.push(s);
      backend?.deleteStroke(s.id);
      dirty = true;
    }
  }
}

function pushUndo(action) {
  undoStack.push(action);
  if (undoStack.length > 200) undoStack.shift();
}

function undo() {
  const a = undoStack.pop();
  if (!a) return;
  if (a.type === "stroke") {
    if (strokes.delete(a.id)) {
      backend?.deleteStroke(a.id);
      dirty = true;
    }
  } else if (a.type === "erase") {
    for (const s of a.strokes) {
      strokes.set(s.id, s);
      backend?.addStroke(strokeData(s));
    }
    dirty = true;
  } else if (a.type === "pin") {
    const p = pins.get(a.id);
    if (p) deletePin(p);
  }
}

function pinData(p) {
  return { id: p.id, board: p.board, x: p.x, y: p.y, w: p.w, h: p.h, image_url: p.image_url || null, text: p.text || "" };
}

function createPinEl(p) {
  const el = document.createElement("div");
  el.className = "pin " + (p.image_url ? "pin-image" : "pin-note");
  el.dataset.id = p.id;
  el.innerHTML =
    '<div class="pin-bar"></div>' +
    (p.image_url ? '<img draggable="false" alt="">' : "") +
    '<textarea spellcheck="false"></textarea>' +
    '<button class="pin-del" title="Delete">×</button>' +
    '<div class="pin-resize"></div>';
  const ta = el.querySelector("textarea");
  ta.placeholder = p.image_url ? "Caption" : "Write something…";
  ta.addEventListener("input", () => {
    const pin = pins.get(p.id);
    if (!pin) return;
    pin.text = ta.value;
    savePinSoon(pin);
  });
  el.querySelector(".pin-del").addEventListener("click", () => {
    const pin = pins.get(p.id);
    if (pin) deletePin(pin);
  });
  el.addEventListener("pointerdown", e => onPinPointerDown(e, p.id));
  return el;
}

function renderPin(p) {
  let el = pinEls.get(p.id);
  if (!el) {
    el = createPinEl(p);
    pinEls.set(p.id, el);
    world.appendChild(el);
  }
  el.style.left = p.x + "px";
  el.style.top = p.y + "px";
  el.style.width = p.w + "px";
  el.style.height = p.h + "px";
  const ta = el.querySelector("textarea");
  if (document.activeElement !== ta && ta.value !== (p.text || "")) ta.value = p.text || "";
  const img = el.querySelector("img");
  if (img && p.image_url && img.getAttribute("src") !== p.image_url) img.src = p.image_url;
}

function createPinLocal(p) {
  pins.set(p.id, p);
  renderPin(p);
  pinEls.get(p.id).style.zIndex = ++zTop;
  pushUndo({ type: "pin", id: p.id });
  backend?.upsertPin(pinData(p));
  setTool("select");
}

function removePinLocal(id) {
  pins.delete(id);
  pinEls.get(id)?.remove();
  pinEls.delete(id);
}

function deletePin(p) {
  removePinLocal(p.id);
  clearTimeout(saveTimers.get(p.id));
  saveTimers.delete(p.id);
  backend?.deletePin(pinData(p));
}

function applyRemotePin(p) {
  if (draggingPinId === p.id) return;
  const cur = pins.get(p.id);
  const merged = { ...cur, ...p };
  const el = pinEls.get(p.id);
  if (cur && el && document.activeElement === el.querySelector("textarea")) merged.text = cur.text;
  pins.set(p.id, merged);
  renderPin(merged);
}

function savePinSoon(p) {
  clearTimeout(saveTimers.get(p.id));
  saveTimers.set(p.id, setTimeout(() => {
    saveTimers.delete(p.id);
    if (pins.has(p.id)) backend?.upsertPin(pinData(p));
  }, 400));
}

function sendPinLive(p) {
  if (pinLiveTimers.has(p.id)) return;
  pinLiveTimers.set(p.id, setTimeout(() => {
    pinLiveTimers.delete(p.id);
    backend?.broadcast("pin", { id: p.id, x: p.x, y: p.y, w: p.w, h: p.h });
  }, LIVE_INTERVAL));
}

function onPinPointerDown(e, id) {
  if (tool !== "select" || spaceDown || e.button !== 0) return;
  const el = pinEls.get(id);
  const pin = pins.get(id);
  if (!el || !pin) return;
  e.stopPropagation();
  el.style.zIndex = ++zTop;
  if (e.target.closest("textarea, .pin-del")) return;
  e.preventDefault();
  if (document.activeElement?.tagName === "TEXTAREA") document.activeElement.blur();
  const mode = e.target.closest(".pin-resize") ? "resize" : "move";
  const start = toWorld(e.clientX, e.clientY);
  const orig = { x: pin.x, y: pin.y, w: pin.w, h: pin.h };
  const ratio = pin.image_url ? (orig.h - CAPTION) / orig.w : 0;
  let moved = false;
  draggingPinId = id;
  el.setPointerCapture(e.pointerId);
  el.classList.add("dragging");
  const move = ev => {
    const w = toWorld(ev.clientX, ev.clientY);
    const dx = w.x - start.x;
    const dy = w.y - start.y;
    if (mode === "move") {
      pin.x = r(orig.x + dx);
      pin.y = r(orig.y + dy);
    } else {
      pin.w = r(Math.max(80, orig.w + dx));
      pin.h = r(ratio && !ev.shiftKey ? pin.w * ratio + CAPTION : Math.max(60, orig.h + dy));
    }
    moved = true;
    renderPin(pin);
    sendPinLive(pin);
  };
  const up = () => {
    el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerup", up);
    el.removeEventListener("pointercancel", up);
    el.classList.remove("dragging");
    draggingPinId = null;
    if (moved && pins.has(id)) backend?.upsertPin(pinData(pin));
  };
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", up);
}

function addNote(text = "", at = centerWorld()) {
  const w = 220 / cam.zoom;
  const h = 160 / cam.zoom;
  const p = { id: newId(), board, x: r(at.x - w / 2), y: r(at.y - h / 2), w: r(w), h: r(h), image_url: null, text };
  createPinLocal(p);
  if (!text) setTimeout(() => pinEls.get(p.id)?.querySelector("textarea").focus(), 0);
}

function createImagePin(url, iw, ih, at, i = 0) {
  const pw = 320 / cam.zoom;
  const ph = pw * ih / iw + CAPTION;
  const off = i * 24 / cam.zoom;
  createPinLocal({ id: newId(), board, x: r(at.x - pw / 2 + off), y: r(at.y - ph / 2 + off), w: r(pw), h: r(ph), image_url: url, text: "" });
}

async function prepareImage(file) {
  const bmp = await createImageBitmap(file);
  const { width, height } = bmp;
  if (file.type === "image/gif" && file.size < 4 * 1024 * 1024) {
    bmp.close();
    return { blob: file, ext: "gif", w: width, h: height };
  }
  const k = Math.min(1, MAX_IMAGE_SIDE / Math.max(width, height));
  const w = Math.max(1, Math.round(width * k));
  const h = Math.max(1, Math.round(height * k));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d").drawImage(bmp, 0, 0, w, h);
  bmp.close();
  let blob = await new Promise(res => c.toBlob(res, "image/webp", 0.82));
  let ext = "webp";
  if (!blob || blob.type !== "image/webp") {
    blob = await new Promise(res => c.toBlob(res, "image/jpeg", 0.85));
    ext = "jpg";
  }
  return { blob, ext, w, h };
}

async function addImages(files, at = centerWorld()) {
  const list = [...files].filter(f => f.type.startsWith("image/"));
  if (!list.length || !backend) return;
  let i = 0;
  for (const f of list) {
    showToast(list.length > 1 ? `Uploading ${i + 1}/${list.length}…` : "Uploading image…", 60000);
    try {
      const { blob, ext, w, h } = await prepareImage(f);
      const url = await backend.uploadImage(blob, ext);
      createImagePin(url, w, h, at, i++);
    } catch (err) {
      console.error(err);
      showToast("Image upload failed");
      return;
    }
  }
  showToast(i > 1 ? `${i} images added` : "Image added");
}

function addImageFromUrl(url, at) {
  const img = new Image();
  img.onload = () => createImagePin(url, img.naturalWidth, img.naturalHeight, at);
  img.onerror = () => addNote(url, at);
  img.src = url;
}

function setTool(t) {
  tool = t;
  document.body.classList.remove("tool-select", "tool-pen", "tool-eraser");
  document.body.classList.add("tool-" + t);
  for (const b of document.querySelectorAll("[data-tool]")) b.classList.toggle("active", b.dataset.tool === t);
}

function isTyping(el) {
  return el && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && el.type === "text") || el.isContentEditable);
}

function pinchInfo() {
  const [a, b] = [...pointers.values()];
  return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
}

stage.addEventListener("pointerdown", e => {
  stage.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    cancelStroke();
    const i = pinchInfo();
    gesture = { type: "pinch", ...i, world: toWorld(i.cx, i.cy), zoom: cam.zoom };
    return;
  }
  if (pointers.size > 2) return;
  if (document.activeElement?.tagName === "TEXTAREA") document.activeElement.blur();
  if (e.button === 1 || spaceDown || (tool === "select" && e.button === 0)) {
    gesture = { type: "pan", sx: e.clientX, sy: e.clientY, cx: cam.x, cy: cam.y };
    stage.classList.add("panning");
    return;
  }
  if (e.button !== 0) return;
  const w = toWorld(e.clientX, e.clientY);
  if (tool === "pen") {
    startStroke(w);
    gesture = { type: "draw" };
  } else if (tool === "eraser") {
    gesture = { type: "erase", erased: [] };
    eraseAt(w, gesture.erased);
  }
});

stage.addEventListener("pointermove", e => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!gesture) return;
  if (gesture.type === "pinch") {
    if (pointers.size < 2) return;
    const i = pinchInfo();
    cam.zoom = clamp(gesture.zoom * i.d / gesture.d, MIN_ZOOM, MAX_ZOOM);
    cam.x = gesture.world.x - i.cx / cam.zoom;
    cam.y = gesture.world.y - i.cy / cam.zoom;
    applyCamera();
    return;
  }
  if (gesture.type === "pan") {
    cam.x = gesture.cx - (e.clientX - gesture.sx) / cam.zoom;
    cam.y = gesture.cy - (e.clientY - gesture.sy) / cam.zoom;
    applyCamera();
    return;
  }
  const events = e.getCoalescedEvents?.() || [];
  if (!events.length) events.push(e);
  if (gesture.type === "draw" && current) extendStroke(events);
  else if (gesture.type === "erase") for (const ev of events) eraseAt(toWorld(ev.clientX, ev.clientY), gesture.erased);
});

function endPointer(e) {
  if (!pointers.delete(e.pointerId)) return;
  if (!gesture) return;
  if (gesture.type === "pinch") {
    if (pointers.size === 0) gesture = null;
    return;
  }
  if (gesture.type === "draw") finishStroke();
  else if (gesture.type === "erase" && gesture.erased.length) pushUndo({ type: "erase", strokes: gesture.erased });
  gesture = null;
  stage.classList.remove("panning");
}

stage.addEventListener("pointerup", endPointer);
stage.addEventListener("pointercancel", endPointer);
stage.addEventListener("mousedown", e => { if (e.button === 1) e.preventDefault(); });
stage.addEventListener("contextmenu", e => { if (gesture) e.preventDefault(); });

stage.addEventListener("dblclick", e => {
  if (tool === "select" && !e.target.closest(".pin")) addNote("", toWorld(e.clientX, e.clientY));
});

stage.addEventListener("wheel", e => {
  const ta = e.target.closest?.("textarea");
  if (ta && !e.ctrlKey && ta.scrollHeight > ta.clientHeight) return;
  e.preventDefault();
  const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? innerHeight : 1;
  const k = e.ctrlKey ? 0.01 : 0.0015;
  zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * unit * k));
}, { passive: false });

addEventListener("pointermove", e => {
  lastPointer = { x: e.clientX, y: e.clientY };
  if (cursorTimer) return;
  cursorTimer = setTimeout(() => {
    cursorTimer = 0;
    const w = toWorld(lastPointer.x, lastPointer.y);
    backend?.broadcast("cursor", { uid, name: me.name, color: me.color, x: r(w.x), y: r(w.y) });
  }, CURSOR_INTERVAL);
});

addEventListener("keydown", e => {
  if (isTyping(e.target)) {
    if (e.key === "Escape") e.target.blur();
    return;
  }
  if (e.code === "Space") {
    e.preventDefault();
    if (!spaceDown) {
      spaceDown = true;
      stage.classList.add("space");
    }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.code === "KeyZ") {
    e.preventDefault();
    undo();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const tools = { KeyV: "select", KeyH: "select", KeyP: "pen", KeyB: "pen", KeyE: "eraser" };
  if (tools[e.code]) setTool(tools[e.code]);
  else if (e.code === "KeyN") addNote("", toWorld(lastPointer.x, lastPointer.y));
  else if (e.code === "KeyI") fileInput.click();
});

addEventListener("keyup", e => {
  if (e.code === "Space") {
    spaceDown = false;
    stage.classList.remove("space");
  }
});

addEventListener("blur", () => {
  spaceDown = false;
  stage.classList.remove("space");
});

addEventListener("paste", e => {
  if (isTyping(e.target)) return;
  const at = toWorld(lastPointer.x, lastPointer.y);
  const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith("image/"));
  if (files.length) {
    e.preventDefault();
    addImages(files, at);
    return;
  }
  const text = e.clipboardData?.getData("text/plain")?.trim();
  if (!text) return;
  e.preventDefault();
  if (/^https?:\/\/\S+\.(png|jpe?g|gif|webp|avif|svg)(\?\S*)?$/i.test(text)) addImageFromUrl(text, at);
  else addNote(text, at);
});

let dragDepth = 0;
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes("Files");

addEventListener("dragenter", e => {
  if (!hasFiles(e)) return;
  dragDepth++;
  document.body.classList.add("dropping");
});

addEventListener("dragleave", e => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove("dropping");
});

addEventListener("dragover", e => {
  if (hasFiles(e)) e.preventDefault();
});

addEventListener("drop", e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("dropping");
  addImages(e.dataTransfer.files, toWorld(e.clientX, e.clientY));
});

addEventListener("resize", () => {
  resize();
  updateCursors();
});

addEventListener("hashchange", () => location.reload());

for (const b of document.querySelectorAll("[data-tool]")) b.addEventListener("click", () => setTool(b.dataset.tool));
$("#addNote").addEventListener("click", () => addNote());
$("#addImage").addEventListener("click", () => fileInput.click());
$("#undo").addEventListener("click", undo);
fileInput.addEventListener("change", () => {
  addImages(fileInput.files);
  fileInput.value = "";
});
$("#share").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    showToast("Board link copied");
  } catch {
    prompt("Copy this link:", location.href);
  }
});
$("#newBoard").addEventListener("click", () => {
  location.hash = "b=" + newBoardId();
});
nameInput.addEventListener("input", () => {
  me.name = nameInput.value.trim().slice(0, 24) || "Guest " + uid.slice(0, 4);
  store.set("board-name", me.name);
});

function updateCursors() {
  const now = Date.now();
  for (const [id, c] of remoteCursors) {
    if (now - c.t > 10000) {
      removeCursor(id);
      continue;
    }
    let el = cursorEls.get(id);
    if (!el) {
      el = document.createElement("div");
      el.className = "cursor";
      el.innerHTML = '<svg width="18" height="18" viewBox="0 0 18 18"><path d="M2 2 L16 8 L9.5 10 L7 16 Z" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg><span></span>';
      cursorsEl.appendChild(el);
      cursorEls.set(id, el);
    }
    const color = /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : "#555555";
    el.querySelector("path").setAttribute("fill", color);
    const label = el.querySelector("span");
    label.textContent = String(c.name || "Guest").slice(0, 24);
    label.style.background = color;
    const s = toScreen(c.x, c.y);
    el.style.transform = `translate(${s.x}px, ${s.y}px)`;
  }
}

function removeCursor(id) {
  remoteCursors.delete(id);
  cursorEls.get(id)?.remove();
  cursorEls.delete(id);
}

setInterval(() => {
  updateCursors();
  const now = Date.now();
  for (const [id, s] of liveStrokes) {
    if (now - s.t > (s.ended ? 3000 : 8000)) {
      liveStrokes.delete(id);
      dirty = true;
    }
  }
}, 1000);

function showToast(text, ms = 2000) {
  toastEl.textContent = text;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), ms);
}

function updateStatus() {
  const dot = $("#status .dot");
  const txt = $("#statusText");
  if (backend?.mode === "local") {
    dot.className = "dot local";
    txt.textContent = "Local mode";
    txt.title = "Supabase is not configured. Data is saved in this browser only; other tabs stay in sync.";
    return;
  }
  if (connState === "SUBSCRIBED") {
    dot.className = "dot on";
    txt.textContent = usersOnline > 1 ? `${usersOnline} online` : "Only you";
  } else {
    dot.className = "dot";
    txt.textContent = connState === "CONNECTING" ? "Connecting…" : "Reconnecting…";
  }
}

const handlers = {
  strokeAdd: s => {
    if (!s || !Array.isArray(s.points)) return;
    liveStrokes.delete(s.id);
    strokes.set(s.id, withBBox({ ...s }));
    dirty = true;
  },
  strokeDelete: id => {
    if (strokes.delete(id)) dirty = true;
  },
  pinUpsert: p => {
    if (p && p.board === board) applyRemotePin(p);
  },
  pinDelete: id => removePinLocal(id),
  pin: m => {
    const p = pins.get(m.id);
    if (!p || draggingPinId === m.id) return;
    Object.assign(p, { x: m.x, y: m.y, w: m.w, h: m.h });
    renderPin(p);
  },
  cursor: m => {
    if (!m || m.uid === uid) return;
    remoteCursors.set(m.uid, { ...m, t: Date.now() });
    updateCursors();
  },
  live: m => {
    if (!m || strokes.has(m.id) || !Array.isArray(m.points)) return;
    let s = liveStrokes.get(m.id);
    if (!s) {
      s = { points: [], color: m.color, width: m.width };
      liveStrokes.set(m.id, s);
    }
    s.points.splice(m.from, Infinity, ...m.points);
    s.t = Date.now();
    dirty = true;
  },
  liveEnd: m => {
    const s = liveStrokes.get(m?.id);
    if (!s) return;
    s.ended = true;
    s.t = Date.now();
  },
  presence: n => {
    usersOnline = n;
    updateStatus();
  },
  leave: key => removeCursor(key),
  status: st => {
    connState = st;
    updateStatus();
  },
};

async function createSupabaseBackend() {
  const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm");
  const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { realtime: { params: { eventsPerSecond: 40 } } });
  const channel = sb.channel("board:" + board, { config: { broadcast: { self: false }, presence: { key: uid } } });
  const filter = `board=eq.${board}`;
  let joined = false;

  for (const ev of ["cursor", "live", "liveEnd", "pin"]) {
    channel.on("broadcast", { event: ev }, ({ payload }) => handlers[ev](payload));
  }
  channel
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "strokes", filter }, ({ new: s }) => handlers.strokeAdd(s))
    .on("postgres_changes", { event: "DELETE", schema: "public", table: "strokes" }, ({ old }) => handlers.strokeDelete(old.id))
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "pins", filter }, ({ new: p }) => handlers.pinUpsert(p))
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "pins", filter }, ({ new: p }) => handlers.pinUpsert(p))
    .on("postgres_changes", { event: "DELETE", schema: "public", table: "pins" }, ({ old }) => handlers.pinDelete(old.id))
    .on("presence", { event: "sync" }, () => handlers.presence(Math.max(1, Object.keys(channel.presenceState()).length)))
    .on("presence", { event: "leave" }, ({ key }) => handlers.leave(key))
    .subscribe(async status => {
      joined = status === "SUBSCRIBED";
      handlers.status(status);
      if (joined) await channel.track({ online_at: Date.now() });
    });

  const run = async q => {
    const { error } = await q;
    if (error) {
      console.error(error);
      showToast("Sync error: " + error.message, 4000);
    }
  };

  const loadAll = async table => {
    const out = [];
    const size = 1000;
    for (let from = 0; ; from += size) {
      const { data, error } = await sb.from(table).select("*").eq("board", board).order("created_at").order("id").range(from, from + size - 1);
      if (error) throw error;
      out.push(...data);
      if (data.length < size) return out;
    }
  };

  const storagePath = url => {
    const marker = `/storage/v1/object/public/${IMAGE_BUCKET}/`;
    const i = url ? url.indexOf(marker) : -1;
    return i < 0 ? null : decodeURIComponent(url.slice(i + marker.length).split("?")[0]);
  };

  return {
    mode: "online",
    load: async () => ({ strokes: await loadAll("strokes"), pins: await loadAll("pins") }),
    broadcast: (event, payload) => {
      if (joined) channel.send({ type: "broadcast", event, payload });
    },
    addStroke: s => run(sb.from("strokes").upsert(s)),
    deleteStroke: id => run(sb.from("strokes").delete().eq("id", id)),
    upsertPin: p => run(sb.from("pins").upsert({ ...p, updated_at: new Date().toISOString() })),
    deletePin: async p => {
      await run(sb.from("pins").delete().eq("id", p.id));
      const path = storagePath(p.image_url);
      if (path) run(sb.storage.from(IMAGE_BUCKET).remove([path]));
    },
    uploadImage: async (blob, ext) => {
      const path = `${board}/${newId()}.${ext}`;
      const { error } = await sb.storage.from(IMAGE_BUCKET).upload(path, blob, { contentType: blob.type, cacheControl: "31536000" });
      if (error) throw error;
      return sb.storage.from(IMAGE_BUCKET).getPublicUrl(path).data.publicUrl;
    },
  };
}

function createLocalBackend() {
  const key = "board-data:" + board;
  const bc = "BroadcastChannel" in window ? new BroadcastChannel(key) : null;
  const read = () => {
    try {
      const d = JSON.parse(store.get(key));
      if (d && d.strokes && d.pins) return d;
    } catch {}
    return { strokes: {}, pins: {} };
  };
  const write = fn => {
    const d = read();
    fn(d);
    if (!store.set(key, JSON.stringify(d))) showToast("Browser storage is full", 4000);
  };
  const emit = (event, payload) => bc?.postMessage({ event, payload });
  if (bc) bc.onmessage = ({ data }) => handlers[data.event]?.(data.payload);
  handlers.presence(1);
  return {
    mode: "local",
    load: async () => {
      const d = read();
      return { strokes: Object.values(d.strokes), pins: Object.values(d.pins) };
    },
    broadcast: emit,
    addStroke: s => {
      write(d => { d.strokes[s.id] = s; });
      emit("strokeAdd", s);
    },
    deleteStroke: id => {
      write(d => { delete d.strokes[id]; });
      emit("strokeDelete", id);
    },
    upsertPin: p => {
      write(d => { d.pins[p.id] = p; });
      emit("pinUpsert", p);
    },
    deletePin: p => {
      write(d => { delete d.pins[p.id]; });
      emit("pinDelete", p.id);
    },
    uploadImage: blob => new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = rej;
      fr.readAsDataURL(blob);
    }),
  };
}

async function init() {
  resize();
  restoreCamera();
  applyCamera();
  setTool("select");
  nameInput.value = me.name;
  requestAnimationFrame(frame);
  try {
    backend = SUPABASE_URL && SUPABASE_KEY ? await createSupabaseBackend() : createLocalBackend();
  } catch (err) {
    console.error(err);
    showToast("Could not connect, switched to local mode", 4000);
    backend = createLocalBackend();
  }
  updateStatus();
  try {
    const data = await backend.load();
    for (const s of data.strokes) handlers.strokeAdd(s);
    for (const p of data.pins) applyRemotePin(p);
  } catch (err) {
    console.error(err);
    showToast("Failed to load board: " + (err.message || err), 5000);
  }
}

init();
