// PDF tools in the style of Acrobat and WPS: find text, stamps, comments,
// watermarks, headers and footers, forms, page ranges and conversions.
//
// Everything here runs on the device. Nothing is uploaded anywhere.

// ---------- Text with positions ----------
// One entry per run of text, in PDF user space: the baseline starts at (x, y),
// runs `w` points long in direction `angle` (degrees, counter-clockwise), and is `size` tall.
export async function pageText(page) {
  const content = await page.getTextContent();
  const out = [];
  for (const it of content.items) {
    if (!it.str || !it.str.trim()) continue;
    const [a, b, c, d, e, f] = it.transform;
    const size = Math.hypot(c, d) || Math.hypot(a, b) || 10;
    out.push({ t: it.str, x: e, y: f, w: it.width || size * it.str.length * 0.5, size, angle: Math.atan2(b, a) * 180 / Math.PI });
  }
  return out;
}

// OCR words ({ t, x, y, w, h, rot }, y at the bottom of the word) in the same shape.
export const ocrText = (words = []) => words.map((w) => ({ t: w.t, x: w.x, y: w.y + w.h * 0.2, w: w.w, size: w.h, angle: w.rot || 0 }));

// The four corners of part of a run (from character `from` to `to`), in PDF space.
export function runBox(run, from = 0, to = run.t.length) {
  const rad = run.angle * Math.PI / 180;
  const ux = Math.cos(rad); const uy = Math.sin(rad);
  const vx = -uy; const vy = ux; // "up" for the text
  const len = run.t.length || 1;
  const s = (run.w * from) / len; const e = (run.w * to) / len;
  const down = run.size * 0.25; const up = run.size * 0.9;
  const pt = (along, rise) => [run.x + ux * along + vx * rise, run.y + uy * along + vy * rise];
  return [pt(s, -down), pt(e, -down), pt(e, up), pt(s, up)];
}

const bounds = (pts) => {
  const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};
const overlaps = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

// Runs that are not under any of the boxes ([x1, y1, x2, y2] in PDF space).
export function textOutside(runs, boxes) {
  if (!boxes.length) return runs;
  return runs.filter((r) => !boxes.some((b) => overlaps(bounds(runBox(r)), b)));
}

// Finds `query` in a page's runs. Returns one list of corner boxes per match.
export function findInRuns(runs, query) {
  const q = query.toLocaleLowerCase();
  if (!q) return [];
  let text = '';
  const owner = []; // character -> [run index, offset]
  runs.forEach((r, i) => {
    for (let k = 0; k < r.t.length; k++) owner.push([i, k]);
    text += r.t;
    // A space between runs that are apart, so words don't run together.
    const next = runs[i + 1];
    if (next && !/\s$/.test(r.t) && !/^\s/.test(next.t)) { owner.push(null); text += ' '; }
  });
  const lower = text.toLocaleLowerCase();
  const hits = [];
  for (let at = lower.indexOf(q); at !== -1; at = lower.indexOf(q, at + q.length)) {
    const parts = new Map();
    for (let k = at; k < at + q.length; k++) {
      const o = owner[k];
      if (!o) continue;
      const span = parts.get(o[0]) || [o[1], o[1] + 1];
      span[0] = Math.min(span[0], o[1]); span[1] = Math.max(span[1], o[1] + 1);
      parts.set(o[0], span);
    }
    hits.push([...parts].map(([i, [s, e]]) => runBox(runs[i], s, e)));
  }
  return hits;
}

// Invisible text so pages turned into pictures can still be searched and copied.
export function drawInvisibleText(page, runs, font, lib, X = (x) => x, Y = (y) => y) {
  if (!runs.length) return;
  const { pushGraphicsState, popGraphicsState, setTextRenderingMode, TextRenderingMode, degrees } = lib;
  page.pushOperators(pushGraphicsState(), setTextRenderingMode(TextRenderingMode.Invisible));
  for (const r of runs) {
    const text = encodable(font, r.t);
    if (!text.trim()) continue;
    const natural = font.widthOfTextAtSize(text, 1) || 1;
    const size = Math.max(1, Math.min(r.w / natural, r.size * 1.6));
    page.drawText(text, { x: X(r.x), y: Y(r.y), size, font, rotate: degrees(r.angle) });
  }
  page.pushOperators(popGraphicsState());
}

// Standard PDF fonts only know Western characters; drop the rest.
export function encodable(font, text) {
  try { font.encodeText(text); return text; } catch { return text.replace(/[^\x20-\x7e\xa0-\xff]/g, ''); }
}

// ---------- Page ranges ("1-3, 5, 8-") ----------
export function parseRanges(text, count) {
  const out = [];
  for (const part of String(text).split(/[,;\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d*)\s*[-–]\s*(\d*)$/) || part.match(/^(\d+)$/);
    if (!m) return null;
    const a = m[1] ? Number(m[1]) : 1;
    const b = m.length > 2 ? (m[2] ? Number(m[2]) : count) : a;
    if (a < 1 || b < a || a > count) return null;
    for (let i = a; i <= Math.min(b, count); i++) out.push(i - 1);
  }
  return out.length ? out : null;
}

// ---------- Stamps ----------
export const STAMPS = [
  { label: 'Approved', color: '#1f9d55' },
  { label: 'Reviewed', color: '#2b6fdc' },
  { label: 'Draft', color: '#2b6fdc' },
  { label: 'Final', color: '#1f9d55' },
  { label: 'Confidential', color: '#d93a3a' },
  { label: 'Not approved', color: '#d93a3a' },
  { label: 'For comment', color: '#e8711a' },
  { label: 'Received', color: '#6a4cd6', dated: true },
  { label: 'Paid', color: '#1f9d55', dated: true },
  { label: 'Void', color: '#d93a3a' },
];

export function today() {
  return new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// A rubber-stamp style picture (PNG data URL).
export function stampImage(label, color, dated = false) {
  const scale = 4;
  const font = '800 26px -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
  const small = '600 12px -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = font;
  const text = label.toUpperCase();
  const w = Math.ceil(probe.measureText(text).width) + 36;
  const h = dated ? 62 : 46;
  const canvas = document.createElement('canvas');
  canvas.width = w * scale; canvas.height = h * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 3;
  const r = 8;
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(2, 2, w - 4, h - 4, r) : ctx.rect(2, 2, w - 4, h - 4);
  ctx.stroke();
  ctx.globalAlpha = 0.08; ctx.fill(); ctx.globalAlpha = 1;
  ctx.font = font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, dated ? 24 : h / 2 + 1);
  if (dated) { ctx.font = small; ctx.fillText(today(), w / 2, 46); }
  return canvas.toDataURL('image/png');
}

// ---------- Header, footer and watermark ----------
// data.marks = { header: { text, align }, footer: { text, align }, watermark: { text, color, opacity } }
export function fillTokens(text, n, total, title) {
  return String(text)
    .replace(/\{page\}/gi, String(n))
    .replace(/\{pages\}/gi, String(total))
    .replace(/\{date\}/gi, today())
    .replace(/\{title\}/gi, title || '');
}

// Where each mark sits on a page as it is displayed (upright), in display units
// with y going down. measure(text, size) gives the width of the text.
export function layoutMarks(marks, { width, height }, n, total, title, measure) {
  const out = [];
  if (!marks) return out;
  const margin = Math.max(18, Math.min(width, height) * 0.045);
  const size = Math.max(8, Math.min(11, width / 55));
  for (const [key, top] of [['header', true], ['footer', false]]) {
    const m = marks[key];
    if (!m?.text?.trim()) continue;
    const text = fillTokens(m.text, n, total, title);
    const w = measure(text, size);
    const x = m.align === 'left' ? margin : m.align === 'right' ? width - margin - w : (width - w) / 2;
    const y = top ? margin + size : height - margin;
    out.push({ text, x, y, size, angle: 0, color: m.color || '#555555', opacity: 1 });
  }
  const wm = marks.watermark;
  if (wm?.text?.trim()) {
    const text = fillTokens(wm.text, n, total, title);
    const angle = wm.angle ?? 45;
    const rad = angle * Math.PI / 180;
    const diag = Math.abs(width * Math.cos(rad)) + Math.abs(height * Math.sin(rad));
    const s = Math.max(12, Math.min(140, (diag * 0.6) / (measure(text, 1) || 1)));
    const w = measure(text, s);
    // Centre the text: start half its length back along its direction, and drop by a third of its height.
    const ux = Math.cos(rad); const uy = -Math.sin(rad);
    const x = width / 2 - ux * w / 2 - uy * s * 0.35;
    const y = height / 2 - uy * w / 2 + ux * s * 0.35;
    out.push({ text, x, y, size: s, angle, color: wm.color || '#d93a3a', opacity: wm.opacity ?? 0.18 });
  }
  return out;
}

// ---------- Sticky notes as real PDF comments ----------
export function addNoteAnnotation(out, page, lib, note, X, Y) {
  const { PDFHexString, pushGraphicsState, popGraphicsState, setFillingRgbColor, setStrokingRgbColor, setLineWidth, rectangle, fill, stroke, moveTo, lineTo } = lib;
  const [r, g, b] = hexToRgb(note.color || '#ffd400');
  const size = 18;
  const x = X(note.x); const y = Y(note.y);
  const ap = out.context.formXObject([
    pushGraphicsState(),
    setFillingRgbColor(r, g, b), rectangle(0, 0, size, size), fill(),
    setStrokingRgbColor(0.35, 0.3, 0.1), setLineWidth(0.8), rectangle(0.4, 0.4, size - 0.8, size - 0.8), stroke(),
    moveTo(4, 12.5), lineTo(14, 12.5), moveTo(4, 9), lineTo(14, 9), moveTo(4, 5.5), lineTo(10, 5.5), stroke(),
    popGraphicsState(),
  ], { BBox: [0, 0, size, size], Resources: {} });
  const dict = out.context.obj({
    Type: 'Annot', Subtype: 'Text', Name: 'Comment', F: 28,
    Rect: [x, y - size, x + size, y],
    Contents: PDFHexString.fromText(note.text || ''),
    T: PDFHexString.fromText(note.author || 'Plain Office'),
    C: [r, g, b], Open: false,
    AP: { N: out.context.register(ap) },
  });
  page.node.addAnnot(out.context.register(dict));
}

export function hexToRgb(hex) {
  const n = parseInt(String(hex).replace('#', '').padEnd(6, '0').slice(0, 6), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// ---------- Forms ----------
async function loadLib(bytes, password) {
  const lib = await import('@cantoo/pdf-lib');
  const doc = await lib.PDFDocument.load(bytes, { password, updateMetadata: false });
  return { lib, doc };
}

// The fillable fields in a PDF: [{ name, label, type: 'text'|'check'|'choice'|'radio', value, options, multiline }]
export async function readFields(bytes, password) {
  let loaded;
  try { loaded = await loadLib(bytes, password); } catch { return []; }
  const { lib, doc } = loaded;
  let fields;
  try { fields = doc.getForm().getFields(); } catch { return []; }
  const out = [];
  for (const f of fields) {
    const name = f.getName();
    const label = name.split('.').pop().replace(/[_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().replace(/^./, (c) => c.toUpperCase()) || name;
    try {
      if (f.isReadOnly?.()) continue;
      if (f instanceof lib.PDFTextField) out.push({ name, label, type: 'text', value: f.getText() || '', multiline: f.isMultiline() });
      else if (f instanceof lib.PDFCheckBox) out.push({ name, label, type: 'check', value: f.isChecked() });
      else if (f instanceof lib.PDFDropdown || f instanceof lib.PDFOptionList) out.push({ name, label, type: 'choice', value: f.getSelected()[0] || '', options: f.getOptions() });
      else if (f instanceof lib.PDFRadioGroup) out.push({ name, label, type: 'radio', value: f.getSelected() || '', options: f.getOptions() });
    } catch { /* odd field: skip it */ }
  }
  return out;
}

// Writes values into the form and returns the new file (no longer password locked).
export async function fillFields(bytes, password, values) {
  const { lib, doc } = await loadLib(bytes, password);
  const form = doc.getForm();
  const font = await doc.embedFont(lib.StandardFonts.Helvetica);
  for (const [name, value] of Object.entries(values)) {
    const f = form.getFieldMaybe(name);
    if (!f) continue;
    if (f instanceof lib.PDFTextField) f.setText(encodable(font, String(value ?? '')) || undefined);
    else if (f instanceof lib.PDFCheckBox) (value ? f.check() : f.uncheck());
    else if ((f instanceof lib.PDFDropdown || f instanceof lib.PDFOptionList) && value) f.select(value);
    else if (f instanceof lib.PDFRadioGroup && value) f.select(value);
  }
  form.updateFieldAppearances(font);
  return new Uint8Array(await doc.save());
}

// ---------- Converting ----------
// Text runs -> rows and columns, for PDF to Excel.
export function runsToTable(runs) {
  const level = runs.filter((r) => Math.abs(r.angle) < 2 && r.t.trim());
  if (!level.length) return [];
  level.sort((a, b) => b.y - a.y || a.x - b.x);
  // Lines: runs whose baselines are close.
  const lines = [];
  for (const r of level) {
    const line = lines.find((l) => Math.abs(l.y - r.y) < Math.max(2.5, r.size * 0.45));
    if (line) line.runs.push(r); else lines.push({ y: r.y, runs: [r] });
  }
  // Cells: runs on a line that nearly touch belong to the same cell.
  const cellLines = lines.map((l) => {
    const sorted = l.runs.sort((a, b) => a.x - b.x);
    const cells = [];
    for (const r of sorted) {
      const last = cells[cells.length - 1];
      if (last && r.x - last.end < r.size * 0.9) {
        last.text += (r.x - last.end > r.size * 0.15 ? ' ' : '') + r.t;
        last.end = r.x + r.w;
      } else cells.push({ x: r.x, end: r.x + r.w, text: r.t });
    }
    return cells;
  });
  // Columns: line cells up by where they start.
  const starts = [];
  for (const cells of cellLines) for (const c of cells) {
    const col = starts.find((s) => Math.abs(s.x - c.x) < 14);
    if (col) { col.x = (col.x * col.n + c.x) / (col.n + 1); col.n++; } else starts.push({ x: c.x, n: 1 });
  }
  starts.sort((a, b) => a.x - b.x);
  const colOf = (x) => starts.reduce((best, s, i) => (Math.abs(s.x - x) < Math.abs(starts[best].x - x) ? i : best), 0);
  return cellLines.map((cells) => {
    const row = [];
    for (const c of cells) {
      let i = colOf(c.x);
      while (row[i] != null) i++;
      row[i] = asValue(c.text.trim());
    }
    for (let i = 0; i < row.length; i++) if (row[i] == null) row[i] = '';
    return row;
  });
}

function asValue(text) {
  const plain = text.replace(/[,\s]/g, '');
  if (/^-?\d+(\.\d+)?$/.test(plain) && plain.length < 16) return Number(plain);
  return text;
}

// Several files to hand over at once: phones share them together; elsewhere they go in a .zip.
export async function exportMany(files, zipName) {
  const { exportFile } = await import('../files.js');
  if (files.length === 1) return exportFile(files[0].blob, files[0].name);
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  for (const f of files) zip.file(f.name, f.blob);
  return exportFile(await zip.generateAsync({ type: 'blob' }), zipName);
}
