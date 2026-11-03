// Apple iWork (.pages, .key) reader. Numbers files are read by SheetJS.
//
// Modern iWork files are zips of "IWA" files: Snappy-compressed chunks of
// protobuf messages. We decode just enough to pull out the text storages
// (TSWP.StorageArchive), which is where all typed text lives. Older iWork '09
// files keep an index.xml instead, and we read that as a fallback.

import { escapeHtml } from '../../ui.js';

// ---------- Snappy (raw, as used inside IWA chunks) ----------
function snappy(src) {
  let pos = 0;
  let len = 0;
  for (let shift = 0; ; shift += 7) {
    const b = src[pos++];
    len += (b & 0x7f) * 2 ** shift;
    if (b < 0x80) break;
  }
  const out = new Uint8Array(len);
  let op = 0;
  while (pos < src.length && op < len) {
    const tag = src[pos++];
    const type = tag & 3;
    if (type === 0) {
      let n = tag >> 2;
      if (n >= 60) {
        const bytes = n - 59;
        n = 0;
        for (let i = 0; i < bytes; i++) n += src[pos++] * 2 ** (8 * i);
      }
      n += 1;
      out.set(src.subarray(pos, pos + n), op);
      pos += n;
      op += n;
    } else {
      let n;
      let off;
      if (type === 1) {
        n = ((tag >> 2) & 7) + 4;
        off = ((tag >> 5) << 8) | src[pos++];
      } else if (type === 2) {
        n = (tag >> 2) + 1;
        off = src[pos] | (src[pos + 1] << 8);
        pos += 2;
      } else {
        n = (tag >> 2) + 1;
        off = (src[pos] | (src[pos + 1] << 8) | (src[pos + 2] << 16)) + src[pos + 3] * 2 ** 24;
        pos += 4;
      }
      for (let i = 0; i < n; i++, op++) out[op] = out[op - off];
    }
  }
  return out;
}

function inflateIwa(data) {
  const parts = [];
  let pos = 0;
  while (pos + 4 <= data.length) {
    const size = data[pos + 1] | (data[pos + 2] << 8) | (data[pos + 3] << 16);
    parts.push(snappy(data.subarray(pos + 4, pos + 4 + size)));
    pos += 4 + size;
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// ---------- Minimal protobuf ----------
function varint(buf, state) {
  let value = 0;
  for (let shift = 0; ; shift += 7) {
    const b = buf[state.pos++];
    if (b === undefined) throw new Error('truncated');
    value += (b & 0x7f) * 2 ** shift;
    if (b < 0x80) return value;
  }
}

function fields(buf) {
  const out = [];
  const state = { pos: 0 };
  while (state.pos < buf.length) {
    const key = varint(buf, state);
    const num = Math.floor(key / 8);
    const wire = key % 8;
    if (wire === 0) out.push({ num, value: varint(buf, state) });
    else if (wire === 2) {
      const len = varint(buf, state);
      out.push({ num, bytes: buf.subarray(state.pos, state.pos + len) });
      state.pos += len;
    } else if (wire === 1) state.pos += 8;
    else if (wire === 5) state.pos += 4;
    else throw new Error('bad wire type');
  }
  return out;
}

// Yields { type, payload } for every message in an inflated IWA stream.
function* messages(buf) {
  const state = { pos: 0 };
  while (state.pos < buf.length) {
    const infoLen = varint(buf, state);
    const info = fields(buf.subarray(state.pos, state.pos + infoLen));
    state.pos += infoLen;
    const id = info.find((x) => x.num === 1)?.value;
    for (const f of info) {
      if (f.num !== 2 || !f.bytes) continue;
      const mi = fields(f.bytes);
      const type = mi.find((x) => x.num === 1)?.value;
      const length = mi.find((x) => x.num === 3)?.value || 0;
      yield { id, type, payload: buf.subarray(state.pos, state.pos + length) };
      state.pos += length;
    }
  }
}

const utf8 = new TextDecoder();
const STORAGE_TYPES = new Set([2001, 2005]);
const KIND = { BODY: 0, HEADER: 1, FOOTNOTE: 2, TEXTBOX: 3, NOTE: 4, CELL: 5 };

// Text storages in one IWA file: [{ kind, text }]
function storages(iwa) {
  const out = [];
  let buf;
  try { buf = inflateIwa(iwa); } catch { return out; }
  try {
    for (const { type, payload } of messages(buf)) {
      if (!STORAGE_TYPES.has(type)) continue;
      try {
        const f = fields(payload);
        const kind = f.find((x) => x.num === 1)?.value ?? KIND.BODY;
        const text = f.filter((x) => x.num === 3 && x.bytes).map((x) => utf8.decode(x.bytes)).join('');
        if (text.replace(/[\s\ufffc]/g, '')) out.push({ kind, text });
      } catch { /* skip a message we can't read */ }
    }
  } catch { /* keep what we have */ }
  return out;
}

function textToHtml(text) {
  return text
    .replace(/\ufffc/g, '')
    .split(/\r\n|[\n\r\u2029]/)
    .map((line) => `<p>${escapeHtml(line).replace(/\u2028/g, '<br>').replace(/\t/g, '&emsp;') || '<br>'}</p>`)
    .join('');
}

async function previewImage(zip) {
  for (const name of ['preview.jpg', 'QuickLook/Preview.jpg', 'QuickLook/Thumbnail.jpg', 'preview-web.jpg']) {
    const f = zip.file(name);
    if (f) return `data:image/jpeg;base64,${await f.async('base64')}`;
  }
  return null;
}

async function legacyXmlText(zip) {
  const f = zip.file('index.xml') || zip.file('index.apxl');
  let xml = f ? await f.async('text') : null;
  const gz = !xml && (zip.file('index.xml.gz') || zip.file('index.apxl.gz'));
  if (gz && typeof DecompressionStream !== 'undefined') {
    const stream = new Blob([await gz.async('uint8array')]).stream().pipeThrough(new DecompressionStream('gzip'));
    xml = await new Response(stream).text();
  }
  if (!xml) return null;
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const paras = [...doc.getElementsByTagName('sf:p')].map((p) => p.textContent);
  return paras.length ? paras : null;
}

async function openZip(bytes) {
  const JSZip = (await import('jszip')).default;
  return JSZip.loadAsync(bytes);
}

const iwaFiles = (zip, pattern) => Object.keys(zip.files).filter((n) => pattern.test(n)).sort((a, b) => {
  const na = Number(a.match(/(\d+)\.iwa$/)?.[1] || 0);
  const nb = Number(b.match(/(\d+)\.iwa$/)?.[1] || 0);
  return na - nb || a.localeCompare(b);
});

// .pages -> HTML for the Docs editor
export async function pagesToHtml(bytes) {
  const zip = await openZip(bytes);
  const html = [];
  const doc = zip.file('Index/Document.iwa');
  if (doc) {
    const found = storages(await doc.async('uint8array'));
    const order = [KIND.BODY, KIND.TEXTBOX, KIND.FOOTNOTE];
    for (const kind of order) for (const s of found.filter((x) => x.kind === kind)) html.push(textToHtml(s.text));
  } else {
    const paras = await legacyXmlText(zip);
    if (paras) html.push(paras.map((p) => `<p>${escapeHtml(p) || '<br>'}</p>`).join(''));
  }
  if (html.length) return html.join('');
  const img = await previewImage(zip);
  if (img) return `<p><i>Only a preview of this Pages file could be shown.</i></p><p><img src="${img}" alt=""></p>`;
  throw new Error('Could not read this Pages file');
}

// Object references (TSP.Reference = a message holding just field 1) inside a
// message, in the order they appear.
function references(payload, depth = 0, out = []) {
  let parsed;
  try { parsed = fields(payload); } catch { return out; }
  for (const f of parsed) {
    if (!f.bytes || depth > 3) continue;
    let sub;
    try { sub = fields(f.bytes); } catch { continue; }
    if (sub.length === 1 && sub[0].num === 1 && sub[0].value !== undefined) out.push(sub[0].value);
    else references(f.bytes, depth + 1, out);
  }
  return out;
}

function archives(iwa) {
  try { return [...messages(inflateIwa(iwa))]; } catch { return []; }
}

// Keynote keeps slides in separate files; their order lives in Document.iwa as
// a slide tree -> slide nodes -> slides chain of references.
async function orderedSlideFiles(zip) {
  const names = iwaFiles(zip, /^Index\/Slide[^/]*\.iwa$/);
  const doc = zip.file('Index/Document.iwa');
  if (!doc || names.length < 2) return names;
  const fileOfId = new Map();
  for (const name of names) {
    for (const a of archives(await zip.file(name).async('uint8array'))) if (a.id !== undefined) fileOfId.set(a.id, name);
  }
  const docArchives = archives(await doc.async('uint8array'));
  const nodeToFile = new Map();
  for (const a of docArchives) {
    const hit = references(a.payload).find((r) => fileOfId.has(r));
    if (hit !== undefined && a.id !== undefined) nodeToFile.set(a.id, fileOfId.get(hit));
  }
  let best = [];
  for (const a of docArchives) {
    const order = references(a.payload).filter((r) => nodeToFile.has(r));
    if (order.length > best.length) best = order;
  }
  const ordered = [...new Set(best.map((id) => nodeToFile.get(id)))];
  return ordered.length ? [...ordered, ...names.filter((n) => !ordered.includes(n))] : names;
}

// .key -> [{ title, lines[] }] for the Slides editor (plus a preview image fallback)
export async function keynoteToSlides(bytes) {
  const zip = await openZip(bytes);
  const slides = [];
  for (const name of await orderedSlideFiles(zip)) {
    const found = storages(await zip.file(name).async('uint8array')).filter((s) => s.kind !== KIND.NOTE);
    if (!found.length) continue;
    const [first, ...rest] = found;
    slides.push({
      title: first.text.replace(/\ufffc/g, '').trim(),
      lines: rest.flatMap((s) => s.text.replace(/\ufffc/g, '').split(/[\n\r\u2029]/)).map((l) => l.trim()).filter(Boolean),
    });
  }
  if (!slides.length) {
    const paras = await legacyXmlText(zip);
    if (paras) slides.push({ title: paras[0] || '', lines: paras.slice(1).filter(Boolean) });
  }
  return { slides, preview: slides.length ? null : await previewImage(zip) };
}

// Which iWork app made this zip?
export function iworkKind(zip) {
  const names = Object.keys(zip.files);
  if (names.some((n) => /^Index\/Slide/.test(n)) || zip.file('index.apxl') || zip.file('index.apxl.gz')) return 'key';
  if (names.some((n) => n.startsWith('Index/Tables/'))) return 'numbers';
  if (zip.file('Index/Document.iwa') || zip.file('index.xml') || zip.file('index.xml.gz')) return 'pages';
  return null;
}
