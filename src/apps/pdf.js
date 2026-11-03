// PDF: view and edit PDFs. Add text, draw, highlight, white-out, sign,
// rotate / delete / reorder pages, and combine files.
//
// Edits are stored separately from the original file, so nothing is lost
// until you export. Annotations are kept in each page's own PDF coordinate
// space, which keeps them in place when a page is rotated.

import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { h, icon, iconBtn, toast, busy, actionSheet, askText, pickColor, confirmBox, customDialog, debounce } from '../ui.js';
import { exportFile, pickFiles, readBytes, extOf } from '../files.js';
import { topBar, persist } from './shell.js';
import { shrinkImage } from './docs.js';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const A4 = [595.28, 841.89];
let counter = 0;
const newId = (p = 'p') => `${p}${Date.now().toString(36)}${(counter++).toString(36)}`;
const isImageName = (name) => /^(png|jpe?g|webp|gif)$/.test(extOf(name));

// ---------- Building documents ----------
async function imagePage(bytes, name) {
  const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[extOf(name)] || 'image/jpeg';
  const src = await shrinkImage(new Blob([bytes], { type: mime }), 2200);
  const img = new Image();
  img.src = src;
  await img.decode();
  const w = A4[0];
  return { id: newId(), image: src, w, h: Math.round((w * img.naturalHeight) / img.naturalWidth), rot: 0, annots: [] };
}

async function openPdf(bytes, password) {
  try {
    const pdf = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, password }).promise;
    pdf.openedWith = password;
    return pdf;
  } catch (err) {
    if (err?.name === 'PasswordException') {
      const pw = await askText(password ? 'Wrong password. Try again' : 'This PDF is locked. Enter its password', { ok: 'Open' });
      if (pw == null) throw new Error('This PDF needs a password');
      return openPdf(bytes, pw);
    }
    throw new Error('This file does not look like a valid PDF');
  }
}

export async function fromFiles(bytesList, names) {
  const data = { sources: {}, passwords: {}, pages: [] };
  for (let i = 0; i < bytesList.length; i++) await appendFile(data, bytesList[i], names[i]);
  if (!data.pages.length) throw new Error('No pages found');
  return data;
}

async function appendFile(data, bytes, name, at = data.pages.length) {
  const added = [];
  if (isImageName(name)) {
    added.push(await imagePage(bytes, name));
  } else {
    const pdf = await openPdf(bytes);
    const sid = newId('s');
    data.sources[sid] = bytes;
    if (pdf.openedWith) data.passwords[sid] = pdf.openedWith;
    for (let i = 0; i < pdf.numPages; i++) added.push({ id: newId(), src: sid, index: i, rot: 0, annots: [] });
    pdf.loadingTask.destroy();
  }
  data.pages.splice(at, 0, ...added);
  return added.length;
}

export function create() {
  return { sources: {}, passwords: {}, pages: [{ id: newId(), blank: true, w: A4[0], h: A4[1], rot: 0, annots: [] }] };
}

export async function importFile(bytes, name) {
  return fromFiles([bytes], [name]);
}

// ---------- Coordinates (same math pdf.js uses for its viewports) ----------
function makeViewport(viewBox, scale, rotation) {
  const [x1, y1, x2, y2] = viewBox;
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  const [a, b, c, d] = { 0: [1, 0, 0, -1], 90: [0, 1, 1, 0], 180: [-1, 0, 0, 1], 270: [0, -1, -1, 0] }[rotation];
  let ox, oy, width, height;
  if (a === 0) {
    ox = Math.abs(cy - y1) * scale; oy = Math.abs(cx - x1) * scale;
    width = (y2 - y1) * scale; height = (x2 - x1) * scale;
  } else {
    ox = Math.abs(cx - x1) * scale; oy = Math.abs(cy - y1) * scale;
    width = (x2 - x1) * scale; height = (y2 - y1) * scale;
  }
  const t = [a * scale, b * scale, c * scale, d * scale, ox - a * scale * cx - c * scale * cy, oy - b * scale * cx - d * scale * cy];
  const det = t[0] * t[3] - t[1] * t[2];
  return {
    width, height, scale, rotation,
    toView: (x, y) => [x * t[0] + y * t[2] + t[4], x * t[1] + y * t[3] + t[5]],
    toUser: (vx, vy) => [((vx - t[4]) * t[3] - (vy - t[5]) * t[2]) / det, ((vy - t[5]) * t[0] - (vx - t[4]) * t[1]) / det],
  };
}

// Unit vectors (in PDF space) for "right" and "down" on screen, per rotation.
const RIGHT = { 0: [1, 0], 90: [0, 1], 180: [-1, 0], 270: [0, -1] };
const DOWN = { 0: [0, -1], 90: [1, 0], 180: [0, 1], 270: [-1, 0] };
const ASCENT = 0.85;
const LINE = 1.2;

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function dataUrlBytes(url) {
  const bin = atob(url.split(',')[1]);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Text in any language: draw it to a picture when the built-in PDF font can't.
function textToPng(text, size, color) {
  const lines = text.split('\n');
  const px = size * 4;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = `${px}px Helvetica, Arial, sans-serif`;
  const width = Math.max(...lines.map((l) => ctx.measureText(l).width), 1);
  canvas.width = Math.ceil(width) + 4;
  canvas.height = Math.ceil(px * LINE * lines.length);
  ctx.font = `${px}px Helvetica, Arial, sans-serif`;
  ctx.fillStyle = color;
  ctx.textBaseline = 'alphabetic';
  lines.forEach((l, i) => ctx.fillText(l, 0, px * ASCENT + i * px * LINE));
  return { url: canvas.toDataURL('image/png'), w: canvas.width / 4, h: canvas.height / 4 };
}

// ---------- Export ----------
export async function buildPdf(data, rasterize) {
  const { PDFDocument, StandardFonts, rgb, degrees, LineCapStyle, BlendMode } = await import('pdf-lib');
  const out = await PDFDocument.create();
  const font = await out.embedFont(StandardFonts.Helvetica);
  const loaded = {};
  const images = new Map();
  const embed = async (url) => {
    if (!images.has(url)) images.set(url, url.startsWith('data:image/png') ? await out.embedPng(dataUrlBytes(url)) : await out.embedJpg(dataUrlBytes(url)));
    return images.get(url);
  };

  for (const p of data.pages) {
    let page;
    let off = [0, 0];
    if (p.src) {
      if (!(p.src in loaded)) {
        try {
          const doc = await PDFDocument.load(data.sources[p.src], { updateMetadata: false });
          loaded[p.src] = doc.isEncrypted ? null : doc;
        } catch {
          loaded[p.src] = null;
        }
      }
      if (loaded[p.src]) {
        [page] = await out.copyPages(loaded[p.src], [p.index]);
        out.addPage(page);
        page.setRotation(degrees((page.getRotation().angle + p.rot) % 360));
      } else {
        // Locked or damaged file: keep the look by placing each page as a picture.
        const { url, view, rotate } = await rasterize(p);
        page = out.addPage([view[2] - view[0], view[3] - view[1]]);
        page.drawImage(await embed(url), { x: 0, y: 0, width: view[2] - view[0], height: view[3] - view[1] });
        page.setRotation(degrees((rotate + p.rot) % 360));
        off = [-view[0], -view[1]];
      }
    } else {
      page = out.addPage([p.w, p.h]);
      if (p.image) page.drawImage(await embed(p.image), { x: 0, y: 0, width: p.w, height: p.h });
      page.setRotation(degrees(p.rot % 360));
    }

    const X = (x) => x + off[0];
    const Y = (y) => y + off[1];
    for (const a of p.annots) {
      if (a.type === 'ink' && a.pts.length) {
        const path = a.pts.map(([x, y], i) => `${i ? 'L' : 'M'}${X(x).toFixed(2)} ${(-Y(y)).toFixed(2)}`).join(' ') + (a.pts.length === 1 ? ' l0.01 0' : '');
        page.drawSvgPath(path, {
          x: 0, y: 0,
          borderColor: rgb(...hexToRgb(a.color)),
          borderWidth: a.width,
          borderOpacity: a.opacity ?? 1,
          borderLineCap: LineCapStyle.Round,
          blendMode: a.opacity < 1 ? BlendMode.Multiply : undefined,
        });
      } else if (a.type === 'rect') {
        page.drawRectangle({
          x: X(Math.min(a.x1, a.x2)), y: Y(Math.min(a.y1, a.y2)),
          width: Math.abs(a.x2 - a.x1), height: Math.abs(a.y2 - a.y1),
          color: rgb(...hexToRgb(a.color)), opacity: a.opacity ?? 1,
        });
      } else if (a.type === 'text') {
        const [dx, dy] = DOWN[a.rot];
        let encodable = true;
        try { font.encodeText(a.text); } catch { encodable = false; }
        if (encodable) {
          a.text.split('\n').forEach((line, i) => {
            const drop = a.size * ASCENT + i * a.size * LINE;
            page.drawText(line, {
              x: X(a.x + dx * drop), y: Y(a.y + dy * drop),
              size: a.size, font, color: rgb(...hexToRgb(a.color)), rotate: degrees(a.rot),
            });
          });
        } else {
          const img = textToPng(a.text, a.size, a.color);
          page.drawImage(await embed(img.url), { x: X(a.x + dx * img.h), y: Y(a.y + dy * img.h), width: img.w, height: img.h, rotate: degrees(a.rot) });
        }
      } else if (a.type === 'image') {
        const [dx, dy] = DOWN[a.rot];
        page.drawImage(await embed(a.src), { x: X(a.x + dx * a.h), y: Y(a.y + dy * a.h), width: a.w, height: a.h, rotate: degrees(a.rot) });
      }
    }
  }
  return new Blob([await out.save()], { type: 'application/pdf' });
}

// ---------- Signature pad ----------
const SIG_KEY = 'plain-office-signatures';
function savedSignatures() {
  try { return JSON.parse(localStorage.getItem(SIG_KEY)) || []; } catch { return []; }
}
function rememberSignature(url) {
  try { localStorage.setItem(SIG_KEY, JSON.stringify([url, ...savedSignatures().filter((s) => s !== url)].slice(0, 4))); } catch { /* private mode */ }
}

function drawSignature() {
  return customDialog('Draw your signature', (box, close) => {
    const canvas = h('canvas', { class: 'sigpad' });
    let color = '#1a1a8c';
    let ctx;
    let drawing = false;
    let inked = false;
    const size = () => {
      const r = canvas.getBoundingClientRect();
      canvas.width = r.width * 2;
      canvas.height = r.height * 2;
      ctx = canvas.getContext('2d');
      ctx.scale(2, 2);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 2.6;
    };
    const pos = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    canvas.addEventListener('pointerdown', (e) => { drawing = true; inked = true; canvas.setPointerCapture(e.pointerId); ctx.strokeStyle = color; ctx.beginPath(); ctx.moveTo(...pos(e)); ctx.lineTo(...pos(e)); ctx.stroke(); });
    canvas.addEventListener('pointermove', (e) => { if (!drawing) return; ctx.lineTo(...pos(e)); ctx.stroke(); });
    canvas.addEventListener('pointerup', () => { drawing = false; });
    const crop = () => {
      const { width, height } = canvas;
      const px = ctx.getImageData(0, 0, width, height).data;
      let [minX, minY, maxX, maxY] = [width, height, 0, 0];
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        if (px[(y * width + x) * 4 + 3] > 10) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
      }
      const out = document.createElement('canvas');
      out.width = maxX - minX + 12;
      out.height = maxY - minY + 12;
      out.getContext('2d').drawImage(canvas, minX - 6, minY - 6, out.width, out.height, 0, 0, out.width, out.height);
      return out.toDataURL('image/png');
    };
    const swatch = (c) => h('button', { class: 'swatch', style: { background: c, width: '28px' }, 'aria-label': c, onClick: () => { color = c; } });
    box.append(canvas,
      h('div', { style: { display: 'flex', gap: '10px', marginTop: '10px', alignItems: 'center' } }, swatch('#1a1a8c'), swatch('#000000'), swatch('#d93a3a'),
        h('span', { style: { flex: 1 } }), h('button', { class: 'btn', onClick: () => { ctx.clearRect(0, 0, canvas.width, canvas.height); inked = false; } }, 'Clear')),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onClick: () => close(null) }, 'Cancel'),
        h('button', { class: 'btn primary', onClick: () => (inked ? close(crop()) : toast('Draw your signature first')) }, 'Use signature')));
    requestAnimationFrame(size);
  });
}

// ---------- Editor ----------
export async function open(doc, root, onExit) {
  const data = doc.data;
  data.passwords ??= {};
  const pdfs = {};
  let tool = 'hand';
  let zoom = 1;
  let selected = null; // { page, annot }
  let pagesMode = false;
  const pen = { color: '#d93a3a', width: 2.5 };
  const marker = { color: '#ffd400', width: 14 };
  const textStyle = { color: '#000000', size: 14 };
  const history = [];

  const save = debounce(() => persist(doc), 500);
  const pagesJson = () => JSON.stringify(data.pages);
  function snapshot() {
    history.push(pagesJson());
    if (history.length > 50) history.shift();
  }
  function undo() {
    if (!history.length) return toast('Nothing to undo');
    data.pages = JSON.parse(history.pop());
    selected = null;
    rebuild();
    save();
  }

  async function pdfFor(sid) {
    pdfs[sid] ??= pdfjs.getDocument({ data: data.sources[sid].slice(), password: data.passwords[sid], isEvalSupported: false }).promise
      .catch(async (err) => {
        if (err?.name !== 'PasswordException') throw err;
        const opened = await openPdf(data.sources[sid]);
        data.passwords[sid] = opened.openedWith;
        return opened;
      });
    return pdfs[sid];
  }

  // Info about a page's size and box (cached).
  const infoCache = new Map();
  async function pageInfo(p) {
    const key = p.src ? `${p.src}:${p.index}` : p.id;
    if (!infoCache.has(key)) {
      if (p.src) {
        const page = await (await pdfFor(p.src)).getPage(p.index + 1);
        infoCache.set(key, { view: page.view, rotate: page.rotate, page });
      } else {
        infoCache.set(key, { view: [0, 0, p.w, p.h], rotate: 0 });
      }
    }
    return infoCache.get(key);
  }
  const rotationOf = (info, p) => (info.rotate + p.rot) % 360;

  async function rasterize(p) {
    const info = await pageInfo(p);
    const vp = info.page.getViewport({ scale: 2, rotation: 0 });
    const canvas = document.createElement('canvas');
    canvas.width = vp.width;
    canvas.height = vp.height;
    await info.page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    return { url: canvas.toDataURL('image/jpeg', 0.9), view: info.view, rotate: info.rotate };
  }

  // ---- Page views ----
  const scroller = h('div', { class: 'pdf-scroll' });
  const views = new Map(); // page id -> view state
  let observer;

  function baseScale(info, p) {
    const vp = makeViewport(info.view, 1, rotationOf(info, p));
    const avail = Math.min(scroller.clientWidth || window.innerWidth, 900) - 24;
    return avail / vp.width;
  }

  async function rebuild() {
    observer?.disconnect();
    for (const v of views.values()) v.cancel?.();
    views.clear();
    scroller.replaceChildren();
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const v = views.get(entry.target.dataset.id);
        if (!v) continue;
        if (entry.isIntersecting) v.render();
        else v.release();
      }
    }, { root: scroller, rootMargin: '600px 0px' });

    for (let i = 0; i < data.pages.length; i++) {
      const p = data.pages[i];
      const info = await pageInfo(p);
      const scale = baseScale(info, p) * zoom;
      const vp = makeViewport(info.view, scale, rotationOf(info, p));
      const box = h('div', { class: 'pdf-page', 'data-id': p.id, style: { width: `${vp.width}px`, height: `${vp.height}px` } });
      const overlay = h('div', { class: 'overlay' });
      box.append(overlay, h('div', { class: 'pnum' }, `${i + 1} / ${data.pages.length}`));
      const view = { p, info, vp, box, overlay, rendered: false, task: null };
      view.render = () => renderPage(view);
      view.release = () => {
        view.task?.cancel?.();
        box.querySelector('.render')?.remove();
        view.rendered = false;
      };
      views.set(p.id, view);
      scroller.append(box);
      drawAnnots(view);
      observer.observe(box);
    }
  }

  async function renderPage(view) {
    if (view.rendered) return;
    view.rendered = true;
    const { p, vp, box, info } = view;
    if (!p.src) {
      if (p.image) {
        // Map the picture onto the page with the same transform as annotations.
        const img = h('img', { class: 'render', src: p.image, alt: '' });
        const [ax, ay] = vp.toView(0, p.h);
        const [bx, by] = vp.toView(1, p.h);
        const [cx, cy] = vp.toView(0, p.h - 1);
        Object.assign(img.style, { inset: 'auto', left: '0', top: '0', width: `${p.w}px`, height: `${p.h}px`, transformOrigin: '0 0', transform: `matrix(${bx - ax},${by - ay},${cx - ax},${cy - ay},${ax},${ay})` });
        box.prepend(img);
      }
      return;
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const pdfVp = info.page.getViewport({ scale: vp.scale * dpr, rotation: rotationOf(info, p) });
    const canvas = h('canvas', { class: 'render' });
    canvas.width = Math.floor(pdfVp.width);
    canvas.height = Math.floor(pdfVp.height);
    box.prepend(canvas);
    view.task = info.page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: pdfVp });
    try { await view.task.promise; } catch { /* cancelled */ }
  }

  // ---- Annotation drawing ----
  const SVG = 'http://www.w3.org/2000/svg';
  function drawAnnots(view) {
    const { p, vp, overlay } = view;
    const svg = document.createElementNS(SVG, 'svg');
    const nodes = [svg];
    p.annots.forEach((a, idx) => {
      if (a.type === 'ink') {
        const path = document.createElementNS(SVG, 'path');
        path.setAttribute('d', a.pts.map((pt, i) => `${i ? 'L' : 'M'}${vp.toView(...pt).map((n) => n.toFixed(1)).join(' ')}`).join(' ') + (a.pts.length === 1 ? ' l0.1 0' : ''));
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', a.color);
        path.setAttribute('stroke-width', a.width * vp.scale);
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('stroke-linejoin', 'round');
        path.setAttribute('opacity', a.opacity ?? 1);
        if (a.opacity < 1) path.style.mixBlendMode = 'multiply';
        path.dataset.idx = idx;
        svg.append(path);
      } else if (a.type === 'rect') {
        const [x1, y1] = vp.toView(a.x1, a.y1);
        const [x2, y2] = vp.toView(a.x2, a.y2);
        const rect = document.createElementNS(SVG, 'rect');
        rect.setAttribute('x', Math.min(x1, x2));
        rect.setAttribute('y', Math.min(y1, y2));
        rect.setAttribute('width', Math.abs(x2 - x1));
        rect.setAttribute('height', Math.abs(y2 - y1));
        rect.setAttribute('fill', a.color);
        rect.setAttribute('opacity', a.opacity ?? 1);
        if (a.color === '#ffffff') { rect.setAttribute('stroke', '#d0d4da'); rect.setAttribute('stroke-width', '0.5'); rect.setAttribute('stroke-dasharray', '3 3'); }
        rect.dataset.idx = idx;
        svg.append(rect);
      } else {
        const [x, y] = vp.toView(a.x, a.y);
        const turn = (vp.rotation - a.rot + 360) % 360;
        const node = a.type === 'text'
          ? h('div', { class: 'annot', style: { fontSize: `${a.size * vp.scale}px`, lineHeight: LINE, color: a.color, fontFamily: 'Helvetica, Arial, sans-serif' } }, a.text)
          : h('div', { class: 'annot', style: { width: `${a.w * vp.scale}px`, height: `${a.h * vp.scale}px` } }, h('img', { src: a.src, alt: '' }));
        Object.assign(node.style, { left: `${x}px`, top: `${y}px`, transformOrigin: '0 0', transform: `rotate(${turn}deg)` });
        node.dataset.idx = idx;
        if (selected?.annot === a) {
          node.classList.add('sel');
          node.append(h('div', { class: 'handle', 'data-handle': '1' }));
        }
        nodes.push(node);
      }
    });
    overlay.replaceChildren(...nodes);
    const interactive = tool === 'hand' || tool === 'eraser';
    svg.querySelectorAll('[data-idx]').forEach((n) => { n.style.pointerEvents = tool === 'eraser' ? 'visiblePainted' : 'none'; });
    overlay.querySelectorAll('.annot').forEach((n) => { n.style.pointerEvents = interactive ? 'auto' : 'none'; });
    overlay.style.touchAction = tool === 'hand' ? 'auto' : 'none';
  }
  const redraw = (p) => { const v = views.get(p.id); if (v) drawAnnots(v); };
  const redrawAll = () => views.forEach(drawAnnots);

  // ---- Pointer interactions ----
  let gesture = null;
  scroller.addEventListener('pointerdown', async (e) => {
    const box = e.target.closest('.pdf-page');
    if (!box) { if (selected) { selected = null; redrawAll(); } return; }
    const view = views.get(box.dataset.id);
    const rect = box.getBoundingClientRect();
    const vx = e.clientX - rect.left;
    const vy = e.clientY - rect.top;
    const { p, vp } = view;
    const target = e.target.closest('[data-idx]');

    if (tool === 'eraser') {
      if (target) {
        snapshot();
        p.annots.splice(Number(target.dataset.idx), 1);
        redraw(p);
        save();
      }
      return;
    }

    if (tool === 'hand') {
      if (!target) { if (selected) { selected = null; redrawAll(); } return; }
      const annot = p.annots[Number(target.dataset.idx)];
      const wasSelected = selected?.annot === annot;
      if (!wasSelected) { selected = { p, annot }; redrawAll(); }
      e.preventDefault();
      box.setPointerCapture(e.pointerId);
      gesture = { kind: e.target.dataset.handle ? 'resize' : 'move', view, annot, sx: e.clientX, sy: e.clientY, start: { ...annot }, moved: false, wasSelected };
      return;
    }

    e.preventDefault();
    box.setPointerCapture(e.pointerId);
    const [ux, uy] = vp.toUser(vx, vy);
    if (tool === 'pen' || tool === 'marker') {
      const style = tool === 'pen' ? pen : marker;
      snapshot();
      const annot = { type: 'ink', pts: [[ux, uy]], color: style.color, width: style.width, opacity: tool === 'marker' ? 0.4 : 1 };
      p.annots.push(annot);
      gesture = { kind: 'ink', view, annot };
      redraw(p);
    } else if (tool === 'whiteout') {
      snapshot();
      const annot = { type: 'rect', x1: ux, y1: uy, x2: ux, y2: uy, color: '#ffffff', opacity: 1 };
      p.annots.push(annot);
      gesture = { kind: 'rect', view, annot };
    } else if (tool === 'text') {
      const value = await askText('Add text', { multiline: true, placeholder: 'Type here', ok: 'Add' });
      if (!value?.trim()) return;
      snapshot();
      const rot = vp.rotation;
      const [tx, ty] = vp.toUser(vx, vy - textStyle.size * vp.scale * 0.6);
      const annot = { type: 'text', x: tx, y: ty, text: value, size: textStyle.size, color: textStyle.color, rot };
      p.annots.push(annot);
      selected = { p, annot };
      setTool('hand');
      save();
    }
  });

  scroller.addEventListener('pointermove', (e) => {
    if (!gesture) return;
    const { view, annot } = gesture;
    const rect = view.box.getBoundingClientRect();
    const [ux, uy] = view.vp.toUser(e.clientX - rect.left, e.clientY - rect.top);
    if (gesture.kind === 'ink') {
      const last = annot.pts[annot.pts.length - 1];
      if (Math.hypot(ux - last[0], uy - last[1]) * view.vp.scale > 1.5) annot.pts.push([ux, uy]);
      redraw(view.p);
    } else if (gesture.kind === 'rect') {
      annot.x2 = ux;
      annot.y2 = uy;
      redraw(view.p);
    } else {
      const dx = e.clientX - gesture.sx;
      const dy = e.clientY - gesture.sy;
      if (!gesture.moved && Math.hypot(dx, dy) < 6) return;
      if (!gesture.moved) { snapshot(); gesture.moved = true; }
      if (gesture.kind === 'move') {
        const [sx, sy] = view.vp.toView(gesture.start.x, gesture.start.y);
        [annot.x, annot.y] = view.vp.toUser(sx + dx, sy + dy);
      } else {
        // Resize along the annotation's own diagonal.
        const grow = (dx + dy) / 2 / view.vp.scale;
        if (annot.type === 'image') {
          const ratio = gesture.start.h / gesture.start.w;
          annot.w = Math.max(20, gesture.start.w + grow);
          annot.h = annot.w * ratio;
        } else {
          annot.size = Math.max(5, Math.min(120, gesture.start.size + grow / 3));
        }
      }
      redraw(view.p);
    }
  });

  scroller.addEventListener('pointerup', async () => {
    if (!gesture) return;
    const g = gesture;
    gesture = null;
    if (g.kind === 'rect' && Math.abs(g.annot.x2 - g.annot.x1) < 2 && Math.abs(g.annot.y2 - g.annot.y1) < 2) {
      g.view.p.annots.pop();
      history.pop();
      redraw(g.view.p);
      return toast('Drag across the area to cover');
    }
    if ((g.kind === 'move' || g.kind === 'resize') && !g.moved && g.wasSelected) {
      const a = g.annot;
      const value = await actionSheet(null, [
        a.type === 'text' ? { icon: 'edit', label: 'Edit text', value: 'edit' } : null,
        a.type === 'text' ? { icon: 'palette', label: 'Text color', value: 'color' } : null,
        { icon: 'trash', label: 'Delete', value: 'delete', danger: true },
      ]);
      if (value === 'edit') {
        const text = await askText('Edit text', { value: a.text, multiline: true, ok: 'Save' });
        if (text != null && text.trim()) { snapshot(); a.text = text; }
      } else if (value === 'color') {
        const color = await pickColor('Text color');
        if (color) { snapshot(); a.color = color; }
      } else if (value === 'delete') {
        snapshot();
        g.view.p.annots.splice(g.view.p.annots.indexOf(a), 1);
        selected = null;
      }
      redrawAll();
    }
    save();
  });

  // ---- Tools ----
  const toolButtons = {};
  function setTool(name) {
    tool = name;
    if (name !== 'hand') selected = null;
    for (const [key, btn] of Object.entries(toolButtons)) btn.classList.toggle('on', key === name);
    scroller.classList.toggle('drawing', name !== 'hand');
    redrawAll();
  }

  async function chooseTool(name) {
    if (tool === name && (name === 'pen' || name === 'marker' || name === 'text')) {
      const style = name === 'pen' ? pen : name === 'marker' ? marker : textStyle;
      const value = await actionSheet(name === 'text' ? 'Text style' : name === 'pen' ? 'Pen' : 'Highlighter', [
        { icon: 'palette', label: 'Color', value: 'color' },
        ...(name === 'text'
          ? [['Small', 10], ['Normal', 14], ['Large', 20], ['Huge', 32]].map(([label, size]) => ({ label: `${style.size === size ? '✓ ' : ''}${label}`, value: `s${size}` }))
          : (name === 'pen' ? [['Fine', 1.2], ['Medium', 2.5], ['Thick', 5]] : [['Narrow', 8], ['Medium', 14], ['Wide', 22]])
            .map(([label, w]) => ({ label: `${style.width === w ? '✓ ' : ''}${label}`, value: `w${w}` }))),
      ]);
      if (value === 'color') {
        const color = await pickColor('Color');
        if (color) style.color = color;
      } else if (value?.startsWith('s')) style.size = Number(value.slice(1));
      else if (value?.startsWith('w')) style.width = Number(value.slice(1));
      return;
    }
    setTool(name);
    const hints = {
      pen: 'Draw with your finger. Tap Pen again for color and size.',
      marker: 'Swipe over text to highlight it',
      text: 'Tap where you want to type. Tap Text again for size and color.',
      whiteout: 'Drag over anything you want to cover with white',
      eraser: 'Tap a mark to remove it',
    };
    if (hints[name]) toast(hints[name]);
  }

  function visiblePage() {
    const mid = scroller.getBoundingClientRect().top + scroller.clientHeight / 2;
    let best = null;
    for (const v of views.values()) {
      const r = v.box.getBoundingClientRect();
      if (r.top <= mid && r.bottom >= mid) return v;
      if (!best || Math.abs(r.top - mid) < Math.abs(best.box.getBoundingClientRect().top - mid)) best = v;
    }
    return best;
  }

  async function sign() {
    const saved = savedSignatures();
    let url;
    if (saved.length) {
      url = await actionSheet('Signature', [
        ...saved.map((s) => ({ node: h('button', { class: 'sheet-item', onClick: (e) => { e.currentTarget.closest('.action-sheet').closeSheet(s); } }, h('img', { src: s, alt: 'Saved signature', style: { height: '44px', background: '#fff', borderRadius: '6px', padding: '4px' } })) })),
        { icon: 'pen', label: 'Draw a new signature', value: 'new' },
      ]);
      if (!url) return;
    }
    if (!url || url === 'new') {
      url = await drawSignature();
      if (!url) return;
      rememberSignature(url);
    }
    placeImage(url, 160);
  }

  async function placeImage(url, width) {
    const view = visiblePage();
    if (!view) return;
    const img = new Image();
    img.src = url;
    await img.decode();
    const { p, vp } = view;
    const w = width;
    const hgt = (w * img.naturalHeight) / img.naturalWidth;
    const sr = view.box.getBoundingClientRect();
    const scr = scroller.getBoundingClientRect();
    const cx = Math.min(Math.max(scr.left + scr.width / 2 - sr.left, 0), vp.width) - (w * vp.scale) / 2;
    const cy = Math.min(Math.max(scr.top + scr.height / 2 - sr.top, 0), vp.height) - (hgt * vp.scale) / 2;
    const [x, y] = vp.toUser(cx, cy);
    snapshot();
    const annot = { type: 'image', src: url, x, y, w, h: hgt, rot: vp.rotation };
    p.annots.push(annot);
    selected = { p, annot };
    setTool('hand');
    save();
    toast('Drag to move it. Use the round handle to resize.');
  }

  async function insertPicture() {
    const [file] = await pickFiles('image/*');
    if (!file) return;
    placeImage(await shrinkImage(file, 1400), 200);
  }

  function setZoom(next) {
    zoom = Math.max(0.5, Math.min(3, next));
    const anchor = scroller.scrollTop / Math.max(1, scroller.scrollHeight);
    rebuild().then(() => { scroller.scrollTop = anchor * scroller.scrollHeight; });
    toast(`${Math.round(zoom * 100)}%`);
  }

  // ---- Pages view: rotate, delete, reorder, add ----
  const grid = h('div', { class: 'pages-grid' });
  async function renderGrid() {
    grid.replaceChildren();
    for (let i = 0; i < data.pages.length; i++) {
      const p = data.pages[i];
      const info = await pageInfo(p);
      const pv = h('div', { class: 'pv' });
      const card = h('div', { class: 'page-card' }, pv, h('div', { class: 'lbl' }, `Page ${i + 1}`),
        h('div', { class: 'acts' },
          iconBtn('left', 'Move earlier', () => movePage(i, -1), { disabled: i === 0 }),
          iconBtn('rotate', 'Rotate', () => rotatePage(i)),
          iconBtn('trash', 'Delete page', () => deletePage(i)),
          iconBtn('right', 'Move later', () => movePage(i, 1), { disabled: i === data.pages.length - 1 })));
      grid.append(card);
      const rot = rotationOf(info, p);
      if (p.src) {
        const vp = info.page.getViewport({ scale: 150 / Math.max(info.view[2] - info.view[0], info.view[3] - info.view[1]), rotation: rot });
        const canvas = h('canvas', { width: Math.floor(vp.width), height: Math.floor(vp.height) });
        pv.append(canvas);
        info.page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: vp });
      } else if (p.image) {
        pv.append(h('img', { src: p.image, alt: '', style: { transform: `rotate(${rot}deg)` } }));
      } else {
        pv.append(h('div', { style: { width: rot % 180 ? '84px' : '60px', height: rot % 180 ? '60px' : '84px', background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,.2)' } }));
      }
    }
  }
  function changedPages() { save(); renderGrid(); }
  function movePage(i, d) { snapshot(); const [p] = data.pages.splice(i, 1); data.pages.splice(i + d, 0, p); changedPages(); }
  function rotatePage(i) { snapshot(); data.pages[i].rot = (data.pages[i].rot + 90) % 360; changedPages(); }
  async function deletePage(i) {
    if (data.pages.length === 1) return toast('A PDF needs at least one page');
    if (!await confirmBox(`Delete page ${i + 1}?`, null, { ok: 'Delete', danger: true })) return;
    snapshot();
    data.pages.splice(i, 1);
    changedPages();
  }
  async function addPages() {
    const value = await actionSheet('Add pages at the end', [
      { icon: 'file', label: 'Blank page', value: 'blank' },
      { icon: 'merge', label: 'Pages from another PDF', value: 'pdf' },
      { icon: 'image', label: 'Photos as pages', value: 'image' },
    ]);
    if (!value) return;
    if (value === 'blank') {
      snapshot();
      data.pages.push({ id: newId(), blank: true, w: A4[0], h: A4[1], rot: 0, annots: [] });
      return changedPages();
    }
    const files = await pickFiles(value === 'pdf' ? '.pdf,application/pdf' : 'image/*', true);
    if (!files.length) return;
    snapshot();
    try {
      const n = await busy('Adding…', async () => {
        let total = 0;
        for (const f of files) total += await appendFile(data, await readBytes(f), f.name);
        return total;
      });
      toast(`Added ${n} page${n === 1 ? '' : 's'}`);
    } catch (err) {
      history.pop();
      toast(err.message);
    }
    changedPages();
  }

  const gridBar = h('div', { class: 'toolbar' },
    h('button', { class: 'tb-text', onClick: addPages }, icon('plus'), 'Add pages'),
    h('span', { style: { flex: 1 } }),
    h('button', { class: 'tb-text', onClick: () => togglePages(false) }, icon('check'), 'Done'));

  function togglePages(on) {
    pagesMode = on;
    if (on) {
      scroller.replaceWith(grid);
      toolbar.replaceWith(gridBar);
      renderGrid();
    } else {
      grid.replaceWith(scroller);
      gridBar.replaceWith(toolbar);
      rebuild();
    }
  }

  // ---- Export ----
  async function exportPdf() {
    save.flush();
    try {
      await busy('Saving PDF…', async () => exportFile(await buildPdf(data, rasterize), `${doc.name}.pdf`));
    } catch (err) {
      console.error(err);
      toast('Could not save: ' + (err.message || err));
    }
  }

  async function moreMenu() {
    const value = await actionSheet(null, [
      { icon: 'pages', label: 'Pages: rotate, delete, reorder', value: 'pages' },
      { icon: 'merge', label: 'Add pages / combine PDFs', value: 'add' },
      { icon: 'image', label: 'Insert a picture or stamp', value: 'picture' },
      { icon: 'zoomIn', label: 'Zoom in', value: 'in' },
      { icon: 'zoomOut', label: 'Zoom out', value: 'out' },
      { icon: 'share', label: 'Save a copy / share', value: 'export' },
    ]);
    if (value === 'pages') togglePages(true);
    if (value === 'add') { togglePages(true); addPages(); }
    if (value === 'picture') insertPicture();
    if (value === 'in') setZoom(zoom * 1.25);
    if (value === 'out') setZoom(zoom / 1.25);
    if (value === 'export') exportPdf();
  }

  const toolBtn = (key, iconName, label) => {
    const btn = h('button', { class: 'tb-text tool', 'aria-label': label, onClick: () => chooseTool(key) }, icon(iconName), label);
    toolButtons[key] = btn;
    return btn;
  };
  const sep = () => h('span', { class: 'sep' });
  const toolbar = h('nav', { class: 'toolbar', 'aria-label': 'PDF tools' },
    toolBtn('hand', 'hand', 'Select'),
    toolBtn('text', 'type', 'Text'),
    toolBtn('pen', 'pen', 'Pen'),
    toolBtn('marker', 'highlight', 'Highlight'),
    toolBtn('whiteout', 'square', 'White-out'),
    h('button', { class: 'tb-text', onClick: sign }, icon('sign'), 'Sign'),
    toolBtn('eraser', 'eraser', 'Erase'),
    sep(),
    h('button', { class: 'tb-text', onClick: () => togglePages(true) }, icon('pages'), 'Pages'),
  );

  async function close() {
    save.flush();
    observer?.disconnect();
    window.removeEventListener('resize', onResize);
    Object.values(pdfs).forEach((pr) => pr.then((d) => d.loadingTask.destroy()).catch(() => {}));
    onExit();
  }

  const bar = topBar(doc, {
    onBack: close,
    buttons: [
      iconBtn('undo', 'Undo', undo),
      iconBtn('share', 'Save a copy / share', exportPdf),
      iconBtn('more', 'More', moreMenu),
    ],
  });

  const onResize = debounce(() => { if (!pagesMode) rebuild(); }, 250);
  window.addEventListener('resize', onResize);

  root.append(bar, scroller, toolbar);
  setTool('hand');
  try {
    await rebuild();
  } catch (err) {
    console.error(err);
    toast('Could not read this PDF');
  }
  return close;
}
