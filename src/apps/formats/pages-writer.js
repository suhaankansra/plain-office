// Writes Apple Pages (.pages) files.
//
// Pages has no public file format, so we start from a blank document saved
// by Pages itself (public/templates/blank.pages) and put the text into its
// body. The body is a TSWP.StorageArchive: one string with paragraphs
// separated by "\r" (field 3), plus a table of where each paragraph starts
// (field 5). Everything else in the template is written back untouched.

import { inflateIwa } from './iwork.js';

// ---------- Protobuf that keeps every field ----------
function readVarint(buf, s) {
  let value = 0;
  for (let shift = 0; ; shift += 7) {
    const b = buf[s.pos++];
    value += (b & 0x7f) * 2 ** shift;
    if (b < 0x80) return value;
  }
}

function parse(buf) {
  const out = [];
  const s = { pos: 0 };
  while (s.pos < buf.length) {
    const key = readVarint(buf, s);
    const num = Math.floor(key / 8);
    const wire = key % 8;
    if (wire === 0) out.push({ num, wire, value: readVarint(buf, s) });
    else if (wire === 2) {
      const len = readVarint(buf, s);
      out.push({ num, wire, bytes: buf.subarray(s.pos, s.pos + len) });
      s.pos += len;
    } else if (wire === 1 || wire === 5) {
      const len = wire === 1 ? 8 : 4;
      out.push({ num, wire, bytes: buf.subarray(s.pos, s.pos + len) });
      s.pos += len;
    } else {
      throw new Error(`Unsupported protobuf wire type ${wire}`);
    }
  }
  return out;
}

function packedValues(bytes) {
  const s = { pos: 0 };
  const out = [];
  while (s.pos < bytes.length) out.push(readVarint(bytes, s));
  return out;
}

function pushVarint(out, n) {
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
}

function encode(fields) {
  const parts = [];
  for (const f of fields) {
    const head = [];
    pushVarint(head, f.num * 8 + f.wire);
    if (f.wire === 0) pushVarint(head, f.value);
    else if (f.wire === 2) pushVarint(head, f.bytes.length);
    parts.push(Uint8Array.from(head));
    if (f.wire !== 0) parts.push(f.bytes);
  }
  return concat(parts);
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// ---------- IWA chunks (Snappy, stored as literals) ----------
function snappyLiterals(data) {
  const out = [];
  pushVarint(out, data.length);
  const parts = [Uint8Array.from(out)];
  for (let pos = 0; pos < data.length; pos += 65536) {
    const block = data.subarray(pos, pos + 65536);
    const n = block.length - 1;
    const tag = n < 60 ? [n << 2] : n < 256 ? [60 << 2, n] : [61 << 2, n & 0xff, n >> 8];
    parts.push(Uint8Array.from(tag), block);
  }
  return concat(parts);
}

function deflateIwa(stream) {
  const parts = [];
  for (let pos = 0; pos < stream.length; pos += 65536) {
    const body = snappyLiterals(stream.subarray(pos, pos + 65536));
    parts.push(Uint8Array.from([0, body.length & 0xff, (body.length >> 8) & 0xff, (body.length >> 16) & 0xff]), body);
  }
  return concat(parts);
}

// ---------- Body text ----------
const utf8 = new TextEncoder();

function clean(text) {
  return String(text)
    .replace(/\r\n?|\u2029/g, '\n')
    .replace(/\n/g, '\u2028') // a line break inside a paragraph
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffc]/g, '');
}

function rewriteBody(payload, paragraphs) {
  const texts = paragraphs.map((p) => clean(p.text));
  const text = texts.join('\r');
  const starts = [0];
  for (const t of texts.slice(0, -1)) starts.push(starts.at(-1) + t.length + 1);
  const out = [];
  for (const f of parse(payload)) {
    if (f.num === 3) continue;
    if (f.num === 5) {
      // One entry per paragraph: where it starts and which paragraph style it uses.
      const entries = starts.map((start, i) => {
        const fields = [{ num: 1, wire: 0, value: start }];
        if (paragraphs[i].styleId) fields.push({ num: 2, wire: 2, bytes: encode([{ num: 1, wire: 0, value: paragraphs[i].styleId }]) });
        return { num: 1, wire: 2, bytes: encode(fields) };
      });
      out.push({ ...f, bytes: encode(entries) });
      continue;
    }
    out.push(f);
    if (f.num === 2 && text) out.push({ num: 3, wire: 2, bytes: utf8.encode(text) });
  }
  return encode(out);
}

function rewriteDocument(stream, paragraphs) {
  const s = { pos: 0 };
  const out = [];
  let done = false;
  while (s.pos < stream.length) {
    const infoLen = readVarint(stream, s);
    const info = parse(stream.subarray(s.pos, s.pos + infoLen));
    s.pos += infoLen;
    const payloads = [];
    let changed = false;
    const newInfo = info.map((f) => {
      if (f.num !== 2) return f;
      const mi = parse(f.bytes);
      const type = mi.find((x) => x.num === 1)?.value;
      const length = mi.find((x) => x.num === 3)?.value || 0;
      let payload = stream.subarray(s.pos, s.pos + length);
      s.pos += length;
      const kind = type === 2001 && parse(payload).find((x) => x.num === 1)?.value;
      if (!done && type === 2001 && kind === 0) {
        payload = rewriteBody(payload, paragraphs);
        done = true;
        changed = true;
        payloads.push(payload);
        // The record lists every object it points to; add the paragraph styles we used.
        const refs = mi.filter((x) => x.num === 5).flatMap((x) => (x.wire === 2 ? packedValues(x.bytes) : [x.value]));
        for (const p of paragraphs) if (p.styleId && !refs.includes(p.styleId)) refs.push(p.styleId);
        const packed = [];
        for (const r of refs) pushVarint(packed, r);
        const rest = mi.filter((x) => x.num !== 5).map((x) => (x.num === 3 ? { ...x, value: payload.length } : x));
        return { ...f, bytes: encode([...rest, { num: 5, wire: 2, bytes: Uint8Array.from(packed) }]) };
      }
      payloads.push(payload);
      return f;
    });
    const infoBytes = changed ? encode(newInfo) : encode(info);
    const head = [];
    pushVarint(head, infoBytes.length);
    out.push(Uint8Array.from(head), infoBytes, ...payloads);
  }
  if (!done) throw new Error('The Pages template has no body text');
  return concat(out);
}

// Paragraph style ids by name ("Title", "Heading", "Heading 2", "Body"...) from DocumentStylesheet.iwa.
function paragraphStyles(stream) {
  const styles = {};
  const s = { pos: 0 };
  while (s.pos < stream.length) {
    const infoLen = readVarint(stream, s);
    const info = parse(stream.subarray(s.pos, s.pos + infoLen));
    s.pos += infoLen;
    const id = info.find((f) => f.num === 1)?.value;
    for (const f of info.filter((x) => x.num === 2)) {
      const mi = parse(f.bytes);
      const length = mi.find((x) => x.num === 3)?.value || 0;
      const payload = stream.subarray(s.pos, s.pos + length);
      s.pos += length;
      if (mi.find((x) => x.num === 1)?.value !== 2022) continue; // TSWP.ParagraphStyleArchive
      const base = parse(payload).find((x) => x.num === 1);
      const name = base && parse(base.bytes).find((x) => x.num === 1 && x.wire === 2);
      if (name) styles[new TextDecoder().decode(name.bytes)] ??= id;
    }
  }
  return styles;
}

const STYLE_NAMES = { title: 'Title', h1: 'Heading', h2: 'Heading 2', h3: 'Heading 3', body: 'Body' };

// paragraphs: strings, or { text, style: 'title' | 'h1' | 'h2' | 'h3' | 'body' }.
// template: the blank .pages file's bytes.
export async function paragraphsToPages(paragraphs, template) {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(template);
  const iwa = await zip.file('Index/Document.iwa').async('uint8array');
  const styles = paragraphStyles(inflateIwa(await zip.file('Index/DocumentStylesheet.iwa').async('uint8array')));
  const list = (paragraphs.length ? paragraphs : ['']).map((p) => (typeof p === 'string' ? { text: p } : p))
    .map((p) => ({ text: p.text, styleId: styles[STYLE_NAMES[p.style || 'body']] ?? styles.Body }));
  const doc = rewriteDocument(inflateIwa(iwa), list);
  zip.file('Index/Document.iwa', deflateIwa(doc));
  // A fresh identity, and no stale "blank page" thumbnails.
  const uuid = (globalThis.crypto?.randomUUID?.() || `${Date.now()}`).toUpperCase();
  zip.file('Metadata/DocumentIdentifier', uuid);
  for (const name of ['preview.jpg', 'preview-micro.jpg', 'preview-web.jpg']) zip.remove(name);
  return zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
}

// Editor HTML -> paragraphs for Pages: blocks become paragraphs, list items
// get bullets or numbers, table rows are joined with tabs.
export function htmlToParagraphs(html) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const out = [];
  const BLOCK = /^(P|DIV|H[1-6]|LI|BLOCKQUOTE|PRE|TR|HR)$/;
  const walk = (node) => {
    for (const el of node.children) {
      if (el.tagName === 'UL' || el.tagName === 'OL') {
        const first = Number(el.getAttribute('start')) || 1;
        [...el.children].forEach((li, i) => out.push(`${el.tagName === 'OL' ? `${first + i}.` : '•'}\t${li.textContent.trim()}`));
      } else if (el.tagName === 'TABLE') {
        for (const tr of el.querySelectorAll('tr')) out.push([...tr.children].map((c) => c.textContent.trim()).join('\t'));
      } else if (el.tagName === 'HR') {
        out.push('');
      } else if (BLOCK.test(el.tagName) && ![...el.children].some((c) => BLOCK.test(c.tagName) || c.tagName === 'UL' || c.tagName === 'OL' || c.tagName === 'TABLE')) {
        const clone = el.cloneNode(true);
        clone.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
        // The editor's Title / Heading / Subheading are H1 / H2 / H3.
        const style = { H1: 'title', H2: 'h1', H3: 'h2', H4: 'h3', H5: 'h3', H6: 'h3' }[el.tagName] || 'body';
        out.push({ text: clone.textContent.trim() ? clone.textContent : '', style });
      } else {
        walk(el);
      }
    }
  };
  walk(doc.body);
  return out;
}
