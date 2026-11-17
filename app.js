const ROOT_ID = "main";
const DEFAULT_BRANCH = "board-data";
const AUTOSAVE_DELAY = 2500;
const POLL_WITH_TOKEN = 15000;
const POLL_WITHOUT_TOKEN = 60000;
const MAX_IMAGE_SIDE = 1600;
const CAPTION = 30;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 8;
const FOLDER_COLORS = ["#4c6ef5", "#12b886", "#fab005", "#fa5252", "#be4bdb", "#15aabf", "#fd7e14", "#82c91e"];

const $ = s => document.querySelector(s);
const stage = $("#stage");
const world = $("#world");
const canvas = $("#canvas");
const ctx = canvas.getContext("2d");
const colorInput = $("#color");
const widthInput = $("#width");
const fileInput = $("#fileInput");
const toastEl = $("#toast");
const crumbsEl = $("#crumbs");
const statusDot = $("#status .dot");
const statusText = $("#statusText");
const settingsDlg = $("#settings");

const newId = () => crypto.randomUUID
  ? crypto.randomUUID()
  : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
const newBoardId = () => newId().replace(/-/g, "").slice(0, 12);
const r = v => Math.round(v * 10) / 10;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const safeColor = c => /^#[0-9a-f]{6}$/i.test(c) ? c : FOLDER_COLORS[0];
const boardPath = id => `boards/${id}.json`;
const ls = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); return true; } catch { return false; } },
  del: k => { try { localStorage.removeItem(k); } catch {} },
};

function bytesToB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const textToB64 = t => bytesToB64(new TextEncoder().encode(t));
const b64ToText = b => new TextDecoder().decode(Uint8Array.from(atob(b.replace(/\s/g, "")), c => c.charCodeAt(0)));

function stable(v) {
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
  return JSON.stringify(v);
}

function serialize(doc) {
  const block = m => {
    const lines = Object.entries(m).map(([k, v]) => "    " + JSON.stringify(k) + ": " + JSON.stringify(v));
    return lines.length ? "{\n" + lines.join(",\n") + "\n  }" : "{}";
  };
  return `{\n  "version": 1,\n  "id": ${JSON.stringify(doc.id)},\n  "items": ${block(doc.items)},\n  "strokes": ${block(doc.strokes)}\n}\n`;
}

function normalizeDoc(data, id = boardId) {
  return { version: 1, id, items: { ...(data?.items || {}) }, strokes: { ...(data?.strokes || {}) } };
}

function mergeMap(base, local, remote) {
  const out = {};
  for (const id of new Set([...Object.keys(remote), ...Object.keys(local), ...Object.keys(base)])) {
    const localChanged = stable(base[id]) !== stable(local[id]);
    const v = localChanged ? local[id] : remote[id];
    if (v) out[id] = v;
  }
  return out;
}

function mergeDocs(base, local, remote) {
  return { version: 1, id: remote.id, items: mergeMap(base.items, local.items, remote.items), strokes: mergeMap(base.strokes, local.strokes, remote.strokes) };
}

function detectRepo() {
  const m = location.hostname.match(/^([\w-]+)\.github\.io$/i);
  if (!m) return {};
  const seg = location.pathname.split("/").filter(Boolean)[0];
  return { owner: m[1], repo: seg && !seg.includes(".html") ? seg : location.hostname };
}

function loadConfig() {
  let saved = {};
  try { saved = JSON.parse(ls.get("board-github")) || {}; } catch {}
  const detected = saved.disconnected ? {} : detectRepo();
  return {
    owner: saved.owner || detected.owner || "",
    repo: saved.repo || detected.repo || "",
    branch: saved.branch || DEFAULT_BRANCH,
    token: saved.token || "",
  };
}

function createGitHubStore({ owner, repo: name, branch, token }) {
  const api = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const raw = `https://raw.githubusercontent.com/${owner}/${name}/${branch}/`;
  const enc = p => p.split("/").map(encodeURIComponent).join("/");

  async function req(method, url, body) {
    const headers = { Accept: "application/vnd.github+json" };
    if (token) headers.Authorization = "Bearer " + token;
    if (body) headers["Content-Type"] = "application/json";
    const res = await fetch(api + url, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = (await res.json()).message || msg; } catch {}
      const err = new Error(`${res.status} ${msg}`);
      err.status = res.status;
      err.conflict = res.status === 409 || (res.status === 422 && /sha/i.test(msg));
      throw err;
    }
    return res.status === 204 ? null : res.json();
  }

  return {
    mode: "github",
    canWrite: !!token,
    label: `${owner}/${name}`,
    async init() {
      if (!token) return;
      try {
        await req("GET", `/branches/${enc(branch)}`);
      } catch (e) {
        if (e.status !== 404) throw e;
        const info = await req("GET", "");
        const ref = await req("GET", `/git/ref/heads/${enc(info.default_branch)}`);
        await req("POST", "/git/refs", { ref: `refs/heads/${branch}`, sha: ref.object.sha });
      }
    },
    async read(path) {
      try {
        const f = await req("GET", `/contents/${enc(path)}?ref=${encodeURIComponent(branch)}`);
        const b64 = f.content && f.encoding === "base64" ? f.content : (await req("GET", `/git/blobs/${f.sha}`)).content;
        return { data: JSON.parse(b64ToText(b64)), sha: f.sha };
      } catch (e) {
        if (e.status === 404) return { data: null, sha: null };
        throw e;
      }
    },
    async write(path, doc, sha, message) {
      const res = await req("PUT", `/contents/${enc(path)}`, { message, content: textToB64(serialize(doc)), branch, ...(sha ? { sha } : {}) });
      return res.content.sha;
    },
    async uploadImage(blob, ext) {
      const path = `images/${newId()}.${ext}`;
      await req("PUT", `/contents/${enc(path)}`, { message: "Add image", content: bytesToB64(new Uint8Array(await blob.arrayBuffer())), branch });
      blobCache.set(path, URL.createObjectURL(blob));
      return path;
    },
    imageUrl: path => raw + path,
    onChange() {},
  };
}

function createLocalStore() {
  const bc = "BroadcastChannel" in window ? new BroadcastChannel("board-local") : null;
  const key = p => "board-file:" + p;
  const readRaw = path => {
    try { return JSON.parse(ls.get(key(path))) || null; } catch { return null; }
  };
  let listener = null;
  if (bc) bc.onmessage = e => listener?.(e.data);
  return {
    mode: "local",
    canWrite: true,
    label: "this browser",
    async init() {},
    async read(path) {
      const f = readRaw(path);
      return f ? { data: f.data, sha: f.sha } : { data: null, sha: null };
    },
    async write(path, doc, sha) {
      const f = readRaw(path);
      if ((f?.sha || null) !== (sha || null)) {
        const e = new Error("Conflict");
        e.conflict = true;
        throw e;
      }
      const ns = newId();
      if (!ls.set(key(path), JSON.stringify({ sha: ns, data: JSON.parse(serialize(doc)) }))) throw new Error("Browser storage is full");
      bc?.postMessage(path);
      return ns;
    },
    uploadImage: blob => new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = rej;
      fr.readAsDataURL(blob);
    }),
    imageUrl: p => p,
    onChange(fn) { listener = fn; },
  };
}

const blobCache = new Map();
const docCache = new Map();
const config = loadConfig();
const repo = config.owner && config.repo ? createGitHubStore(config) : createLocalStore();

const cam = { x: 0, y: 0, zoom: 1 };
const strokes = new Map();
const pins = new Map();
const pinEls = new Map();
const pointers = new Map();
const undoStack = [];

let route = [ROOT_ID];
let boardId = ROOT_ID;
let sha = null;
let baseDoc = normalizeDoc(null);
let changeSeq = 0;
let savedSeq = 0;
let saving = false;
let savePromise = null;
let saveTimer = 0;
let loaded = false;
let loadToken = 0;
let lastError = "";
let tool = "select";
let dirty = true;
let current = null;
let gesture = null;
let spaceDown = false;
let draggingPinId = null;
let zTop = 1;
let lastPointer = { x: innerWidth / 2, y: innerHeight / 2 };
let camSaveTimer = 0;
let toastTimer = 0;

const hasUnsaved = () => changeSeq !== savedSeq;
const canEdit = () => repo.canWrite && loaded;

function parseRoute() {
  const m = location.hash.match(/^#b=([\w/-]+)/);
  const parts = m ? m[1].split("/").filter(p => /^[\w-]{1,64}$/.test(p)) : [];
  return parts.length ? parts : [ROOT_ID];
}

function snapshot() {
  const items = {};
  for (const p of pins.values()) items[p.id] = pinData(p);
  const st = {};
  for (const s of strokes.values()) st[s.id] = strokeData(s);
  return { version: 1, id: boardId, items, strokes: st };
}

function applyDoc(doc) {
  const ids = new Set(Object.keys(doc.items));
  for (const id of [...pins.keys()]) if (!ids.has(id) && id !== draggingPinId) removePinLocal(id);
  for (const p of Object.values(doc.items)) applyRemotePin(p);
  const next = new Map();
  for (const s of Object.values(doc.strokes)) {
    if (!s || !Array.isArray(s.points)) continue;
    const cur = strokes.get(s.id);
    next.set(s.id, cur && stable(cur.points) === stable(s.points) ? cur : withBBox({ ...s }));
  }
  strokes.clear();
  for (const [k, v] of next) strokes.set(k, v);
  dirty = true;
}

function markChanged() {
  changeSeq++;
  updateStatus();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, AUTOSAVE_DELAY);
}

function save() {
  if (saving) return savePromise;
  if (!repo.canWrite || !loaded || !hasUnsaved()) return Promise.resolve();
  clearTimeout(saveTimer);
  saving = true;
  updateStatus();
  savePromise = (async () => {
    try {
      for (let attempt = 0; ; attempt++) {
        const seq = changeSeq;
        const doc = snapshot();
        try {
          sha = await repo.write(boardPath(boardId), doc, sha, `Update board ${boardId}`);
          baseDoc = doc;
          docCache.set(boardId, doc);
          savedSeq = seq;
          lastError = "";
          break;
        } catch (e) {
          if (!e.conflict || attempt >= 4) throw e;
          await pull();
        }
      }
    } catch (e) {
      console.error(e);
      lastError = e.message || String(e);
      showToast("Save failed: " + lastError, 5000);
    } finally {
      saving = false;
      savePromise = null;
      updateStatus();
      if (hasUnsaved() && !lastError) saveTimer = setTimeout(save, AUTOSAVE_DELAY);
    }
  })();
  return savePromise;
}

async function pull() {
  const token = loadToken;
  const { data, sha: remoteSha } = await repo.read(boardPath(boardId));
  if (token !== loadToken) return;
  if (remoteSha === sha) return;
  const remote = normalizeDoc(data);
  const merged = mergeDocs(baseDoc, snapshot(), remote);
  baseDoc = remote;
  sha = remoteSha;
  docCache.set(boardId, remote);
  applyDoc(merged);
  if (stable(merged) !== stable(remote)) {
    if (!hasUnsaved()) changeSeq++;
  } else if (!saving) {
    savedSeq = changeSeq;
  }
  updateStatus();
  renderCrumbs();
}

async function pollOnce() {
  if (document.hidden || !loaded || saving || gesture || draggingPinId) return;
  if (hasUnsaved()) {
    if (lastError) {
      lastError = "";
      save();
    }
    return;
  }
  try {
    await pull();
  } catch (e) {
    console.error(e);
  }
}

function schedulePoll() {
  if (repo.mode !== "github") return;
  setTimeout(async () => {
    await pollOnce();
    schedulePoll();
  }, repo.canWrite ? POLL_WITH_TOKEN : POLL_WITHOUT_TOKEN);
}

async function getDoc(id) {
  if (docCache.has(id)) return docCache.get(id);
  try {
    const { data } = await repo.read(boardPath(id));
    const doc = normalizeDoc(data, id);
    docCache.set(id, doc);
    return doc;
  } catch {
    return null;
  }
}

async function renderCrumbs() {
  const token = loadToken;
  const names = await Promise.all(route.map(async (id, i) => {
    if (i === 0) return "Home";
    const parent = await getDoc(route[i - 1]);
    const item = Object.values(parent?.items || {}).find(it => it.type === "folder" && it.child === id);
    return item?.text?.trim() || "Untitled folder";
  }));
  if (token !== loadToken) return;
  crumbsEl.innerHTML = "";
  route.forEach((id, i) => {
    if (i) {
      const sep = document.createElement("span");
      sep.className = "crumb-sep";
      sep.textContent = "›";
      crumbsEl.append(sep);
    }
    const last = i === route.length - 1;
    const el = document.createElement(last ? "span" : "button");
    el.textContent = (i === 0 ? "🏠 " : "📁 ") + names[i];
    el.title = names[i];
    if (last) el.className = "current";
    else el.addEventListener("click", () => goTo(route.slice(0, i + 1)));
    crumbsEl.append(el);
  });
  document.title = names[names.length - 1] + " · Board";
}

function goTo(path) {
  location.hash = "b=" + path.join("/");
}

function goUp() {
  if (route.length > 1) goTo(route.slice(0, -1));
}

function openFolder(id) {
  const p = pins.get(id);
  if (p?.type === "folder" && p.child) goTo([...route, p.child]);
}

async function openBoard() {
  if (savePromise) await savePromise;
  if (hasUnsaved()) await save();
  const token = ++loadToken;
  route = parseRoute();
  boardId = route[route.length - 1];
  for (const el of pinEls.values()) el.remove();
  pins.clear();
  pinEls.clear();
  strokes.clear();
  undoStack.length = 0;
  current = null;
  gesture = null;
  draggingPinId = null;
  sha = null;
  baseDoc = normalizeDoc(null);
  changeSeq = savedSeq = 0;
  loaded = false;
  lastError = "";
  clearTimeout(saveTimer);
  restoreCamera();
  applyCamera();
  updateStatus();
  renderCrumbs();
  try {
    const { data, sha: s } = await repo.read(boardPath(boardId));
    if (token !== loadToken) return;
    const doc = normalizeDoc(data);
    sha = s;
    baseDoc = doc;
    docCache.set(boardId, doc);
    applyDoc(doc);
    loaded = true;
  } catch (e) {
    if (token !== loadToken) return;
    console.error(e);
    showToast("Failed to load board: " + e.message + ". Reload the page.", 6000);
  }
  updateStatus();
}

const toWorld = (sx, sy) => ({ x: sx / cam.zoom + cam.x, y: sy / cam.zoom + cam.y });
const centerWorld = () => toWorld(innerWidth / 2, innerHeight / 2);

function applyCamera() {
  const tx = -cam.x * cam.zoom;
  const ty = -cam.y * cam.zoom;
  world.style.transform = `translate(${tx}px, ${ty}px) scale(${cam.zoom})`;
  let g = 24 * cam.zoom;
  while (g < 10) g *= 4;
  stage.style.backgroundSize = `${g}px ${g}px`;
  stage.style.backgroundPosition = `${tx}px ${ty}px`;
  dirty = true;
  const id = boardId;
  clearTimeout(camSaveTimer);
  camSaveTimer = setTimeout(() => ls.set("board-cam:" + id, JSON.stringify(cam)), 300);
}

function restoreCamera() {
  try {
    const saved = JSON.parse(ls.get("board-cam:" + boardId));
    if (saved && isFinite(saved.x) && isFinite(saved.y) && isFinite(saved.zoom)) {
      Object.assign(cam, saved);
      return;
    }
  } catch {}
  cam.zoom = 1;
  cam.x = -innerWidth / 2;
  cam.y = -innerHeight / 2;
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
  const x2 = cam.x + innerWidth / cam.zoom;
  const y2 = cam.y + innerHeight / cam.zoom;
  for (const s of strokes.values()) {
    const b = s.bbox;
    if (b.x2 < cam.x || b.x1 > x2 || b.y2 < cam.y || b.y1 > y2) continue;
    drawStroke(s);
  }
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
  return { id: s.id, points: s.points, color: s.color, width: s.width };
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

function finishStroke() {
  const s = current;
  current = null;
  if (!s) return;
  s.points = simplify(s.points, 0.5 / cam.zoom);
  withBBox(s);
  strokes.set(s.id, s);
  dirty = true;
  pushUndo({ type: "stroke", id: s.id });
  markChanged();
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
      dirty = true;
    }
  }
}

function pushUndo(action) {
  undoStack.push(action);
  if (undoStack.length > 200) undoStack.shift();
}

function undo() {
  if (!canEdit()) return;
  const a = undoStack.pop();
  if (!a) return;
  if (a.type === "stroke") {
    if (!strokes.delete(a.id)) return;
  } else if (a.type === "erase") {
    for (const s of a.strokes) strokes.set(s.id, s);
  } else if (a.type === "pin") {
    if (!pins.has(a.id)) return;
    removePinLocal(a.id);
  }
  dirty = true;
  markChanged();
}

function pinData(p) {
  const d = { id: p.id, type: p.type, x: p.x, y: p.y, w: p.w, h: p.h, text: p.text || "" };
  if (p.type === "image") d.image_url = p.image_url;
  if (p.type === "folder") {
    d.child = p.child;
    d.color = p.color;
  }
  return d;
}

function resolveImage(u) {
  if (!u) return "";
  if (/^(data:|blob:|https?:)/.test(u)) return u;
  return blobCache.get(u) || repo.imageUrl(u);
}

function createPinEl(p) {
  const el = document.createElement("div");
  el.className = "pin pin-" + p.type;
  el.dataset.id = p.id;
  let html = '<div class="pin-bar"></div>';
  if (p.type === "image") html += '<img draggable="false" alt="">';
  if (p.type === "folder") {
    html += '<div class="folder-body"><div class="folder-icon">📁</div><input class="pin-text folder-title" spellcheck="false" maxlength="80"><div class="folder-hint">Double-click to open</div></div>';
    html += '<button class="folder-open" title="Open folder">Open →</button>';
  } else {
    html += '<textarea class="pin-text" spellcheck="false"></textarea>';
  }
  html += '<button class="pin-del" title="Delete">×</button><div class="pin-resize" title="Resize"></div>';
  el.innerHTML = html;
  const field = el.querySelector(".pin-text");
  field.placeholder = p.type === "image" ? "Caption" : p.type === "folder" ? "Folder name" : "Write something…";
  field.readOnly = !repo.canWrite;
  field.addEventListener("input", () => {
    const pin = pins.get(p.id);
    if (!pin || !canEdit()) return;
    pin.text = field.value;
    markChanged();
  });
  if (p.type === "folder") {
    field.addEventListener("keydown", e => {
      if (e.key === "Enter") field.blur();
    });
    field.addEventListener("blur", () => renderCrumbs());
    el.addEventListener("dblclick", e => {
      if (e.target.closest(".pin-del, .pin-resize") || (repo.canWrite && e.target.closest(".folder-title"))) return;
      e.stopPropagation();
      openFolder(p.id);
    });
    el.querySelector(".folder-open").addEventListener("click", () => openFolder(p.id));
  }
  el.querySelector(".pin-del").addEventListener("click", () => {
    const pin = pins.get(p.id);
    if (pin && canEdit()) deletePin(pin);
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
  const field = el.querySelector(".pin-text");
  if (document.activeElement !== field && field.value !== (p.text || "")) field.value = p.text || "";
  if (p.type === "image") {
    const img = el.querySelector("img");
    const src = resolveImage(p.image_url);
    if (img.getAttribute("src") !== src) img.src = src;
  }
  if (p.type === "folder") el.style.setProperty("--folder", safeColor(p.color));
}

function createPinLocal(p) {
  pins.set(p.id, p);
  renderPin(p);
  pinEls.get(p.id).style.zIndex = ++zTop;
  pushUndo({ type: "pin", id: p.id });
  markChanged();
  setTool("select");
}

function removePinLocal(id) {
  pins.delete(id);
  pinEls.get(id)?.remove();
  pinEls.delete(id);
}

function deletePin(p) {
  if (p.type === "folder" && !confirm(`Delete folder "${p.text || "Untitled folder"}"? Its contents will no longer be reachable from the board.`)) return;
  removePinLocal(p.id);
  markChanged();
}

function applyRemotePin(p) {
  if (!p || !p.id || draggingPinId === p.id) return;
  const cur = pins.get(p.id);
  const merged = { ...cur, ...p };
  merged.type ||= merged.image_url ? "image" : "note";
  const el = pinEls.get(p.id);
  if (cur && el && document.activeElement === el.querySelector(".pin-text")) merged.text = cur.text;
  if (cur && cur.type !== merged.type) removePinLocal(p.id);
  pins.set(p.id, merged);
  renderPin(merged);
}

function folderAt(x, y, excludeId) {
  for (const n of document.elementsFromPoint(x, y)) {
    const f = n.closest?.(".pin-folder");
    if (f && f.dataset.id !== excludeId) return pins.get(f.dataset.id) || null;
  }
  return null;
}

async function moveIntoFolder(pin, folder) {
  const data = pinData(pin);
  const path = boardPath(folder.child);
  removePinLocal(pin.id);
  markChanged();
  try {
    for (let attempt = 0; ; attempt++) {
      const { data: raw, sha: childSha } = await repo.read(path);
      const doc = normalizeDoc(raw, folder.child);
      const n = Object.keys(doc.items).length % 8;
      doc.items[data.id] = { ...data, x: r(-data.w / 2 + n * 30), y: r(-data.h / 2 + n * 30) };
      try {
        await repo.write(path, doc, childSha, `Move item into ${folder.text || "folder"}`);
        docCache.set(folder.child, doc);
        break;
      } catch (e) {
        if (!e.conflict || attempt >= 4) throw e;
      }
    }
    showToast(`Moved into "${folder.text || "Untitled folder"}"`);
  } catch (e) {
    console.error(e);
    showToast("Move failed: " + e.message, 5000);
    pins.set(pin.id, pin);
    renderPin(pin);
    markChanged();
  }
}

function onPinPointerDown(e, id) {
  const el = pinEls.get(id);
  const pin = pins.get(id);
  if (!el || !pin || spaceDown || e.button !== 0) return;
  if (e.target.closest(".pin-text, .pin-del, .folder-open")) {
    e.stopPropagation();
    return;
  }
  if (tool !== "select" || !canEdit()) return;
  e.stopPropagation();
  e.preventDefault();
  el.style.zIndex = ++zTop;
  if (document.activeElement?.classList?.contains("pin-text")) document.activeElement.blur();
  const mode = e.target.closest(".pin-resize") ? "resize" : "move";
  const start = toWorld(e.clientX, e.clientY);
  const orig = { x: pin.x, y: pin.y, w: pin.w, h: pin.h };
  const ratio = pin.type === "image" ? (orig.h - CAPTION) / orig.w : 0;
  let moved = false;
  let target = null;
  draggingPinId = id;
  el.setPointerCapture(e.pointerId);
  el.classList.add("dragging");
  const setTarget = f => {
    if (f === target) return;
    if (target) pinEls.get(target.id)?.classList.remove("drop-target");
    target = f;
    if (target) pinEls.get(target.id)?.classList.add("drop-target");
  };
  const move = ev => {
    const w = toWorld(ev.clientX, ev.clientY);
    const dx = w.x - start.x;
    const dy = w.y - start.y;
    if (!moved && Math.hypot(dx, dy) * cam.zoom < 3) return;
    if (mode === "move") {
      pin.x = r(orig.x + dx);
      pin.y = r(orig.y + dy);
      setTarget(folderAt(ev.clientX, ev.clientY, id));
    } else {
      pin.w = r(Math.max(80, orig.w + dx));
      pin.h = r(ratio && !ev.shiftKey ? pin.w * ratio + CAPTION : Math.max(60, orig.h + dy));
    }
    moved = true;
    renderPin(pin);
  };
  const up = () => {
    el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerup", up);
    el.removeEventListener("pointercancel", up);
    el.classList.remove("dragging");
    draggingPinId = null;
    const into = target;
    setTarget(null);
    if (!moved || !pins.has(id)) return;
    if (into) {
      Object.assign(pin, orig);
      moveIntoFolder(pin, into);
    } else {
      markChanged();
    }
  };
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", up);
}

function addNote(text = "", at = centerWorld()) {
  if (!canEdit()) return;
  const w = 220 / cam.zoom;
  const h = 160 / cam.zoom;
  const p = { id: newId(), type: "note", x: r(at.x - w / 2), y: r(at.y - h / 2), w: r(w), h: r(h), text };
  createPinLocal(p);
  if (!text) pinEls.get(p.id)?.querySelector(".pin-text").focus();
}

function addFolder(at = centerWorld()) {
  if (!canEdit()) return;
  const w = 200 / cam.zoom;
  const h = 150 / cam.zoom;
  const p = {
    id: newId(),
    type: "folder",
    x: r(at.x - w / 2),
    y: r(at.y - h / 2),
    w: r(w),
    h: r(h),
    text: "",
    child: newBoardId(),
    color: FOLDER_COLORS[Math.floor(Math.random() * FOLDER_COLORS.length)],
  };
  createPinLocal(p);
  pinEls.get(p.id)?.querySelector(".pin-text").focus();
}

function createImagePin(url, iw, ih, at, i = 0) {
  const pw = 320 / cam.zoom;
  const ph = pw * ih / iw + CAPTION;
  const off = i * 24 / cam.zoom;
  createPinLocal({ id: newId(), type: "image", x: r(at.x - pw / 2 + off), y: r(at.y - ph / 2 + off), w: r(pw), h: r(ph), image_url: url, text: "" });
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
  if (!canEdit()) return readOnlyHint();
  const list = [...files].filter(f => f.type.startsWith("image/"));
  if (!list.length) return;
  const board = boardId;
  let i = 0;
  for (const f of list) {
    showToast(list.length > 1 ? `Uploading ${i + 1}/${list.length}…` : "Uploading image…", 60000);
    try {
      const { blob, ext, w, h } = await prepareImage(f);
      const url = await repo.uploadImage(blob, ext);
      if (board !== boardId) return;
      createImagePin(url, w, h, at, i++);
    } catch (err) {
      console.error(err);
      showToast("Image upload failed: " + err.message, 5000);
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

function readOnlyHint() {
  showToast("Read-only. Add a GitHub token in settings ⚙️ to edit.", 3500);
}

function setTool(t) {
  if (!repo.canWrite) t = "select";
  tool = t;
  document.body.classList.remove("tool-select", "tool-pen", "tool-eraser");
  document.body.classList.add("tool-" + t);
  for (const b of document.querySelectorAll("[data-tool]")) b.classList.toggle("active", b.dataset.tool === t);
}

function isTyping(el) {
  return el && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && /^(text|password|search)$/.test(el.type)) || el.isContentEditable);
}

function pinchInfo() {
  const [a, b] = [...pointers.values()];
  return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
}

stage.addEventListener("pointerdown", e => {
  stage.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    current = null;
    dirty = true;
    const i = pinchInfo();
    gesture = { type: "pinch", ...i, world: toWorld(i.cx, i.cy), zoom: cam.zoom };
    return;
  }
  if (pointers.size > 2) return;
  if (document.activeElement?.classList?.contains("pin-text")) document.activeElement.blur();
  if (e.button === 1 || spaceDown || (tool === "select" && e.button === 0) || !canEdit()) {
    gesture = { type: "pan", sx: e.clientX, sy: e.clientY, cx: cam.x, cy: cam.y };
    stage.classList.add("panning");
    return;
  }
  if (e.button !== 0) return;
  const w = toWorld(e.clientX, e.clientY);
  if (tool === "pen") {
    current = { id: newId(), points: [[r(w.x), r(w.y)]], color: colorInput.value, width: Math.max(0.1, r(widthInput.value / cam.zoom)) };
    gesture = { type: "draw" };
    dirty = true;
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
  if (gesture.type === "draw" && current) {
    for (const ev of events) {
      const w = toWorld(ev.clientX, ev.clientY);
      const last = current.points[current.points.length - 1];
      if (Math.hypot(w.x - last[0], w.y - last[1]) * cam.zoom >= 1.5) current.points.push([r(w.x), r(w.y)]);
    }
    dirty = true;
  } else if (gesture.type === "erase") {
    for (const ev of events) eraseAt(toWorld(ev.clientX, ev.clientY), gesture.erased);
  }
});

function endPointer(e) {
  if (!pointers.delete(e.pointerId)) return;
  if (!gesture) return;
  if (gesture.type === "pinch") {
    if (pointers.size === 0) gesture = null;
    return;
  }
  if (gesture.type === "draw") finishStroke();
  else if (gesture.type === "erase" && gesture.erased.length) {
    pushUndo({ type: "erase", strokes: gesture.erased });
    markChanged();
  }
  gesture = null;
  stage.classList.remove("panning");
}

stage.addEventListener("pointerup", endPointer);
stage.addEventListener("pointercancel", endPointer);
stage.addEventListener("mousedown", e => { if (e.button === 1) e.preventDefault(); });

stage.addEventListener("dblclick", e => {
  if (tool === "select" && !e.target.closest(".pin")) addNote("", toWorld(e.clientX, e.clientY));
});

stage.addEventListener("wheel", e => {
  const ta = e.target.closest?.("textarea");
  if (ta && !e.ctrlKey && ta.scrollHeight > ta.clientHeight) return;
  e.preventDefault();
  const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? innerHeight : 1;
  zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.0015)));
}, { passive: false });

addEventListener("pointermove", e => {
  lastPointer = { x: e.clientX, y: e.clientY };
});

addEventListener("keydown", e => {
  if (settingsDlg.open) return;
  if ((e.ctrlKey || e.metaKey) && e.code === "KeyS") {
    e.preventDefault();
    save();
    return;
  }
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
  if (e.key === "Escape" || (e.key === "Backspace" && route.length > 1)) {
    goUp();
    return;
  }
  const tools = { KeyV: "select", KeyH: "select", KeyP: "pen", KeyB: "pen", KeyE: "eraser" };
  const at = toWorld(lastPointer.x, lastPointer.y);
  if (tools[e.code]) setTool(tools[e.code]);
  else if (e.code === "KeyN") addNote("", at);
  else if (e.code === "KeyF") addFolder(at);
  else if (e.code === "KeyI" && canEdit()) fileInput.click();
  else return;
  e.preventDefault();
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
  if (isTyping(e.target) || settingsDlg.open) return;
  if (!canEdit()) return readOnlyHint();
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
  if (!hasFiles(e) || !canEdit()) return;
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

addEventListener("resize", resize);
addEventListener("hashchange", () => openBoard());
addEventListener("focus", () => {
  if (repo.mode === "github" && repo.canWrite) pollOnce();
});
addEventListener("beforeunload", e => {
  if (hasUnsaved() || saving) {
    save();
    e.preventDefault();
    e.returnValue = "";
  }
});

for (const b of document.querySelectorAll("[data-tool]")) b.addEventListener("click", () => setTool(b.dataset.tool));
$("#addNote").addEventListener("click", () => addNote());
$("#addFolder").addEventListener("click", () => addFolder());
$("#addImage").addEventListener("click", () => fileInput.click());
$("#undo").addEventListener("click", undo);
fileInput.addEventListener("change", () => {
  addImages(fileInput.files);
  fileInput.value = "";
});
$("#share").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    showToast("Link copied");
  } catch {
    prompt("Copy this link:", location.href);
  }
});

$("#openSettings").addEventListener("click", () => {
  const f = settingsDlg.querySelector("form");
  f.owner.value = config.owner;
  f.repo.value = config.repo;
  f.branch.value = config.branch;
  f.token.value = config.token;
  settingsDlg.showModal();
});

settingsDlg.addEventListener("close", async () => {
  const f = settingsDlg.querySelector("form");
  if (settingsDlg.returnValue === "save") {
    ls.set("board-github", JSON.stringify({
      owner: f.owner.value.trim(),
      repo: f.repo.value.trim(),
      branch: f.branch.value.trim() || DEFAULT_BRANCH,
      token: f.token.value.trim(),
    }));
  } else if (settingsDlg.returnValue === "disconnect") {
    ls.set("board-github", JSON.stringify({ disconnected: true }));
  } else {
    return;
  }
  if (savePromise) await savePromise;
  location.reload();
});

function showToast(text, ms = 2000) {
  toastEl.textContent = text;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), ms);
}

function updateStatus() {
  let cls = "dot";
  let text;
  if (!loaded) text = "Loading…";
  else if (repo.mode === "local") {
    cls += " local";
    text = "Local only";
  } else if (!repo.canWrite) text = "Read-only";
  else if (lastError) {
    cls += " error";
    text = "Save failed";
  } else if (saving) {
    cls += " busy";
    text = "Saving…";
  } else if (hasUnsaved()) {
    cls += " busy";
    text = "Unsaved";
  } else {
    cls += " on";
    text = "Saved";
  }
  statusDot.className = cls;
  statusText.textContent = text;
  statusText.title = lastError || (repo.mode === "github"
    ? `Stored in ${repo.label}, branch ${config.branch}`
    : "Saved in this browser only. Open settings to connect a GitHub repository.");
}

async function init() {
  document.body.classList.toggle("readonly", !repo.canWrite);
  resize();
  setTool("select");
  requestAnimationFrame(frame);
  repo.onChange(path => {
    if (path === boardPath(boardId) && loaded) pull().catch(console.error);
  });
  try {
    await repo.init();
  } catch (e) {
    console.error(e);
    repo.canWrite = false;
    document.body.classList.add("readonly");
    setTool("select");
    showToast("GitHub access failed: " + e.message, 6000);
  }
  if (!/^#b=/.test(location.hash)) history.replaceState(null, "", "#b=" + ROOT_ID);
  await openBoard();
  schedulePoll();
}

init();
