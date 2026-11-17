// Writes Apple Keynote (.key) files where every slide is one picture: PDF
// pages, or slides drawn by Plain Office.
//
// Keynote has no public file format, so we start from a presentation saved by
// Keynote itself (public/templates/picture.key): one blank 1920x1080 slide
// holding one picture. For each page we copy that slide with fresh object ids,
// point the copy's picture at the page's image, and list the copy in the
// slide order (Document.iwa) and in the package index (Metadata.iwa).
//
// The pieces of a .key package that matter here:
//   Index/Slide-<id>.iwa   one slide: the slide record, its placeholders and
//                          the picture (TSD.ImageArchive, type 3005)
//   Index/Document.iwa     the show (type 2): field 3.2 lists slide nodes
//                          (type 4), and each node points at a slide (field 2),
//                          its thumbnail (field 16) and has a UUID (field 29)
//   Index/Metadata.iwa     PackageMetadata (type 11006): every component
//                          (field 3), every data file (field 4) and the last
//                          object id used (field 1)
//   Data/                  the pictures

import { inflateIwa } from './iwork.js';

// ---------- Protobuf that keeps every field byte for byte ----------
// Keynote stores 64-bit numbers (UUIDs) that don't survive a round trip
// through JavaScript numbers, so each parsed field keeps its original bytes
// and is written back from them unless we replace it.
function readVarint(buf, s) {
  let value = 0;
  for (let shift = 0; ; shift += 7) {
    if (s.pos >= buf.length) throw new Error('Damaged Keynote template');
    const b = buf[s.pos++];
    value += (b & 0x7f) * 2 ** shift;
    if (b < 0x80) return value;
  }
}

function parse(buf) {
  const out = [];
  const s = { pos: 0 };
  while (s.pos < buf.length) {
    const start = s.pos;
    const key = readVarint(buf, s);
    const num = Math.floor(key / 8);
    const wire = key % 8;
    const f = { num, wire };
    if (wire === 0) f.value = readVarint(buf, s);
    else if (wire === 2) {
      const len = readVarint(buf, s);
      f.bytes = buf.subarray(s.pos, s.pos + len);
      s.pos += len;
    } else if (wire === 1 || wire === 5) {
      const len = wire === 1 ? 8 : 4;
      f.bytes = buf.subarray(s.pos, s.pos + len);
      s.pos += len;
    } else {
      throw new Error(`Unsupported protobuf wire type ${wire}`);
    }
    f.raw = buf.subarray(start, s.pos);
    out.push(f);
  }
  return out;
}

function pushVarint(out, n) {
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function encode(fields) {
  return concat(fields.map((f) => {
    if (f.raw) return f.raw;
    const head = [];
    pushVarint(head, f.num * 8 + f.wire);
    if (f.wire === 0) { pushVarint(head, f.value); return Uint8Array.from(head); }
    if (f.wire === 2) pushVarint(head, f.bytes.length);
    return concat([Uint8Array.from(head), f.bytes]);
  }));
}

const varintField = (num, value) => ({ num, wire: 0, value });
const bytesField = (num, bytes) => ({ num, wire: 2, bytes });
const msgField = (num, fields) => bytesField(num, encode(fields));
const refField = (num, id) => msgField(num, [varintField(1, id)]); // TSP.Reference / DataReference
const utf8 = new TextEncoder();
const textField = (num, text) => bytesField(num, utf8.encode(text));
const floatField = (num, v) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setFloat32(0, v, true);
  return { num, wire: 5, bytes: b };
};
const pointField = (num, x, y) => msgField(num, [floatField(1, x), floatField(2, y)]);
const first = (fields, num) => fields.find((f) => f.num === num);
const packed = (f) => {
  if (!f) return [];
  if (f.wire === 0) return [f.value];
  const s = { pos: 0 };
  const out = [];
  while (s.pos < f.bytes.length) out.push(readVarint(f.bytes, s));
  return out;
};
const packedField = (num, values) => {
  const out = [];
  for (const v of values) pushVarint(out, v);
  return bytesField(num, Uint8Array.from(out));
};

// Replace (or add) field `num` in a message.
function setField(fields, field) {
  const i = fields.findIndex((f) => f.num === field.num);
  if (i < 0) return [...fields, field];
  return fields.map((f, j) => (j === i ? field : f));
}

// Edit the sub-message at a path of field numbers, e.g. [1, 1] for geometry.
function editAt(fields, path, edit) {
  if (!path.length) return edit(fields);
  const [num, ...rest] = path;
  const f = first(fields, num);
  const inner = editAt(f ? parse(f.bytes) : [], rest, edit);
  return setField(fields, msgField(num, inner));
}

// ---------- IWA streams ----------
function readArchives(stream) {
  const out = [];
  const s = { pos: 0 };
  while (s.pos < stream.length) {
    const len = readVarint(stream, s);
    const info = parse(stream.subarray(s.pos, s.pos + len));
    s.pos += len;
    const msgs = [];
    for (const f of info.filter((x) => x.num === 2)) {
      const mi = parse(f.bytes);
      const length = first(mi, 3)?.value || 0;
      msgs.push({ mi, type: first(mi, 1)?.value, payload: stream.subarray(s.pos, s.pos + length) });
      s.pos += length;
    }
    out.push({ id: first(info, 1).value, info, msgs });
  }
  return out;
}

function writeArchives(archives) {
  const parts = [];
  for (const a of archives) {
    const infos = a.msgs.map((m) => {
      let mi = setField(m.mi, varintField(3, m.payload.length));
      if (m.objectRefs) mi = setField(mi, packedField(5, m.objectRefs));
      if (m.dataRefs) mi = setField(mi, packedField(6, m.dataRefs));
      return msgField(2, mi);
    });
    const rest = a.info.filter((f) => f.num !== 1 && f.num !== 2);
    const info = encode([varintField(1, a.id), ...infos, ...rest]);
    const head = [];
    pushVarint(head, info.length);
    parts.push(Uint8Array.from(head), info, ...a.msgs.map((m) => m.payload));
  }
  return concat(parts);
}

// Snappy chunks with every block stored as literals: valid, just not smaller.
function deflateIwa(stream) {
  const parts = [];
  for (let pos = 0; pos < stream.length; pos += 65536) {
    const data = stream.subarray(pos, pos + 65536);
    const len = [];
    pushVarint(len, data.length);
    const n = data.length - 1;
    const tag = n < 60 ? [n << 2] : n < 256 ? [60 << 2, n] : [61 << 2, n & 0xff, n >> 8];
    const body = concat([Uint8Array.from(len), Uint8Array.from(tag), data]);
    parts.push(Uint8Array.from([0, body.length & 0xff, (body.length >> 8) & 0xff, (body.length >> 16) & 0xff]), body);
  }
  return concat(parts);
}

// ---------- Ids ----------
// Object ids in the template are 4-byte varints, and so are the new ones. That
// lets references inside records (a Reference is field 1 holding the id) be
// swapped in place without re-encoding records we don't otherwise understand.
const FOUR_BYTES = [2 ** 21, 2 ** 28];
const isFourByte = (id) => id >= FOUR_BYTES[0] && id < FOUR_BYTES[1];

function remapRefs(payload, map) {
  const out = payload.slice();
  for (let i = 0; i + 5 <= out.length; i++) {
    if (out[i] !== 0x08) continue;
    const s = { pos: i + 1 };
    let id;
    try { id = readVarint(out, s); } catch { continue; }
    if (s.pos - i - 1 !== 4 || !map.has(id)) continue;
    const bytes = [];
    pushVarint(bytes, map.get(id));
    out.set(bytes, i + 1);
    i += 4;
  }
  return out;
}

const randomU53 = () => Math.floor(Math.random() * 2 ** 53);
const uuidField = (num) => msgField(num, [varintField(1, randomU53()), varintField(2, randomU53())]);

// Keynote lists each file's SHA-1. The browser's own is only there on secure
// pages, so there's a plain one to fall back on.
async function sha1(bytes) {
  if (globalThis.crypto?.subtle) return new Uint8Array(await crypto.subtle.digest('SHA-1', bytes));
  const words = new Uint32Array(80);
  const len = bytes.length;
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(len / 2 ** 29));
  view.setUint32(padded.length - 4, (len * 8) >>> 0);
  let [a0, b0, c0, d0, e0] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const rotl = (x, n) => (x << n) | (x >>> (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) words[i] = rotl(words[i - 3] ^ words[i - 8] ^ words[i - 14] ^ words[i - 16], 1);
    let [a, b, c, d, e] = [a0, b0, c0, d0, e0];
    for (let i = 0; i < 80; i++) {
      const [f, k] = i < 20 ? [(b & c) | (~b & d), 0x5a827999] : i < 40 ? [b ^ c ^ d, 0x6ed9eba1] : i < 60 ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc] : [b ^ c ^ d, 0xca62c1d6];
      const t = (rotl(a, 5) + f + e + k + words[i]) >>> 0;
      [e, d, c, b, a] = [d, c, rotl(b, 30) >>> 0, a, t];
    }
    [a0, b0, c0, d0, e0] = [(a0 + a) >>> 0, (b0 + b) >>> 0, (c0 + c) >>> 0, (d0 + d) >>> 0, (e0 + e) >>> 0];
  }
  const out = new Uint8Array(20);
  const ov = new DataView(out.buffer);
  [a0, b0, c0, d0, e0].forEach((v, i) => ov.setUint32(i * 4, v));
  return out;
}

// ---------- The writer ----------
// pages: [{ image: Uint8Array (JPEG), width, height,           the picture
//           small: Uint8Array (JPEG), smallWidth, smallHeight,  a ~255px copy
//           thumb: Uint8Array (JPEG, 356x200) }]                slide thumbnail
// template: the bytes of public/templates/picture.key
export async function picturesToKeynote(pages, template) {
  if (!pages.length) throw new Error('There are no pages to put in the presentation');
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(template);
  const read = async (path) => readArchives(inflateIwa(await zip.file(path).async('uint8array')));

  // --- The package index ---
  const metaArchives = await read('Index/Metadata.iwa');
  const metaRecord = metaArchives.find((a) => a.msgs[0]?.type === 11006);
  let meta = parse(metaRecord.msgs[0].payload);
  const components = meta.filter((f) => f.num === 3).map((f) => ({ f, c: parse(f.bytes) }));
  const nameOf = (c) => new TextDecoder().decode(first(c, 2)?.bytes || new Uint8Array());
  const slideComp = components.find(({ c }) => nameOf(c) === 'Slide');
  const docComp = components.find(({ c }) => nameOf(c) === 'Document');
  if (!slideComp || !docComp) throw new Error('The Keynote template is damaged');
  const slideId = first(slideComp.c, 1).value;
  const datas = meta.filter((f) => f.num === 4).map((f) => parse(f.bytes));
  let nextId = first(meta, 1).value + 1;
  let nextData = Math.max(...datas.map((d) => first(d, 1).value)) + 1;

  // --- The template slide ---
  const slidePath = `Index/${new TextDecoder().decode(first(slideComp.c, 3).bytes)}.iwa`;
  const slideArchives = await read(slidePath);
  const internal = slideArchives.map((a) => a.id);
  const image = slideArchives.find((a) => a.msgs[0]?.type === 3005);
  if (!image || !internal.every(isFourByte)) throw new Error('The Keynote template is damaged');
  const [oldImageData, oldSmallData] = [11, 12].map((n) => first(parse(first(parse(image.msgs[0].payload), n).bytes), 1).value);

  // --- The slide order ---
  const docArchives = await read('Index/Document.iwa');
  const show = docArchives.find((a) => a.msgs[0]?.type === 2);
  const node = docArchives.find((a) => a.msgs[0]?.type === 4 && first(parse(a.msgs[0].payload), 2) && first(parse(first(parse(a.msgs[0].payload), 2).bytes), 1)?.value === slideId);
  if (!show || !node) throw new Error('The Keynote template is damaged');
  const oldThumbData = first(parse(first(parse(node.msgs[0].payload), 16).bytes), 1).value;
  const dataInfo = (id) => datas.find((d) => first(d, 1).value === id);

  const newDatas = [];
  const dropDatas = new Set([oldImageData, oldSmallData, oldThumbData]);
  const newComponents = [];
  const nodeIds = [];
  const newDocArchives = [];
  const docRefsExtra = { ext: [], uuids: [] };
  const thumbUses = new Map(); // thumbnail data id -> the slide nodes showing it

  // Keynote keeps one copy of identical files (blank pages, repeated slides)
  // and stops on a package listing the same contents twice, so share them.
  const byDigest = new Map();
  async function addData(bytes, name) {
    const digest = await sha1(bytes);
    const key = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
    if (byDigest.has(key)) return byDigest.get(key);
    const id = nextData++;
    byDigest.set(key, id);
    if (id >= 2 ** 14) throw new Error('Too many pages for one presentation');
    const fileName = `${name}-${id}.jpg`;
    zip.file(`Data/${fileName}`, bytes);
    newDatas.push(msgField(4, [varintField(1, id), bytesField(2, digest), textField(3, `${name}.jpg`), textField(4, fileName), varintField(18, bytes.length)]));
    return id;
  }

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    // Fresh ids for every object of the slide, and for its node.
    const map = new Map();
    for (const id of internal) map.set(id, i === 0 ? id : nextId++);
    const nodeId = i === 0 ? node.id : nextId++;
    if (![...map.values(), nodeId].every(isFourByte)) throw new Error('Too many pages for one presentation');
    const newSlideId = map.get(slideId);
    const imageData = await addData(page.image, `page-${i + 1}`);
    const smallData = await addData(page.small, `page-${i + 1}-small`);
    const thumbData = await addData(page.thumb, `st-page-${i + 1}`);

    // The picture fills the slide as far as its shape allows, centred.
    const k = Math.min(1920 / page.width, 1080 / page.height);
    const w = page.width * k;
    const hgt = page.height * k;
    const archives = slideArchives.map((a) => ({
      id: map.get(a.id),
      info: a.info,
      msgs: a.msgs.map((m) => {
        let payload = remapRefs(m.payload, map);
        if (a === image) {
          let f = parse(payload);
          f = editAt(f, [1, 1], (g) => setField(setField(g, pointField(1, (1920 - w) / 2, (1080 - hgt) / 2)), pointField(2, w, hgt)));
          f = setField(f, pointField(4, w, hgt));
          f = setField(f, pointField(9, page.width, page.height));
          f = setField(f, refField(11, imageData));
          f = setField(f, refField(12, smallData));
          // The picture's outline, in its own pixels: a rectangle, as Keynote writes it.
          const pt = (type, x, y) => msgField(1, [varintField(1, type), ...(type === 5 ? [] : [pointField(2, x, y)])]);
          f = setField(f, msgField(19, [pt(1, 0, 0), pt(2, page.width, 0), pt(2, page.width, page.height), pt(2, 0, page.height), pt(5), pt(1, 0, 0)]));
          payload = encode(f);
        }
        const objectRefs = packed(first(m.mi, 5)).map((r) => map.get(r) ?? r);
        const dataRefs = a === image ? [...new Set([smallData, imageData])] : undefined;
        return { mi: m.mi, type: m.type, payload, objectRefs, dataRefs };
      }),
    }));
    const slidePathNew = `Index/Slide-${newSlideId}.iwa`;
    zip.file(slidePathNew, deflateIwa(writeArchives(archives)));

    // The slide's entry in the package index.
    let comp = slideComp.c
      .filter((f) => f.num !== 7 && f.num !== 11)
      .map((f) => (f.num === 1 ? varintField(1, newSlideId) : f.num === 3 ? textField(3, `Slide-${newSlideId}`) : f));
    const imageId = map.get(image.id);
    const uses = smallData === imageData ? [[imageData, 2]] : [[smallData, 1], [imageData, 1]];
    comp.splice(comp.findIndex((f) => f.num === 10), 0,
      ...uses.map(([id, count]) => msgField(7, [varintField(1, id), msgField(2, [varintField(1, imageId), varintField(2, count)])])));
    const uuids = slideComp.c.filter((f) => f.num === 11).map((f) => {
      const old = first(parse(f.bytes), 1).value;
      return i === 0 ? f : msgField(11, [varintField(1, map.get(old) ?? old), uuidField(2)]);
    });
    comp.splice(comp.findIndex((f) => f.num === 12), 0, ...uuids);
    newComponents.push(msgField(3, comp));

    // The slide's node in the slide order.
    let n = parse(node.msgs[0].payload);
    n = setField(n, refField(2, newSlideId));
    n = setField(n, refField(16, thumbData));
    if (i > 0) n = setField(n, uuidField(29));
    newDocArchives.push({ id: nodeId, info: node.info, msgs: [{ mi: node.msgs[0].mi, type: 4, payload: encode(n), objectRefs: [newSlideId], dataRefs: [thumbData] }] });
    nodeIds.push(nodeId);
    if (i > 0) {
      docRefsExtra.ext.push(msgField(6, [varintField(1, newSlideId)]));
      docRefsExtra.uuids.push(msgField(11, [varintField(1, nodeId), uuidField(2)]));
    }
    if (!thumbUses.has(thumbData)) thumbUses.set(thumbData, []);
    thumbUses.get(thumbData).push(nodeId);
  }

  // --- Document.iwa: the nodes, and the show listing them in order ---
  const docOut = [];
  for (const a of docArchives) {
    if (a === node) { docOut.push(...newDocArchives); continue; }
    if (a === show) {
      let f = parse(a.msgs[0].payload);
      const tree = parse(first(f, 3).bytes).filter((x) => x.num !== 2);
      f = setField(f, msgField(3, [...nodeIds.map((id) => refField(2, id)), ...tree]));
      const refs = packed(first(a.msgs[0].mi, 5)).filter((r) => r !== node.id);
      docOut.push({ ...a, msgs: [{ ...a.msgs[0], payload: encode(f), objectRefs: [...nodeIds, ...refs] }] });
      continue;
    }
    docOut.push(a);
  }
  zip.file('Index/Document.iwa', deflateIwa(writeArchives(docOut)));

  // --- Metadata.iwa ---
  const docC = docComp.c.filter((f) => !(f.num === 7 && dropDatas.has(first(parse(f.bytes), 1).value)));
  const at = (num) => { const i = docC.findIndex((f) => f.num === num); return i < 0 ? docC.length : i; };
  docC.splice(at(7), 0, ...docRefsExtra.ext);
  docC.splice(at(10), 0, ...[...thumbUses].map(([id, nodes]) => msgField(7, [varintField(1, id), ...nodes.map((n) => msgField(2, [varintField(1, n), varintField(2, 1)]))])));
  docC.splice(at(12), 0, ...docRefsExtra.uuids);
  meta = meta.flatMap((f) => {
    if (f === slideComp.f) return newComponents;
    if (f === docComp.f) return [msgField(3, docC)];
    if (f.num === 4 && dropDatas.has(first(parse(f.bytes), 1).value)) return [];
    if (f.num === 1) return [varintField(1, nextId - 1)];
    return [f];
  });
  const lastData = meta.findLastIndex((f) => f.num === 4 || f.num === 3);
  meta.splice(lastData + 1, 0, ...newDatas);
  const metaOut = metaArchives.map((a) => (a === metaRecord ? { ...a, msgs: [{ ...a.msgs[0], payload: encode(meta) }] } : a));
  zip.file('Index/Metadata.iwa', deflateIwa(writeArchives(metaOut)));

  // The template's own picture and thumbnail are no longer used.
  for (const id of dropDatas) {
    const name = first(dataInfo(id), 4);
    if (name) zip.remove(`Data/${new TextDecoder().decode(name.bytes)}`);
  }
  // A fresh identity, and no stale previews.
  const uuid = (globalThis.crypto?.randomUUID?.() || `${Date.now()}`).toUpperCase();
  zip.file('Metadata/DocumentIdentifier', uuid);
  for (const name of ['preview.jpg', 'preview-micro.jpg', 'preview-web.jpg']) zip.remove(name);
  return zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
}
