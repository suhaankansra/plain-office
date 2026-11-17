// PDF: view and edit PDFs. Add text, draw, highlight, white-out, sign,
// rotate / delete / reorder pages, and combine files.
//
// Edits are stored separately from the original file, so nothing is lost
// until you export. Annotations are kept in each page's own PDF coordinate
// space, which keeps them in place when a page is rotated.

import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { h, icon, iconBtn, toast, busy, progressBox, actionSheet, askText, pickColor, confirmBox, customDialog, debounce, escapeHtml, formatSize } from '../ui.js';
import { exportFile, pickFiles, readBytes, extOf } from '../files.js';
import { saveDoc, newId as newDocId, estimateSize } from '../store.js';
import { wordsToPdf } from '../ocr.js';
import { topBar, persist } from './shell.js';
import { canMakePages } from '../platform.js';
import { shrinkImage } from './docs.js';
import * as tools from './pdf-tools.js';
import { renderOnWhite } from './render-white.js';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const A4 = [595.28, 841.89];
let counter = 0;
const newId = (p = 'p') => `${p}${Date.now().toString(36)}${(counter++).toString(36)}`;
const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', jpe: 'image/jpeg', jxl: 'image/jxl', ico: 'image/x-icon', webp: 'image/webp', gif: 'image/gif', heic: 'image/heic', heif: 'image/heif', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', avif: 'image/avif', svg: 'image/svg+xml' };
const isImageName = (name) => extOf(name) in IMAGE_MIME;

// ---------- Building documents ----------
async function imagePage(bytes, name) {
  const mime = IMAGE_MIME[extOf(name)] || 'image/jpeg';
  let src;
  try {
    src = await shrinkImage(new Blob([bytes], { type: mime }), 2200);
  } catch {
    throw new Error(`This phone can't display .${extOf(name)} pictures`);
  }
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

// Scanned pages -> a PDF made of picture pages. Each item is a JPEG data URL,
// or { url, words } when text recognition ran, which makes the page searchable.
export async function fromImageUrls(items) {
  const pages = [];
  for (const item of items) {
    const { url, words } = typeof item === 'string' ? { url: item } : item;
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = A4[0];
    const hgt = Math.round((w * img.naturalHeight) / img.naturalWidth);
    const k = w / img.naturalWidth;
    const page = { id: newId(), image: url, w, h: hgt, rot: 0, annots: [] };
    if (words?.length) page.ocr = wordsToPdf(words, (x, y) => [x * k, hgt - y * k], k);
    pages.push(page);
  }
  return { sources: {}, passwords: {}, pages };
}

export function create() {
  return { sources: {}, passwords: {}, pages: [{ id: newId(), blank: true, w: A4[0], h: A4[1], rot: 0, annots: [] }] };
}

export async function importFile(bytes, name) {
  if (extOf(name) === 'cbz') {
    // Comic book archive: a zip of page pictures.
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(bytes);
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir && !/(^|\/)(__MACOSX|\.)/.test(n) && isImageName(n))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (!names.length) throw new Error('No pictures found in this comic');
    const files = await Promise.all(names.map((n) => zip.file(n).async('uint8array')));
    return fromFiles(files, names);
  }
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
// opts: { flatten: { scale, quality } turns every page into a picture (smaller files),
//         password, restrict (block copying and changes), title }
// Pages with redactions are always turned into pictures, so the covered text is really gone.
export async function buildPdf(data, rasterize, opts = {}) {
  const lib = await import('@cantoo/pdf-lib');
  const { PDFDocument, StandardFonts, rgb, degrees, LineCapStyle, BlendMode, pushGraphicsState, popGraphicsState, setTextRenderingMode, TextRenderingMode } = lib;
  const out = await PDFDocument.create();
  const font = await out.embedFont(StandardFonts.Helvetica);
  const loaded = {};
  const images = new Map();
  const embed = async (url) => {
    if (!images.has(url)) images.set(url, url.startsWith('data:image/png') ? await out.embedPng(dataUrlBytes(url)) : await out.embedJpg(dataUrlBytes(url)));
    return images.get(url);
  };
  const total = data.pages.length;

  for (let pi = 0; pi < total; pi++) {
    const p = data.pages[pi];
    let page;
    let off = [0, 0];
    const redactions = p.annots.filter((a) => a.type === 'redact')
      .map((a) => [Math.min(a.x1, a.x2), Math.min(a.y1, a.y2), Math.max(a.x1, a.x2), Math.max(a.y1, a.y2)]);
    const flat = opts.flatten || (redactions.length ? { scale: 2.5, quality: 0.9 } : null);
    if (p.src && !(p.src in loaded)) {
      try {
        const doc = await PDFDocument.load(data.sources[p.src], { updateMetadata: false, password: data.passwords?.[p.src] });
        loaded[p.src] = doc.isEncrypted ? null : doc;
      } catch {
        loaded[p.src] = null;
      }
    }
    let rasterized = false;
    if (p.src && loaded[p.src] && !flat) {
      [page] = await out.copyPages(loaded[p.src], [p.index]);
      out.addPage(page);
      page.setRotation(degrees((page.getRotation().angle + p.rot) % 360));
    } else if (p.src || (flat && (p.image || p.ocr?.length))) {
      // A picture of the page, with its text kept (invisibly) unless it was redacted.
      const r = await rasterize(p, { ...(flat || {}), boxes: redactions });
      const w = r.view[2] - r.view[0];
      const hh = r.view[3] - r.view[1];
      page = out.addPage([w, hh]);
      page.drawImage(await embed(r.url), { x: 0, y: 0, width: w, height: hh });
      page.setRotation(degrees((r.rotate + p.rot) % 360));
      off = [-r.view[0], -r.view[1]];
      tools.drawInvisibleText(page, r.runs, font, lib, (x) => x + off[0], (y) => y + off[1]);
      rasterized = true;
    } else {
      page = out.addPage([p.w, p.h]);
      if (p.image) page.drawImage(await embed(p.image), { x: 0, y: 0, width: p.w, height: p.h });
      page.setRotation(degrees(p.rot % 360));
    }

    const X = (x) => x + off[0];
    const Y = (y) => y + off[1];
    if (p.ocr?.length && !rasterized) {
      // Recognised words as invisible text: the page looks the same but can be searched and copied.
      page.pushOperators(pushGraphicsState(), setTextRenderingMode(TextRenderingMode.Invisible));
      for (const word of p.ocr) {
        let text = word.t;
        try { font.encodeText(text); } catch { text = text.replace(/[^\x20-\x7e\xa0-\xff]/g, ''); }
        if (!text) continue;
        const size = Math.max(1, Math.min(word.w / (font.widthOfTextAtSize(text, 1) || 1), word.h * 1.6));
        const [ux, uy] = DOWN[word.rot || 0];
        page.drawText(text, { x: X(word.x - ux * word.h * 0.2), y: Y(word.y - uy * word.h * 0.2), size, font, rotate: degrees(word.rot || 0) });
      }
      page.pushOperators(popGraphicsState());
    }
    const underRedaction = (x, y) => redactions.some((b) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3]);
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
      } else if (a.type === 'shape') {
        const color = rgb(...hexToRgb(a.color));
        const x1 = X(a.x1); const y1 = Y(a.y1); const x2 = X(a.x2); const y2 = Y(a.y2);
        if (a.shape === 'rect') {
          page.drawRectangle({ x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1), borderColor: color, borderWidth: a.width });
        } else if (a.shape === 'ellipse') {
          page.drawEllipse({ x: (x1 + x2) / 2, y: (y1 + y2) / 2, xScale: Math.abs(x2 - x1) / 2, yScale: Math.abs(y2 - y1) / 2, borderColor: color, borderWidth: a.width });
        } else {
          for (const [sx, sy, ex, ey] of shapeLines(a, x1, y1, x2, y2)) {
            page.drawLine({ start: { x: sx, y: sy }, end: { x: ex, y: ey }, thickness: a.width, color, lineCap: LineCapStyle.Round });
          }
        }
      } else if (a.type === 'note') {
        tools.addNoteAnnotation(out, page, lib, a, X, Y);
      } else if (a.type === 'text') {
        if (underRedaction(a.x, a.y)) continue;
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
    for (const [x1, y1, x2, y2] of redactions) {
      page.drawRectangle({ x: X(x1), y: Y(y1), width: x2 - x1, height: y2 - y1, color: rgb(0, 0, 0) });
    }

    // Header, footer and watermark, upright as the page is shown.
    if (data.marks) {
      const box = page.getCropBox();
      const R = page.getRotation().angle % 360;
      const vp = makeViewport([box.x, box.y, box.x + box.width, box.y + box.height], 1, R);
      const marks = tools.layoutMarks(data.marks, { width: vp.width, height: vp.height }, pi + 1, total, data.meta?.title || opts.title,
        (t, s) => font.widthOfTextAtSize(tools.encodable(font, t), s));
      for (const m of marks) {
        const text = tools.encodable(font, m.text);
        if (!text.trim()) continue;
        const [ux, uy] = vp.toUser(m.x, m.y);
        page.drawText(text, { x: ux, y: uy, size: m.size, font, color: rgb(...hexToRgb(m.color)), opacity: m.opacity, rotate: degrees((R + m.angle) % 360) });
      }
    }
  }

  const meta = data.meta || {};
  out.setTitle(meta.title || opts.title || '');
  if (meta.author) out.setAuthor(meta.author);
  if (meta.subject) out.setSubject(meta.subject);
  if (meta.keywords) out.setKeywords(meta.keywords.split(',').map((k) => k.trim()).filter(Boolean));
  out.setCreator('Plain Office');
  out.setProducer('Plain Office');
  if (opts.password) {
    const owner = opts.restrict ? [...crypto.getRandomValues(new Uint8Array(18))].map((b) => b.toString(36)).join('') : opts.password;
    out.encrypt({
      userPassword: opts.password,
      ownerPassword: owner,
      permissions: opts.restrict
        ? { printing: 'highResolution', modifying: false, copying: false, annotating: false, fillingForms: true, contentAccessibility: true, documentAssembly: false }
        : { printing: 'highResolution', modifying: true, copying: true, annotating: true, fillingForms: true, contentAccessibility: true, documentAssembly: true },
    });
  }
  return new Blob([await out.save()], { type: 'application/pdf' });
}

// Lines that make up a line or arrow shape (from x1,y1 to x2,y2).
function shapeLines(a, x1, y1, x2, y2) {
  const lines = [[x1, y1, x2, y2]];
  if (a.shape === 'arrow') {
    const ang = Math.atan2(y2 - y1, x2 - x1);
    const len = Math.max(8, a.width * 4.5);
    for (const d of [Math.PI * 0.82, -Math.PI * 0.82]) lines.push([x2, y2, x2 + Math.cos(ang + d) * len, y2 + Math.sin(ang + d) * len]);
  }
  return lines;
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
export async function open(doc, root, onExit, opts = {}) {
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
  const shapeStyle = { shape: 'rect', color: '#d93a3a', width: 2 };
  const history = [];
  const searchHits = new Map(); // page id -> [[quad, ...], ...]
  let searchCurrent = null; // { page, index }


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

  // A picture of a page as it is now (without this editor's marks), plus its
  // text so it stays searchable. boxes: areas to black out (redactions).
  async function rasterize(p, { scale = 2, quality = 0.9, boxes = [] } = {}) {
    const { pageText, ocrText, textOutside } = tools;
    const info = await pageInfo(p);
    const [vx1, vy1, vx2, vy2] = info.view;
    let canvas;
    let runs = ocrText(p.ocr);
    if (p.src) {
      canvas = await renderOnWhite(info.page, info.page.getViewport({ scale, rotation: 0 }));
      try { runs = [...await pageText(info.page), ...runs]; } catch { /* no text layer */ }
    } else {
      canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor((vx2 - vx1) * scale));
      canvas.height = Math.max(1, Math.floor((vy2 - vy1) * scale));
    }
    const ctx = canvas.getContext('2d');
    if (!p.src) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    if (!p.src && p.image) {
      const img = new Image();
      img.src = p.image;
      await img.decode();
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    }
    ctx.fillStyle = '#000';
    for (const [x1, y1, x2, y2] of boxes) ctx.fillRect((x1 - vx1) * scale, (vy2 - y2) * scale, (x2 - x1) * scale, (y2 - y1) * scale);
    const url = canvas.toDataURL('image/jpeg', quality);
    canvas.width = canvas.height = 0;
    return { url, view: info.view, rotate: info.rotate, runs: textOutside(runs, boxes) };
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
  const svgEl = (tag, attrs) => {
    const node = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  };
  let measureCtx;
  const measureText = (text, size) => {
    measureCtx ??= document.createElement('canvas').getContext('2d');
    measureCtx.font = `${size}px Helvetica, Arial, sans-serif`;
    return measureCtx.measureText(text).width;
  };
  function drawAnnots(view) {
    const { p, vp, overlay } = view;
    const svg = document.createElementNS(SVG, 'svg');
    const nodes = [svg];
    p.annots.forEach((a, idx) => {
      if (a.type === 'ink') {
        const path = svgEl('path', {
          d: a.pts.map((pt, i) => `${i ? 'L' : 'M'}${vp.toView(...pt).map((n) => n.toFixed(1)).join(' ')}`).join(' ') + (a.pts.length === 1 ? ' l0.1 0' : ''),
          fill: 'none', stroke: a.color, 'stroke-width': a.width * vp.scale, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: a.opacity ?? 1,
        });
        if (a.opacity < 1) path.style.mixBlendMode = 'multiply';
        path.dataset.idx = idx;
        svg.append(path);
      } else if (a.type === 'rect' || a.type === 'redact' || (a.type === 'shape' && (a.shape === 'rect' || a.shape === 'ellipse'))) {
        const [x1, y1] = vp.toView(a.x1, a.y1);
        const [x2, y2] = vp.toView(a.x2, a.y2);
        const box = { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
        let node;
        if (a.type === 'shape' && a.shape === 'ellipse') {
          node = svgEl('ellipse', { cx: box.x + box.w / 2, cy: box.y + box.h / 2, rx: box.w / 2, ry: box.h / 2, fill: 'none', stroke: a.color, 'stroke-width': a.width * vp.scale });
        } else if (a.type === 'shape') {
          node = svgEl('rect', { x: box.x, y: box.y, width: box.w, height: box.h, fill: 'none', stroke: a.color, 'stroke-width': a.width * vp.scale });
        } else if (a.type === 'redact') {
          node = svgEl('rect', { x: box.x, y: box.y, width: box.w, height: box.h, fill: '#000', opacity: 0.85, stroke: '#d93a3a', 'stroke-width': 1.5, 'stroke-dasharray': '4 3' });
        } else {
          node = svgEl('rect', { x: box.x, y: box.y, width: box.w, height: box.h, fill: a.color, opacity: a.opacity ?? 1 });
          if (a.color === '#ffffff') { node.setAttribute('stroke', '#d0d4da'); node.setAttribute('stroke-width', '0.5'); node.setAttribute('stroke-dasharray', '3 3'); }
        }
        node.dataset.idx = idx;
        svg.append(node);
      } else if (a.type === 'shape') {
        const [x1, y1] = vp.toView(a.x1, a.y1);
        const [x2, y2] = vp.toView(a.x2, a.y2);
        const g = svgEl('g', { stroke: a.color, 'stroke-width': a.width * vp.scale, 'stroke-linecap': 'round', fill: 'none' });
        for (const [sx, sy, ex, ey] of shapeLines(a, x1, y1, x2, y2)) g.append(svgEl('line', { x1: sx, y1: sy, x2: ex, y2: ey }));
        g.dataset.idx = idx;
        svg.append(g);
      } else if (a.type === 'note') {
        const [x, y] = vp.toView(a.x, a.y);
        const node = h('div', { class: 'annot note', style: { left: `${x}px`, top: `${y}px`, background: a.color || '#ffd400' }, title: a.text }, icon('notes'));
        node.dataset.idx = idx;
        if (selected?.annot === a) node.classList.add('sel');
        nodes.push(node);
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
    // Search results.
    for (const [hi, hit] of (searchHits.get(p.id) || []).entries()) {
      for (const quad of hit) {
        const pts = quad.map((pt) => vp.toView(...pt).map((n) => n.toFixed(1)).join(',')).join(' ');
        const current = searchCurrent && searchCurrent.page === p.id && searchCurrent.index === hi;
        svg.append(svgEl('polygon', { points: pts, class: `find-hit${current ? ' current' : ''}` }));
      }
    }
    // Header, footer and watermark preview.
    if (data.marks) {
      const n = data.pages.indexOf(p) + 1;
      for (const m of tools.layoutMarks(data.marks, { width: vp.width / vp.scale, height: vp.height / vp.scale }, n, data.pages.length, data.meta?.title || doc.name, measureText)) {
        nodes.push(h('div', {
          class: 'mark',
          style: { left: `${m.x * vp.scale}px`, top: `${m.y * vp.scale}px`, fontSize: `${m.size * vp.scale}px`, color: m.color, opacity: m.opacity, transform: `translateY(-100%) rotate(${-m.angle}deg)`, transformOrigin: '0 100%' },
        }, m.text));
      }
    }
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
    } else if (tool === 'whiteout' || tool === 'redact' || tool === 'shape') {
      snapshot();
      const annot = tool === 'whiteout' ? { type: 'rect', x1: ux, y1: uy, x2: ux, y2: uy, color: '#ffffff', opacity: 1 }
        : tool === 'redact' ? { type: 'redact', x1: ux, y1: uy, x2: ux, y2: uy }
          : { type: 'shape', shape: shapeStyle.shape, x1: ux, y1: uy, x2: ux, y2: uy, color: shapeStyle.color, width: shapeStyle.width };
      p.annots.push(annot);
      gesture = { kind: 'rect', view, annot };
    } else if (tool === 'note') {
      const value = await askText('Add a comment', { multiline: true, placeholder: 'Your comment', ok: 'Add' });
      if (!value?.trim()) return;
      snapshot();
      const annot = { type: 'note', x: ux, y: uy, text: value.trim(), color: '#ffd400' };
      p.annots.push(annot);
      selected = { p, annot };
      setTool('hand');
      save();
      toast('Comment added. Tap it to read or edit.');
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
      return toast(g.annot.type === 'shape' ? 'Drag to draw the shape' : g.annot.type === 'redact' ? 'Drag across what you want to remove' : 'Drag across the area to cover');
    }
    if (g.kind === 'rect' && g.annot.type === 'redact') toast('Marked for redaction. It is removed for good when you save a copy.');
    if ((g.kind === 'move' || g.kind === 'resize') && !g.moved && g.wasSelected) {
      const a = g.annot;
      const value = await actionSheet(a.type === 'note' ? a.text : null, [
        a.type === 'note' ? { icon: 'edit', label: 'Edit comment', value: 'note' } : null,
        a.type === 'note' ? { icon: 'palette', label: 'Colour', value: 'noteColor' } : null,
        a.type === 'text' ? { icon: 'edit', label: 'Edit text', value: 'edit' } : null,
        a.type === 'text' ? { icon: 'palette', label: 'Text color', value: 'color' } : null,
        { icon: 'trash', label: 'Delete', value: 'delete', danger: true },
      ]);
      if (value === 'edit') {
        const text = await askText('Edit text', { value: a.text, multiline: true, ok: 'Save' });
        if (text != null && text.trim()) { snapshot(); a.text = text; }
      } else if (value === 'note') {
        const text = await askText('Edit comment', { value: a.text, multiline: true, ok: 'Save' });
        if (text != null && text.trim()) { snapshot(); a.text = text.trim(); }
      } else if (value === 'noteColor') {
        const color = await pickColor('Comment colour');
        if (color) { snapshot(); a.color = color; }
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
      redact: 'Drag over text or pictures to remove them for good. They are blacked out when you save a copy.',
      note: 'Tap where you want to leave a comment',
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
      const pv = h('button', { class: 'pv', 'aria-label': `Show page ${i + 1}`, onClick: () => { togglePages(false).then(() => scrollToPage(i)); } });
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

  async function togglePages(on) {
    pagesMode = on;
    if (on) {
      scroller.replaceWith(grid);
      toolbar.replaceWith(gridBar);
      await renderGrid();
    } else {
      grid.replaceWith(scroller);
      gridBar.replaceWith(toolbar);
      textCache.clear();
      await rebuild();
    }
  }

  // ---- Export ----
  async function exportPdf() {
    save.flush();
    const locked = Object.values(data.passwords).filter(Boolean);
    let password;
    if (locked.length) {
      const keep = await actionSheet('This PDF had a password', [
        { icon: 'lock', label: 'Keep the password', value: 'keep' },
        { icon: 'key', label: 'Save without a password', value: 'drop' },
      ]);
      if (!keep) return;
      if (keep === 'keep') password = locked[0];
    }
    try {
      await busy('Saving PDF…', async () => exportFile(await buildPdf(data, rasterize, { title: doc.name, password }), `${doc.name}.pdf`));
    } catch (err) {
      console.error(err);
      toast('Could not save: ' + (err.message || err));
    }
  }

  // ---- Text recognition (OCR) ----
  async function recognizeText() {
    const { recognize } = await import('../ocr.js');
    const box = progressBox('Getting ready to read text…');
    const results = [];
    try {
      for (let i = 0; i < data.pages.length; i++) {
        const p = data.pages[i];
        const label = data.pages.length > 1 ? `Reading page ${i + 1} of ${data.pages.length}…` : 'Reading text…';
        const progress = (v) => box.update(`${label} ${Math.round(v * 100)}%`);
        box.update(label);
        if (p.src) {
          const info = await pageInfo(p);
          // Pages that already contain real text don't need OCR.
          const content = await info.page.getTextContent();
          const existing = content.items.map((it) => it.str + (it.hasEOL ? '\n' : '')).join('');
          if (existing.replace(/\s/g, '').length >= 20) { results.push(existing.trim()); continue; }
          const rotation = rotationOf(info, p);
          const scale = 2000 / Math.max(info.view[2] - info.view[0], info.view[3] - info.view[1]);
          const vp = info.page.getViewport({ scale, rotation });
          const canvas = await renderOnWhite(info.page, vp);
          const r = await recognize(canvas, progress);
          p.ocr = wordsToPdf(r.words, (x, y) => vp.convertToPdfPoint(x, y), 1 / scale, rotation);
          results.push(r.text.trim());
        } else if (p.image) {
          const img = new Image();
          img.src = p.image;
          await img.decode();
          const r = await recognize(img, progress);
          const k = p.w / img.naturalWidth;
          p.ocr = wordsToPdf(r.words, (x, y) => [x * k, p.h - y * k], k);
          results.push(r.text.trim());
        } else {
          results.push('');
        }
      }
    } catch (err) {
      console.error(err);
      box.close();
      return toast(`Text recognition failed: ${err.message || err}`);
    }
    box.close();
    save();
    const text = results.map((t, i) => (results.length > 1 && t ? `— Page ${i + 1} —\n${t}` : t)).filter(Boolean).join('\n\n');
    if (!text.trim()) return toast('No text was found');
    const action = await customDialog('Text found', (box2, done) => {
      const area = h('textarea', { class: 'field', rows: 10, readonly: true, style: { fontSize: '14px' } });
      area.value = text;
      const copy = async () => {
        try { await navigator.clipboard.writeText(text); } catch { area.select(); document.execCommand('copy'); }
        toast('Copied');
      };
      box2.append(h('p', {}, 'Saved copies of this PDF are now searchable.'), area,
        h('div', { class: 'row', style: { flexWrap: 'wrap' } },
          h('button', { class: 'btn', onClick: copy }, 'Copy'),
          h('button', { class: 'btn', onClick: () => done('doc') }, 'Open as document'),
          h('button', { class: 'btn primary', onClick: () => done(null) }, 'Done')));
    });
    if (action === 'doc') {
      const html = text.split(/\n{2,}/).map((para) => `<p>${escapeHtml(para).replace(/\n/g, '<br>')}</p>`).join('');
      const created = await saveDoc({ id: newDocId(), name: `${doc.name} (text)`, kind: 'doc', data: html, size: html.length });
      close(created.id);
    }
  }

  // PDF -> Word / Pages / editable document. Works on the PDF as it looks now,
  // including anything added in this editor.
  async function convertTo(value) {
    save.flush();
    try {
      const bytes = new Uint8Array(await (await busy('Preparing…', () => buildPdf(data, rasterize))).arrayBuffer());
      const { convertPdf } = await import('./convert.js');
      const target = { toDocx: 'docx', toPages: 'pages', toKey: 'key', toDoc: 'doc' }[value];
      const id = await convertPdf(bytes, doc.name, target);
      if (id) close(id);
    } catch (err) {
      console.error(err);
      toast(`Could not convert: ${err.message || err}`);
    }
  }

  // ---- Text of each page (for find, read aloud and PDF to Excel) ----
  const textCache = new Map();
  async function runsFor(p) {
    if (!textCache.has(p.id)) {
      let runs = tools.ocrText(p.ocr);
      if (p.src) {
        try { runs = [...await tools.pageText((await pageInfo(p)).page), ...runs]; } catch { /* no text */ }
      }
      textCache.set(p.id, runs);
    }
    return textCache.get(p.id);
  }

  // ---- Find ----
  let findBar = null;
  let hitOrder = [];
  let hitAt = -1;
  const findStatus = h('span', { class: 'find-status' });
  function scrollToPage(i, offset = 0) {
    const v = views.get(data.pages[i]?.id);
    if (!v) return;
    scroller.scrollTop += v.box.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 12 + offset;
  }
  async function runSearch(q) {
    searchHits.clear();
    hitOrder = [];
    hitAt = -1;
    searchCurrent = null;
    if (q.trim().length) {
      findStatus.textContent = 'Searching…';
      for (const p of data.pages) {
        const hits = tools.findInRuns(await runsFor(p), q.trim());
        if (hits.length) {
          searchHits.set(p.id, hits);
          hits.forEach((_, index) => hitOrder.push({ page: p.id, index }));
        }
      }
    }
    findStatus.textContent = !q.trim() ? '' : hitOrder.length ? `${hitOrder.length} found` : 'Not found';
    redrawAll();
    if (hitOrder.length) goHit(1);
  }
  function goHit(step) {
    if (!hitOrder.length) return;
    hitAt = (hitAt + step + hitOrder.length) % hitOrder.length;
    searchCurrent = hitOrder[hitAt];
    findStatus.textContent = `${hitAt + 1} of ${hitOrder.length}`;
    redrawAll();
    const i = data.pages.findIndex((p) => p.id === searchCurrent.page);
    const v = views.get(searchCurrent.page);
    const quad = searchHits.get(searchCurrent.page)[searchCurrent.index][0];
    const top = Math.min(...quad.map((pt) => v.vp.toView(...pt)[1]));
    scrollToPage(i, top - scroller.clientHeight / 3);
  }
  function toggleFind() {
    if (findBar) {
      findBar.remove();
      findBar = null;
      searchHits.clear();
      searchCurrent = null;
      redrawAll();
      return;
    }
    if (pagesMode) togglePages(false);
    const input = h('input', { class: 'field', type: 'search', placeholder: 'Find in this PDF', enterkeyhint: 'search' });
    const run = debounce((q) => runSearch(q), 300);
    input.addEventListener('input', () => run(input.value));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (hitOrder.length) goHit(e.shiftKey ? -1 : 1); else run.flush(input.value); } });
    findBar = h('div', { class: 'findbar' }, input, findStatus,
      iconBtn('up', 'Previous match', () => goHit(-1)), iconBtn('down', 'Next match', () => goHit(1)), iconBtn('x', 'Close find', toggleFind));
    findStatus.textContent = '';
    bar.after(findBar);
    input.focus();
  }

  async function goToPage() {
    const value = await askText(`Go to page (1–${data.pages.length})`, { placeholder: 'Page number', ok: 'Go' });
    const n = parseInt(value, 10);
    if (!n) return;
    if (pagesMode) togglePages(false);
    scrollToPage(Math.max(1, Math.min(data.pages.length, n)) - 1);
  }

  // ---- Night mode ----
  const NIGHT_KEY = 'plain-office-pdf-night';
  let night = false;
  try { night = localStorage.getItem(NIGHT_KEY) === '1'; } catch { /* private mode */ }
  scroller.classList.toggle('night', night);
  function toggleNight() {
    night = !night;
    scroller.classList.toggle('night', night);
    try { localStorage.setItem(NIGHT_KEY, night ? '1' : '0'); } catch { /* private mode */ }
    toast(night ? 'Night mode on' : 'Night mode off');
  }

  // ---- Read aloud (uses the device's own voices, nothing goes online) ----
  const canSpeak = typeof window.speechSynthesis !== 'undefined' && typeof window.SpeechSynthesisUtterance !== 'undefined';
  let reading = null;
  function stopReading() {
    if (!reading) return;
    reading.stopped = true;
    window.speechSynthesis.cancel();
    reading.pill.remove();
    reading = null;
  }
  async function readAloud() {
    if (reading) return stopReading();
    const start = data.pages.indexOf(visiblePage()?.p);
    const label = h('span', {}, 'Reading…');
    const pill = h('div', { class: 'read-pill' }, icon('play'), label, h('button', { class: 'btn', onClick: stopReading }, 'Stop'));
    document.body.append(pill);
    reading = { stopped: false, pill };
    const session = reading;
    for (let i = Math.max(0, start); i < data.pages.length && !session.stopped; i++) {
      const text = (await runsFor(data.pages[i])).map((r) => r.t).join(' ').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      label.textContent = `Reading page ${i + 1} of ${data.pages.length}`;
      scrollToPage(i);
      const chunks = text.match(/[^.!?]{1,220}[.!?]*|.{1,220}/g) || [];
      for (const chunk of chunks) {
        if (session.stopped) break;
        await new Promise((resolve) => {
          const u = new SpeechSynthesisUtterance(chunk);
          u.onend = resolve;
          u.onerror = resolve;
          window.speechSynthesis.speak(u);
        });
      }
    }
    if (!session.stopped) { toast('Finished reading'); stopReading(); }
  }

  // ---- Shapes and stamps ----
  async function chooseShape() {
    const mark = (on) => (on ? '✓ ' : '');
    const value = await actionSheet('Shapes', [
      { icon: 'square', label: `${mark(shapeStyle.shape === 'rect')}Rectangle`, value: 'rect' },
      { icon: 'circle', label: `${mark(shapeStyle.shape === 'ellipse')}Oval`, value: 'ellipse' },
      { icon: 'line', label: `${mark(shapeStyle.shape === 'line')}Line`, value: 'line' },
      { icon: 'arrowShape', label: `${mark(shapeStyle.shape === 'arrow')}Arrow`, value: 'arrow' },
      { section: 'Style' },
      { icon: 'palette', label: 'Colour', value: 'color' },
      ...[['Thin', 1], ['Medium', 2], ['Thick', 4]].map(([label, w]) => ({ label: `${mark(shapeStyle.width === w)}${label} line`, value: `w${w}` })),
    ]);
    if (!value) return;
    if (value === 'color') { const color = await pickColor('Shape colour'); if (color) shapeStyle.color = color; } else if (value.startsWith('w')) shapeStyle.width = Number(value.slice(1));
    else shapeStyle.shape = value;
    setTool('shape');
    toast('Drag on the page to draw. Tap Shapes again to change it.');
  }

  async function placeText(text, size = 16, color = textStyle.color) {
    const view = visiblePage();
    if (!view) return;
    const { p, vp } = view;
    const sr = view.box.getBoundingClientRect();
    const scr = scroller.getBoundingClientRect();
    const [x, y] = vp.toUser(Math.min(Math.max(scr.left + scr.width / 2 - sr.left, 0), vp.width - 40), Math.min(Math.max(scr.top + scr.height / 2 - sr.top, 0), vp.height - 40));
    snapshot();
    const annot = { type: 'text', x, y, text, size, color, rot: vp.rotation };
    p.annots.push(annot);
    selected = { p, annot };
    setTool('hand');
    save();
    toast('Drag to move it. Tap it again to edit.');
  }

  async function stampMenu() {
    const value = await actionSheet('Stamps and marks', [
      { section: 'Fill & sign' },
      { icon: 'check', label: 'Tick ✓', value: 'tick' },
      { icon: 'x', label: 'Cross ✗', value: 'cross' },
      { icon: 'circle', label: 'Dot ●', value: 'dot' },
      { icon: 'calendar', label: `Today’s date`, hint: tools.today(), value: 'date' },
      { icon: 'sign', label: 'Signature or initials', value: 'sign' },
      { section: 'Stamps' },
      ...tools.STAMPS.map((s, i) => ({ node: h('button', { class: 'sheet-item', onClick: (e) => e.currentTarget.closest('.action-sheet').closeSheet(`s${i}`) }, h('img', { class: 'stamp-preview', src: tools.stampImage(s.label, s.color, s.dated), alt: s.label })), label: s.label, value: `s${i}` })),
      { icon: 'edit', label: 'Make your own stamp…', value: 'custom' },
      { icon: 'image', label: 'A picture', value: 'picture' },
    ].map((it) => (it?.node && nativeList() ? { label: it.label, value: it.value, icon: 'star' } : it)));
    if (!value) return;
    if (value === 'tick') return placeText('✓', 20);
    if (value === 'cross') return placeText('✗', 20);
    if (value === 'dot') return placeText('●', 12);
    if (value === 'date') return placeText(tools.today(), 12);
    if (value === 'sign') return sign();
    if (value === 'picture') return insertPicture();
    if (value === 'custom') {
      const label = await askText('Stamp text', { placeholder: 'e.g. Checked by Sam', ok: 'Next' });
      if (!label?.trim()) return;
      const color = await pickColor('Stamp colour');
      return placeImage(tools.stampImage(label.trim(), color && color !== 'none' ? color : '#d93a3a', true), 150);
    }
    const s = tools.STAMPS[Number(value.slice(1))];
    placeImage(tools.stampImage(s.label, s.color, s.dated), 140);
  }
  // Native (iOS/Mac) sheets can't show pictures, so they get plain rows.
  const nativeList = () => document.documentElement.classList.contains('native-chrome');

  // ---- Fill in forms ----
  let formFields = {}; // source id -> fields
  const formBtn = h('button', { class: 'tb-text', onClick: () => fillForm() }, icon('checklist'), 'Fill form');
  async function detectForms() {
    formFields = {};
    for (const sid of Object.keys(data.sources)) {
      if (!data.pages.some((p) => p.src === sid)) continue;
      const fields = await tools.readFields(data.sources[sid], data.passwords[sid]);
      if (fields.length) formFields[sid] = fields;
    }
    const has = Object.keys(formFields).length > 0;
    if (has && !formBtn.isConnected) { toolbar.prepend(formBtn); toast('This PDF has a form. Tap Fill form to fill it in.'); }
    if (!has) formBtn.remove();
    return has;
  }
  async function fillForm() {
    if (!Object.keys(formFields).length && !await detectForms()) {
      return toast('This PDF has no fillable fields. Use Text to type anywhere on it.');
    }
    const inputs = [];
    const values = await customDialog('Fill in form', (box, done) => {
      const list = h('div', { class: 'form-list' });
      for (const [sid, fields] of Object.entries(formFields)) {
        for (const f of fields) {
          let input;
          if (f.type === 'check') {
            input = h('input', { type: 'checkbox' });
            input.checked = !!f.value;
            list.append(h('label', { class: 'form-check' }, input, h('span', {}, f.label)));
          } else {
            if (f.type === 'text') {
              input = f.multiline ? h('textarea', { class: 'field', rows: 3 }) : h('input', { class: 'field' });
            } else {
              input = h('select', { class: 'field' }, h('option', { value: '' }, '—'), ...f.options.map((o) => h('option', { value: o }, o)));
            }
            input.value = f.value || '';
            list.append(h('label', { class: 'form-field' }, h('span', {}, f.label), input));
          }
          inputs.push({ sid, f, input });
        }
      }
      box.append(list, h('div', { class: 'row' },
        h('button', { class: 'btn', onClick: () => done(null) }, 'Cancel'),
        h('button', { class: 'btn primary', onClick: () => done(true) }, 'Done')));
    });
    if (!values) return;
    try {
      await busy('Filling in…', async () => {
        for (const sid of Object.keys(formFields)) {
          const vals = {};
          for (const { sid: s, f, input } of inputs) if (s === sid) vals[f.name] = f.type === 'check' ? input.checked : input.value;
          data.sources[sid] = await tools.fillFields(data.sources[sid], data.passwords[sid], vals);
          delete data.passwords[sid];
          resetSource(sid);
        }
      });
      await detectForms();
      save();
      await rebuild();
      toast('Form filled in');
    } catch (err) {
      console.error(err);
      toast(`Could not fill in the form: ${err.message || err}`);
    }
  }
  function resetSource(sid) {
    pdfs[sid]?.then((d) => d.loadingTask.destroy()).catch(() => {});
    delete pdfs[sid];
    for (const key of [...infoCache.keys()]) if (key.startsWith(`${sid}:`)) infoCache.delete(key);
    textCache.clear();
  }

  // ---- Header, footer and watermark ----
  function segmentedField(options, value) {
    const wrap = h('div', { class: 'seg' });
    wrap.value = value;
    const render = () => wrap.replaceChildren(...options.map(([v, label]) => h('button', { type: 'button', class: `seg-btn${wrap.value === v ? ' on' : ''}`, onClick: () => { wrap.value = v; render(); } }, label)));
    render();
    return wrap;
  }
  async function watermarkDialog() {
    const wm = data.marks?.watermark || { text: 'CONFIDENTIAL', color: '#d93a3a', opacity: 0.18, angle: 45 };
    const result = await customDialog('Watermark', (box, done) => {
      const text = h('input', { class: 'field', value: wm.text, placeholder: 'e.g. DRAFT' });
      const color = segmentedField([['#d93a3a', 'Red'], ['#8a939d', 'Grey'], ['#2b6fdc', 'Blue'], ['#1f9d55', 'Green']], wm.color);
      const strength = segmentedField([[0.1, 'Faint'], [0.18, 'Light'], [0.32, 'Strong']], wm.opacity);
      const angle = segmentedField([[45, 'Diagonal'], [0, 'Across']], wm.angle ?? 45);
      box.append(h('p', {}, 'Shown on every page. You can use {date} and {page}.'), text,
        h('div', { class: 'opt-label' }, 'Colour'), color, h('div', { class: 'opt-label' }, 'Strength'), strength, h('div', { class: 'opt-label' }, 'Direction'), angle,
        h('div', { class: 'row' },
          data.marks?.watermark ? h('button', { class: 'btn danger-text', onClick: () => done('remove') }, 'Remove') : null,
          h('span', { style: { flex: 1 } }),
          h('button', { class: 'btn', onClick: () => done(null) }, 'Cancel'),
          h('button', { class: 'btn primary', onClick: () => done({ text: text.value, color: color.value, opacity: strength.value, angle: angle.value }) }, 'Apply')));
    });
    if (!result) return;
    data.marks ??= {};
    if (result === 'remove' || !result.text.trim()) delete data.marks.watermark; else data.marks.watermark = result;
    save();
    redrawAll();
  }
  async function headerFooterDialog(preset) {
    const m = data.marks || {};
    const header = m.header || { text: '', align: 'center' };
    const footer = m.footer || (preset === 'numbers' ? { text: 'Page {page} of {pages}', align: 'center' } : { text: '', align: 'center' });
    const result = await customDialog(preset === 'numbers' ? 'Page numbers' : 'Header & footer', (box, done) => {
      const hText = h('input', { class: 'field', value: header.text, placeholder: 'Header (top of each page)' });
      const hAlign = segmentedField([['left', 'Left'], ['center', 'Centre'], ['right', 'Right']], header.align);
      const fText = h('input', { class: 'field', value: footer.text, placeholder: 'Footer (bottom of each page)' });
      const fAlign = segmentedField([['left', 'Left'], ['center', 'Centre'], ['right', 'Right']], footer.align);
      const chip = (label, value) => h('button', { type: 'button', class: 'chip', onClick: () => { fText.value = value; } }, label);
      box.append(
        h('p', {}, 'Codes: {page}, {pages}, {date}, {title}.'),
        h('div', { class: 'opt-label' }, 'Header'), hText, hAlign,
        h('div', { class: 'opt-label' }, 'Footer'), fText, fAlign,
        h('div', { class: 'chips' }, chip('1', '{page}'), chip('Page 1 of 9', 'Page {page} of {pages}'), chip('1 / 9', '{page} / {pages}'), chip('Date', '{date}'), chip('Title · 1', '{title} · {page}')),
        h('div', { class: 'row' },
          m.header || m.footer ? h('button', { class: 'btn danger-text', onClick: () => done('remove') }, 'Remove') : null,
          h('span', { style: { flex: 1 } }),
          h('button', { class: 'btn', onClick: () => done(null) }, 'Cancel'),
          h('button', { class: 'btn primary', onClick: () => done({ header: { text: hText.value, align: hAlign.value }, footer: { text: fText.value, align: fAlign.value } }) }, 'Apply')));
    });
    if (!result) return;
    data.marks ??= {};
    if (result === 'remove') { delete data.marks.header; delete data.marks.footer; } else {
      if (result.header.text.trim()) data.marks.header = result.header; else delete data.marks.header;
      if (result.footer.text.trim()) data.marks.footer = result.footer; else delete data.marks.footer;
    }
    save();
    redrawAll();
  }

  // ---- Split and extract ----
  function subsetData(indices) {
    const pages = indices.map((i) => ({ ...JSON.parse(JSON.stringify(data.pages[i])), id: newId() }));
    const sources = {};
    const passwords = {};
    for (const p of pages) if (p.src) { sources[p.src] = data.sources[p.src]; if (data.passwords[p.src]) passwords[p.src] = data.passwords[p.src]; }
    return { sources, passwords, pages, marks: data.marks ? JSON.parse(JSON.stringify(data.marks)) : undefined };
  }
  const rangeLabel = (idx) => (idx.length === 1 ? `page ${idx[0] + 1}` : `pages ${idx[0] + 1}–${idx[idx.length - 1] + 1}`);
  async function saveSubset(indices, name) {
    const d = subsetData(indices);
    return saveDoc({ id: newDocId(), name, kind: 'pdf', data: d, size: estimateSize(d) });
  }
  async function extractPages() {
    save.flush();
    const text = await askText(`Pages to copy into a new PDF (1–${data.pages.length})`, { placeholder: 'e.g. 1-3, 5', ok: 'Extract' });
    if (!text?.trim()) return;
    const idx = tools.parseRanges(text, data.pages.length);
    if (!idx) return toast('Type page numbers like 1-3, 5');
    const created = await saveSubset(idx, `${doc.name} (${text.trim().length < 20 ? `pages ${text.trim()}` : rangeLabel(idx)})`);
    if (await confirmBox(`Made “${created.name}”`, 'It’s in your Files.', { ok: 'Open it' })) close(created.id);
  }
  async function splitPdf() {
    save.flush();
    const n = data.pages.length;
    if (n < 2) return toast('There is only one page');
    const value = await actionSheet('Split into separate PDFs', [
      { icon: 'file', label: 'Every page on its own', hint: `${n} files`, value: '1' },
      n > 2 ? { icon: 'pages', label: 'Every 2 pages', hint: `${Math.ceil(n / 2)} files`, value: '2' } : null,
      n > 5 ? { icon: 'pages', label: 'Every 5 pages', hint: `${Math.ceil(n / 5)} files`, value: '5' } : null,
      { icon: 'merge', label: 'In half', hint: '2 files', value: 'half' },
      { icon: 'edit', label: 'Choose where to split…', value: 'custom' },
    ]);
    if (!value) return;
    let groups = [];
    if (value === 'custom') {
      const text = await askText('Separate each new PDF with a semicolon', { placeholder: 'e.g. 1-3; 4-6; 7-', ok: 'Split' });
      if (!text?.trim()) return;
      for (const part of text.split(/[;|]/).map((t) => t.trim()).filter(Boolean)) {
        const idx = tools.parseRanges(part, n);
        if (!idx) return toast(`“${part}” isn’t a page range`);
        groups.push(idx);
      }
    } else {
      const size = value === 'half' ? Math.ceil(n / 2) : Number(value);
      for (let i = 0; i < n; i += size) groups.push([...Array(Math.min(size, n - i)).keys()].map((k) => i + k));
    }
    await busy('Splitting…', async () => {
      for (const idx of groups) await saveSubset(idx, `${doc.name} (${rangeLabel(idx)})`);
    });
    toast(`Made ${groups.length} PDFs. They’re in your Files.`);
  }

  // ---- Reduce file size ----
  async function compress() {
    save.flush();
    const value = await actionSheet('Reduce file size', [
      { node: h('p', { class: 'sheet-note' }, 'Pages are turned into pictures at a lower resolution. Their text stays searchable; links and form fields are dropped.') },
      { icon: 'image', label: 'Light', hint: 'best quality', value: 'high' },
      { icon: 'image', label: 'Balanced', hint: 'recommended', value: 'medium' },
      { icon: 'image', label: 'Smallest', hint: 'lowest quality', value: 'low' },
    ].map((it) => (it.node && nativeList() ? null : it)));
    if (!value) return;
    const flatten = { high: { scale: 2, quality: 0.78 }, medium: { scale: 1.5, quality: 0.62 }, low: { scale: 1.05, quality: 0.5 } }[value];
    try {
      const [before, after] = await busy('Making it smaller…', async () => [await buildPdf(data, rasterize, { title: doc.name }), await buildPdf(data, rasterize, { title: doc.name, flatten })]);
      if (after.size >= before.size * 0.95) {
        toast(`This PDF is already compact (${formatSize(before.size)})`);
        return exportFile(before, `${doc.name}.pdf`);
      }
      toast(`${formatSize(before.size)} → ${formatSize(after.size)}`);
      await exportFile(after, `${doc.name} (smaller).pdf`);
    } catch (err) {
      console.error(err);
      toast(`Could not reduce the size: ${err.message || err}`);
    }
  }

  // ---- Passwords ----
  async function protect() {
    save.flush();
    const result = await customDialog('Protect with a password', (box, done) => {
      const pw = h('input', { class: 'field', type: 'password', placeholder: 'Password', autocomplete: 'new-password' });
      const again = h('input', { class: 'field', type: 'password', placeholder: 'Type it again', autocomplete: 'new-password', style: { marginTop: '8px' } });
      const restrict = h('input', { type: 'checkbox' });
      const err = h('p', { class: 'form-error' });
      box.append(h('p', {}, 'Anyone opening the copy will need this password. It can’t be recovered if you forget it.'), pw, again,
        h('label', { class: 'form-check' }, restrict, h('span', {}, 'Also block copying text and making changes')), err,
        h('div', { class: 'row' },
          h('button', { class: 'btn', onClick: () => done(null) }, 'Cancel'),
          h('button', { class: 'btn primary', onClick: () => {
            if (pw.value.length < 4) { err.textContent = 'Use at least 4 characters.'; return; }
            if (pw.value !== again.value) { err.textContent = 'The passwords don’t match.'; return; }
            done({ password: pw.value, restrict: restrict.checked });
          } }, 'Save copy')));
      setTimeout(() => pw.focus(), 50);
    });
    if (!result) return;
    try {
      await busy('Locking…', async () => exportFile(await buildPdf(data, rasterize, { title: doc.name, ...result }), `${doc.name} (protected).pdf`));
    } catch (err) {
      console.error(err);
      toast(`Could not protect it: ${err.message || err}`);
    }
  }
  async function removePassword() {
    if (!Object.keys(data.passwords).length) return toast('This PDF has no password');
    save.flush();
    try {
      await busy('Unlocking…', async () => exportFile(await buildPdf(data, rasterize, { title: doc.name }), `${doc.name} (unlocked).pdf`));
    } catch (err) {
      toast(`Could not save: ${err.message || err}`);
    }
  }

  // ---- Document properties ----
  async function properties() {
    if (!data.meta) {
      const firstSrc = data.pages.find((p) => p.src)?.src;
      let info = {};
      if (firstSrc) { try { info = (await (await pdfFor(firstSrc)).getMetadata()).info || {}; } catch { /* none */ } }
      data.meta = { title: info.Title || '', author: info.Author || '', subject: info.Subject || '', keywords: info.Keywords || '' };
    }
    const first = await pageInfo(data.pages[0]);
    const wPt = first.view[2] - first.view[0];
    const hPt = first.view[3] - first.view[1];
    const near = (a, b) => Math.abs(a - b) < 6;
    const named = [['A4', 595, 842], ['A5', 420, 595], ['A3', 842, 1191], ['Letter', 612, 792], ['Legal', 612, 1008]]
      .find(([, a, b]) => (near(wPt, a) && near(hPt, b)) || (near(wPt, b) && near(hPt, a)))?.[0];
    const sizeText = `${named ? `${named} · ` : ''}${Math.round(wPt / 72 * 25.4)} × ${Math.round(hPt / 72 * 25.4)} mm`;
    const result = await customDialog('Document properties', (box, done) => {
      const field = (label, key, placeholder) => {
        const input = h('input', { class: 'field', value: data.meta[key] || '', placeholder });
        box.append(h('label', { class: 'form-field' }, h('span', {}, label), input));
        return [key, input];
      };
      box.append(h('div', { class: 'facts' },
        h('div', {}, h('span', {}, 'Pages'), h('strong', {}, String(data.pages.length))),
        h('div', {}, h('span', {}, 'Page size'), h('strong', {}, sizeText)),
        h('div', {}, h('span', {}, 'Size'), h('strong', {}, formatSize(doc.size) || '—')),
        h('div', {}, h('span', {}, 'Password'), h('strong', {}, Object.keys(data.passwords).length ? 'Yes' : 'No'))));
      const fields = [field('Title', 'title', doc.name), field('Author', 'author', 'Your name'), field('Subject', 'subject', ''), field('Keywords', 'keywords', 'Separated by commas')];
      box.append(h('div', { class: 'row' },
        h('button', { class: 'btn', onClick: () => done(null) }, 'Cancel'),
        h('button', { class: 'btn primary', onClick: () => done(Object.fromEntries(fields.map(([k, input]) => [k, input.value.trim()]))) }, 'Save')));
    });
    if (!result) return;
    data.meta = result;
    save();
    toast('Saved. Copies you save will carry these details.');
  }

  // ---- Convert: pictures, Excel, PowerPoint ----
  async function renderedCopy() {
    save.flush();
    const bytes = new Uint8Array(await (await buildPdf(data, rasterize, { title: doc.name })).arrayBuffer());
    return pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
  }
  async function renderPageImage(pdf, i, longest, type = 'image/jpeg') {
    const page = await pdf.getPage(i + 1);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: Math.min(4, longest / Math.max(base.width, base.height)) });
    const canvas = await renderOnWhite(page, vp);
    const result = { canvas, w: canvas.width, h: canvas.height };
    result.blob = await new Promise((r) => canvas.toBlob(r, type, 0.88));
    return result;
  }
  async function toImages() {
    const type = await actionSheet('Save pages as pictures', [
      { icon: 'image', label: 'JPEG', hint: 'smaller files', value: 'image/jpeg' },
      { icon: 'image', label: 'PNG', hint: 'sharpest', value: 'image/png' },
    ]);
    if (!type) return;
    const ext = type === 'image/png' ? 'png' : 'jpg';
    const box = progressBox('Preparing…');
    try {
      const pdf = await renderedCopy();
      const files = [];
      const pad = String(pdf.numPages).length;
      for (let i = 0; i < pdf.numPages; i++) {
        box.update(`Page ${i + 1} of ${pdf.numPages}…`);
        const r = await renderPageImage(pdf, i, 2400, type);
        r.canvas.width = 0;
        files.push({ blob: r.blob, name: `${doc.name} - page ${String(i + 1).padStart(pad, '0')}.${ext}` });
      }
      pdf.loadingTask.destroy();
      box.close();
      await tools.exportMany(files, `${doc.name} (pictures).zip`);
    } catch (err) {
      box.close();
      console.error(err);
      toast(`Could not make pictures: ${err.message || err}`);
    }
  }
  async function toExcel() {
    save.flush();
    try {
      const created = await busy('Finding tables…', async () => {
        const XLSX = await import('xlsx');
        const wb = XLSX.utils.book_new();
        for (let i = 0; i < data.pages.length; i++) {
          const rows = tools.runsToTable(await runsFor(data.pages[i]));
          if (rows.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), `Page ${i + 1}`);
        }
        if (!wb.SheetNames.length) return null;
        const bytes = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
        const sheets = await import('./sheets.js');
        const sheetData = await sheets.importFile(bytes, `${doc.name}.xlsx`);
        return saveDoc({ id: newDocId(), name: doc.name, kind: 'sheet', data: sheetData, size: estimateSize(sheetData) });
      });
      if (!created) return toast('No text found. For scans, run Recognize text first.');
      close(created.id);
    } catch (err) {
      console.error(err);
      toast(`Could not convert: ${err.message || err}`);
    }
  }
  async function toPowerPoint() {
    const box = progressBox('Preparing…');
    try {
      const pdf = await renderedCopy();
      const slides = [];
      for (let i = 0; i < pdf.numPages; i++) {
        box.update(`Slide ${i + 1} of ${pdf.numPages}…`);
        const r = await renderPageImage(pdf, i, 1600);
        const src = r.canvas.toDataURL('image/jpeg', 0.85);
        r.canvas.width = 0;
        const k = Math.min(960 / r.w, 540 / r.h);
        const w = Math.round(r.w * k);
        const hh = Math.round(r.h * k);
        const notes = (await runsFor(data.pages[i])).map((t) => t.t).join(' ').replace(/\s+/g, ' ').trim().slice(0, 4000);
        slides.push({ id: newId('s'), els: [{ id: newId('e'), type: 'image', src, x: Math.round((960 - w) / 2), y: Math.round((540 - hh) / 2), w, h: hh }], notes });
      }
      pdf.loadingTask.destroy();
      const deck = { theme: 0, slides };
      const created = await saveDoc({ id: newDocId(), name: doc.name, kind: 'slides', data: deck, size: estimateSize(deck) });
      box.close();
      close(created.id);
    } catch (err) {
      box.close();
      console.error(err);
      toast(`Could not convert: ${err.message || err}`);
    }
  }

  // ---- All tools (like Acrobat's tool centre) ----
  const ACTIONS = {
    find: toggleFind, goto: goToPage, night: toggleNight, read: readAloud,
    in: () => setZoom(zoom * 1.25), out: () => setZoom(zoom / 1.25),
    form: fillForm, sign, stamp: stampMenu, note: () => chooseTool('note'), shape: chooseShape, picture: insertPicture,
    text: () => chooseTool('text'), redact: () => chooseTool('redact'),
    watermark: watermarkDialog, header: () => headerFooterDialog(), numbers: () => headerFooterDialog('numbers'),
    ocr: recognizeText, toDocx: () => convertTo('toDocx'), toPages: () => convertTo('toPages'), toKey: () => convertTo('toKey'), toDoc: () => convertTo('toDoc'),
    toXlsx: toExcel, toPptx: toPowerPoint, toImages,
    pages: () => togglePages(true), add: () => { togglePages(true); addPages(); }, split: splitPdf, extract: extractPages,
    compress, protect, unlock: removePassword, props: properties, export: exportPdf,
  };
  async function toolsMenu() {
    const value = await actionSheet('All tools', [
      { section: 'View' },
      { icon: 'search', label: 'Find text', value: 'find' },
      { icon: 'pages', label: 'Go to page…', value: 'goto' },
      { icon: 'moon', label: night ? 'Night mode: on' : 'Night mode', value: 'night' },
      canSpeak ? { icon: 'speaker', label: reading ? 'Stop reading aloud' : 'Read aloud', value: 'read' } : null,
      { icon: 'zoomIn', label: 'Zoom in', value: 'in' },
      { icon: 'zoomOut', label: 'Zoom out', value: 'out' },
      { section: 'Fill & sign' },
      { icon: 'checklist', label: 'Fill in form', value: 'form' },
      { icon: 'sign', label: 'Sign', value: 'sign' },
      { icon: 'stamp', label: 'Stamps, ticks and dates', value: 'stamp' },
      { section: 'Comment' },
      { icon: 'notes', label: 'Add a comment', value: 'note' },
      { icon: 'shapes', label: 'Shapes and arrows', value: 'shape' },
      { section: 'Edit' },
      { icon: 'type', label: 'Add text', value: 'text' },
      { icon: 'image', label: 'Insert a picture', value: 'picture' },
      { icon: 'drop', label: 'Watermark', hint: data.marks?.watermark ? 'on' : '', value: 'watermark' },
      { icon: 'hash', label: 'Page numbers', value: 'numbers' },
      { icon: 'toc', label: 'Header & footer', hint: data.marks?.header || data.marks?.footer ? 'on' : '', value: 'header' },
      { icon: 'edit', label: 'Edit as a document', value: 'toDoc' },
      { icon: 'type', label: 'Recognize text (OCR)', value: 'ocr' },
      { section: 'Organize pages' },
      { icon: 'pages', label: 'Rotate, delete, reorder', value: 'pages' },
      { icon: 'merge', label: 'Add pages / combine PDFs', value: 'add' },
      { icon: 'cut', label: 'Split PDF', value: 'split' },
      { icon: 'copy', label: 'Extract pages', value: 'extract' },
      { section: 'Protect' },
      { icon: 'redact', label: 'Redact (remove for good)', value: 'redact' },
      { icon: 'lock', label: 'Protect with a password', value: 'protect' },
      Object.keys(data.passwords).length ? { icon: 'key', label: 'Remove password', value: 'unlock' } : null,
      { section: 'Convert' },
      { badge: 'doc', label: 'To Word', hint: '.docx', value: 'toDocx' },
      canMakePages ? { badge: 'pages', label: 'To Pages', hint: '.pages', value: 'toPages' } : null,
      canMakePages ? { badge: 'key', label: 'To Keynote', hint: '.key', value: 'toKey' } : null,
      { badge: 'sheet', label: 'To Excel', hint: 'tables', value: 'toXlsx' },
      { badge: 'slides', label: 'To PowerPoint', value: 'toPptx' },
      { icon: 'image', label: 'To pictures', hint: '.jpg / .png', value: 'toImages' },
      { section: 'File' },
      { icon: 'compress', label: 'Reduce file size', value: 'compress' },
      { icon: 'info', label: 'Document properties', value: 'props' },
      { icon: 'share', label: 'Save a copy / share', value: 'export' },
    ]);
    if (value) ACTIONS[value]?.();
  }

  const toolBtn = (key, iconName, label, onClick) => {
    const btn = h('button', { class: 'tb-text tool', 'aria-label': label, onClick: onClick || (() => chooseTool(key)) }, icon(iconName), label);
    toolButtons[key] = btn;
    return btn;
  };
  const sep = () => h('span', { class: 'sep' });
  const toolbar = h('nav', { class: 'toolbar', 'aria-label': 'PDF tools' },
    toolBtn('hand', 'hand', 'Select'),
    toolBtn('text', 'type', 'Text'),
    toolBtn('pen', 'pen', 'Pen'),
    toolBtn('marker', 'highlight', 'Highlight'),
    toolBtn('note', 'notes', 'Comment'),
    toolBtn('shape', 'shapes', 'Shapes', chooseShape),
    h('button', { class: 'tb-text', onClick: stampMenu }, icon('stamp'), 'Stamp'),
    h('button', { class: 'tb-text', onClick: sign }, icon('sign'), 'Sign'),
    toolBtn('whiteout', 'square', 'White-out'),
    toolBtn('redact', 'redact', 'Redact'),
    toolBtn('eraser', 'eraser', 'Erase'),
    sep(),
    h('button', { class: 'tb-text', onClick: () => togglePages(true) }, icon('pages'), 'Pages'),
    h('button', { class: 'tb-text', onClick: toolsMenu }, icon('grid'), 'All tools'),
  );

  async function close(nextId) {
    save.flush();
    stopReading();
    observer?.disconnect();
    window.removeEventListener('resize', onResize);
    Object.values(pdfs).forEach((pr) => pr.then((d) => d.loadingTask.destroy()).catch(() => {}));
    onExit(nextId);
  }

  const bar = topBar(doc, {
    onBack: () => close(),
    buttons: [
      iconBtn('undo', 'Undo', undo),
      iconBtn('search', 'Find', toggleFind),
      iconBtn('share', 'Save a copy / share', exportPdf),
      iconBtn('more', 'All tools', toolsMenu),
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
  detectForms().catch(() => {});
  if (opts.action && ACTIONS[opts.action]) setTimeout(() => ACTIONS[opts.action](), 300);
  return () => close();
}
