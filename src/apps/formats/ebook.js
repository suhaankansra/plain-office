// E-books besides EPUB: FictionBook (.fb2) and Mobipocket / Kindle
// (.mobi, .azw, .azw3, .prc, .pdb) without DRM.

import { escapeHtml } from '../../ui.js';

// ---------- FictionBook ----------
export function fb2ToHtml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('This FictionBook file could not be read');
  const binaries = {};
  for (const b of doc.getElementsByTagName('binary')) {
    binaries[b.getAttribute('id')] = `data:${b.getAttribute('content-type') || 'image/jpeg'};base64,${b.textContent.replace(/\s+/g, '')}`;
  }
  const href = (el) => (el.getAttribute('l:href') || el.getAttribute('xlink:href') || el.getAttribute('href') || '').replace(/^#/, '');
  const walk = (node, depth) => [...node.childNodes].map((n) => {
    if (n.nodeType === 3) return escapeHtml(n.nodeValue);
    if (n.nodeType !== 1) return '';
    const inner = () => walk(n, depth);
    switch (n.localName) {
      case 'section': return walk(n, depth + 1);
      case 'title': return `<h${Math.min(depth + 1, 3)}>${n.textContent.trim().replace(/\s+/g, ' ')}</h${Math.min(depth + 1, 3)}>`;
      case 'subtitle': return `<h3>${inner()}</h3>`;
      case 'p': case 'v': case 'text-author': return `<p>${inner() || '<br>'}</p>`;
      case 'empty-line': return '<p><br></p>';
      case 'emphasis': return `<i>${inner()}</i>`;
      case 'strong': return `<b>${inner()}</b>`;
      case 'strikethrough': return `<s>${inner()}</s>`;
      case 'sup': return `<sup>${inner()}</sup>`;
      case 'sub': return `<sub>${inner()}</sub>`;
      case 'epigraph': case 'cite': return `<blockquote>${inner()}</blockquote>`;
      case 'image': return binaries[href(n)] ? `<p><img src="${binaries[href(n)]}" alt=""></p>` : '';
      case 'a': return inner();
      case 'table': return `<table><tbody>${inner()}</tbody></table>`;
      case 'tr': return `<tr>${inner()}</tr>`;
      case 'td': case 'th': return `<td>${inner()}</td>`;
      default: return inner();
    }
  }).join('');
  const title = doc.getElementsByTagName('book-title')[0]?.textContent;
  const bodies = [...doc.getElementsByTagName('body')].filter((b) => b.getAttribute('name') !== 'notes');
  const html = bodies.map((b) => walk(b, 0)).join('<hr>');
  return (title ? `<h1>${escapeHtml(title)}</h1>` : '') + html;
}

// ---------- Mobipocket / Kindle ----------
const be16 = (b, o) => (b[o] << 8) | b[o + 1];
const be32 = (b, o) => b[o] * 0x1000000 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);

// PalmDOC LZ77.
export function palmdoc(data) {
  const out = [];
  let i = 0;
  while (i < data.length) {
    const c = data[i++];
    if (c === 0 || (c >= 0x09 && c <= 0x7f)) out.push(c);
    else if (c <= 0x08) { for (let k = 0; k < c && i < data.length; k++) out.push(data[i++]); }
    else if (c <= 0xbf) {
      const v = (c << 8) | data[i++];
      const dist = (v >> 3) & 0x7ff;
      const len = (v & 7) + 3;
      for (let k = 0; k < len; k++) out.push(out[out.length - dist]);
    } else {
      out.push(0x20, c ^ 0x80);
    }
  }
  return Uint8Array.from(out);
}

// Size of the extra bytes Kindle appends to each text record.
function trailingSize(rec, flags) {
  let size = 0;
  for (let f = flags >> 1; f; f >>= 1) {
    if (!(f & 1)) continue;
    let value = 0;
    const end = rec.length - size;
    for (let i = Math.max(0, end - 4); i < end; i++) {
      if (rec[i] & 0x80) value = 0;
      value = (value << 7) | (rec[i] & 0x7f);
    }
    size += value;
  }
  if (flags & 1) size += (rec[rec.length - size - 1] & 0x3) + 1;
  return size;
}

function sniffImage(rec) {
  if (rec[0] === 0xff && rec[1] === 0xd8) return 'image/jpeg';
  if (rec[0] === 0x89 && rec[1] === 0x50) return 'image/png';
  if (rec[0] === 0x47 && rec[1] === 0x49) return 'image/gif';
  return null;
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return btoa(s);
}

export function mobiToHtml(bytes) {
  const count = be16(bytes, 76);
  const offsets = Array.from({ length: count }, (_, i) => be32(bytes, 78 + i * 8));
  const record = (i) => bytes.subarray(offsets[i], i + 1 < count ? offsets[i + 1] : bytes.length);
  const r0 = record(0);
  const compression = be16(r0, 0);
  const textRecords = be16(r0, 8);
  const encryption = be16(r0, 12);
  if (encryption !== 0) throw new Error('This e-book is protected by DRM and cannot be opened');
  if (compression === 17480) throw new Error('This Kindle book uses compression Plain Office cannot read yet');

  const isMobi = String.fromCharCode(...r0.subarray(16, 20)) === 'MOBI';
  let encoding = 'windows-1252';
  let extraFlags = 0;
  let firstImage = -1;
  let title = '';
  if (isMobi) {
    const headerLen = be32(r0, 20);
    if (be32(r0, 28) === 65001) encoding = 'utf-8';
    firstImage = be32(r0, 0x6c);
    if (headerLen >= 0xe4) extraFlags = be16(r0, 0xf2);
    const nameOffset = be32(r0, 0x54);
    const nameLength = be32(r0, 0x58);
    title = new TextDecoder(encoding).decode(r0.subarray(nameOffset, nameOffset + nameLength));
  }

  const chunks = [];
  for (let i = 1; i <= textRecords && i < count; i++) {
    let rec = record(i);
    if (extraFlags) rec = rec.subarray(0, rec.length - trailingSize(rec, extraFlags));
    chunks.push(compression === 2 ? palmdoc(rec) : rec);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.length; }
  const text = new TextDecoder(encoding).decode(all);

  if (!isMobi && !/<(p|div|html|body|h\d)[\s>]/i.test(text)) {
    // Plain PalmDOC text.
    return text.split(/\r?\n/).map((l) => `<p>${escapeHtml(l) || '<br>'}</p>`).join('');
  }
  // Mobipocket markup is HTML with a few special tags; pictures are numbered records.
  const html = text
    .replace(/<mbp:pagebreak\s*\/?>/gi, '<hr>')
    .replace(/<\/?mbp:[^>]*>/gi, '')
    .replace(/<img([^>]*?)recindex="?(\d+)"?([^>]*)>/gi, (m, a, num) => {
      const idx = firstImage + Number(num) - 1;
      if (firstImage < 0 || idx >= count) return '';
      const rec = record(idx);
      const mime = sniffImage(rec);
      return mime ? `<img src="data:${mime};base64,${toBase64(rec)}" alt="">` : '';
    });
  return (title ? `<h1>${escapeHtml(title)}</h1>` : '') + html;
}
