// Old binary Microsoft Office files: Word 97-2003 (.doc) and PowerPoint
// 97-2003 (.ppt). Both are OLE compound files; SheetJS's CFB reader opens the
// container and we pull the text out of the streams. (Old .xls is handled by
// SheetJS directly.)

import { CFB } from 'xlsx';
import { escapeHtml } from '../../ui.js';

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;

function stream(cfb, name) {
  const entry = CFB.find(cfb, name);
  if (!entry?.content) return null;
  return entry.content instanceof Uint8Array ? entry.content : Uint8Array.from(entry.content);
}

export function isCompoundFile(bytes) {
  return bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
}

export function compoundKind(bytes) {
  try {
    const cfb = CFB.read(bytes, { type: 'array' });
    if (CFB.find(cfb, 'WordDocument')) return 'doc';
    if (CFB.find(cfb, 'PowerPoint Document')) return 'ppt';
    if (CFB.find(cfb, 'Workbook') || CFB.find(cfb, 'Book')) return 'xls';
  } catch { /* not a compound file */ }
  return null;
}

const cp1252 = new TextDecoder('windows-1252');
const utf16 = new TextDecoder('utf-16le');

// ---------- Word ----------
function cleanWordText(text) {
  // Fields: \x13 instructions \x14 result \x15 -> keep the result only.
  let out = '';
  const depth = [];
  for (const ch of text) {
    if (ch === '\x13') { depth.push('code'); continue; }
    if (ch === '\x14') { if (depth.length) depth[depth.length - 1] = 'result'; continue; }
    if (ch === '\x15') { depth.pop(); continue; }
    if (depth.includes('code')) continue;
    out += ch;
  }
  return out
    .replace(/[\x01\x02\x05\x08]/g, '')
    .replace(/\x1e/g, '-')
    .replace(/\x1f/g, '')
    .replace(/\x0b/g, '\n')
    .replace(/\x0c/g, '\r');
}

function wordPieces(doc, table, ccpText) {
  const fcClx = u32(doc, 0x1a2);
  const lcbClx = u32(doc, 0x1a6);
  if (!lcbClx || fcClx + lcbClx > table.length) return null;
  let pos = fcClx;
  while (table[pos] === 0x01) pos += 3 + u16(table, pos + 1);
  if (table[pos] !== 0x02) return null;
  const lcb = u32(table, pos + 1);
  const plc = pos + 5;
  const n = (lcb - 4) / 12;
  let text = '';
  for (let i = 0; i < n && text.length < ccpText; i++) {
    const cpStart = u32(table, plc + i * 4);
    const cpEnd = u32(table, plc + (i + 1) * 4);
    const pcd = plc + (n + 1) * 4 + i * 8;
    const fcRaw = u32(table, pcd + 2);
    const compressed = (fcRaw & 0x40000000) !== 0;
    const fc = fcRaw & 0x3fffffff;
    const count = cpEnd - cpStart;
    text += compressed
      ? cp1252.decode(doc.subarray(fc / 2, fc / 2 + count))
      : utf16.decode(doc.subarray(fc, fc + count * 2));
  }
  return text.slice(0, ccpText);
}

export function docToHtml(bytes) {
  const cfb = CFB.read(bytes, { type: 'array' });
  const doc = stream(cfb, 'WordDocument');
  if (!doc || u16(doc, 0) !== 0xa5ec) throw new Error('This .doc file could not be read');
  const flags = u16(doc, 0x0a);
  if (flags & 0x0100) throw new Error('This .doc file is password-protected');
  const table = stream(cfb, flags & 0x0200 ? '1Table' : '0Table');
  const ccpText = u32(doc, 0x4c);
  let text = table && wordPieces(doc, table, ccpText);
  if (!text) {
    // Word 6/95 or unusual files: fall back to the plain 8-bit text block.
    const fcMin = u32(doc, 0x18);
    const fcMac = u32(doc, 0x1c);
    text = cp1252.decode(doc.subarray(fcMin, fcMac));
  }
  // Table cells end with \x07 and each row with an extra \x07.
  const html = [];
  let rows = [];
  const closeTable = () => {
    if (!rows.length) return;
    html.push(`<table><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
    rows = [];
  };
  const para = (p) => html.push(`<p>${escapeHtml(p).replace(/\n/g, '<br>').replace(/\t/g, '&emsp;') || '<br>'}</p>`);
  for (const p of cleanWordText(text).split('\r')) {
    if (p.includes('\x07')) {
      const parts = p.split('\x07\x07');
      const rest = parts.pop();
      for (const row of parts) rows.push(row.split('\x07'));
      if (rest.includes('\x07')) rows.push(rest.split('\x07').filter((c, i, a) => c || i < a.length - 1));
      else if (rest) { closeTable(); para(rest); }
      continue;
    }
    closeTable();
    para(p);
  }
  closeTable();
  return html.join('');
}

// ---------- PowerPoint ----------
const REC = { SlideListWithText: 0x0ff0, SlidePersistAtom: 0x03f3, TextHeaderAtom: 0x0f9f, TextCharsAtom: 0x0fa0, TextBytesAtom: 0x0fa8, Slide: 0x03ee };

function* records(buf, start, end) {
  let pos = start;
  while (pos + 8 <= end) {
    const verInst = u16(buf, pos);
    const type = u16(buf, pos + 2);
    const len = u32(buf, pos + 4);
    yield { ver: verInst & 0xf, inst: verInst >> 4, type, start: pos + 8, end: Math.min(pos + 8 + len, end) };
    pos += 8 + len;
  }
}

function atomText(buf, rec) {
  if (rec.type === REC.TextCharsAtom) return utf16.decode(buf.subarray(rec.start, rec.end));
  if (rec.type === REC.TextBytesAtom) return cp1252.decode(buf.subarray(rec.start, rec.end));
  return null;
}

// .ppt -> [{ title, lines[] }]
export function pptToSlides(bytes) {
  const cfb = CFB.read(bytes, { type: 'array' });
  const buf = stream(cfb, 'PowerPoint Document');
  if (!buf) throw new Error('This .ppt file could not be read');
  const fromList = [];
  const fromSlides = [];

  const walk = (start, end, ctx) => {
    for (const rec of records(buf, start, end)) {
      if (rec.ver === 0xf) {
        if (rec.type === REC.SlideListWithText && rec.inst === 0) walk(rec.start, rec.end, { list: true });
        else if (rec.type === REC.Slide) { fromSlides.push({ title: '', lines: [] }); walk(rec.start, rec.end, { slide: true }); }
        else walk(rec.start, rec.end, ctx);
        continue;
      }
      if (ctx.list && rec.type === REC.SlidePersistAtom) { fromList.push({ title: '', lines: [], kind: null }); continue; }
      if (ctx.list && rec.type === REC.TextHeaderAtom) { if (fromList.length) fromList.at(-1).kind = u32(buf, rec.start); continue; }
      const text = atomText(buf, rec);
      if (text == null) continue;
      const target = ctx.list ? fromList.at(-1) : ctx.slide ? fromSlides.at(-1) : null;
      if (!target) continue;
      const parts = text.split(/[\r\x0b]/).map((s) => s.trim()).filter(Boolean);
      const isTitle = ctx.list ? target.kind === 0 || target.kind === 6 : !target.title;
      if (isTitle && !target.title) target.title = parts.shift() || '';
      target.lines.push(...parts);
    }
  };
  walk(0, buf.length, {});
  const slides = (fromList.some((s) => s.title || s.lines.length) ? fromList : fromSlides).map(({ title, lines }) => ({ title, lines }));
  if (!slides.length) throw new Error('No slides found in this .ppt file');
  return slides;
}
