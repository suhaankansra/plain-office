// Email and web archives: .eml (standard email), .mht/.mhtml (saved web
// pages) and Outlook .msg files. All become a readable document.

import { CFB } from 'xlsx';
import { escapeHtml } from '../../ui.js';

// ---------- Byte <-> "binary string" (one char per byte) ----------
function toBinary(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return out;
}
function fromBinary(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}
function decodeCharset(bytes, charset) {
  const name = (charset || 'utf-8').toLowerCase().replace(/^(us-)?ascii$/, 'utf-8');
  try { return new TextDecoder(name).decode(bytes); } catch { return new TextDecoder('windows-1252').decode(bytes); }
}

// =?utf-8?B?...?= and =?iso-8859-1?Q?...?= in headers.
export function decodeWords(value = '') {
  return value
    .replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, '$1')
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset, enc, text) => {
      const binary = enc.toUpperCase() === 'B'
        ? atob(text)
        : text.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (m, hex) => String.fromCharCode(parseInt(hex, 16)));
      return decodeCharset(fromBinary(binary), charset);
    });
}

function parseHeaders(text) {
  const headers = {};
  for (const line of text.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const m = /^([!-9;-~]+):\s*(.*)$/.exec(line);
    if (m && !(m[1].toLowerCase() in headers)) headers[m[1].toLowerCase()] = m[2];
  }
  return headers;
}

function parseType(value = 'text/plain') {
  const [type, ...rest] = value.split(';');
  const params = {};
  for (const p of rest) {
    const m = /^\s*([^=\s]+)\s*=\s*"?([^"]*)"?\s*$/.exec(p);
    if (m) params[m[1].toLowerCase().replace(/\*$/, '')] = m[2];
  }
  return { type: type.trim().toLowerCase(), params };
}

function decodeBody(body, encoding = '') {
  const enc = encoding.trim().toLowerCase();
  if (enc === 'base64') return atob(body.replace(/[^A-Za-z0-9+/=]/g, ''));
  if (enc === 'quoted-printable') return body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (m, hex) => String.fromCharCode(parseInt(hex, 16)));
  return body;
}

// Walks a MIME message (as a binary string) into its leaf parts.
function parseMime(raw, leaves = [], depth = 0) {
  const split = /\r?\n\r?\n/.exec(raw);
  const headerText = split ? raw.slice(0, split.index) : raw;
  const body = split ? raw.slice(split.index + split[0].length) : '';
  const headers = parseHeaders(headerText);
  const { type, params } = parseType(headers['content-type']);
  if (type.startsWith('multipart/') && params.boundary && depth < 8) {
    const marker = `--${params.boundary}`;
    const chunks = body.split(marker).slice(1);
    for (const chunk of chunks) {
      if (chunk.startsWith('--')) break;
      parseMime(chunk.replace(/^\r?\n/, ''), leaves, depth + 1);
    }
  } else if (type === 'message/rfc822' && depth < 8) {
    parseMime(decodeBody(body, headers['content-transfer-encoding']), leaves, depth + 1);
  } else {
    const disposition = parseType(headers['content-disposition'] || '');
    leaves.push({
      type,
      charset: params.charset,
      binary: decodeBody(body, headers['content-transfer-encoding']),
      filename: decodeWords(disposition.params.filename || params.name || ''),
      attachment: disposition.type === 'attachment',
      cid: (headers['content-id'] || '').replace(/[<>]/g, '').trim(),
      location: (headers['content-location'] || '').trim(),
    });
  }
  return { headers, leaves };
}

const dataUrl = (leaf) => `data:${leaf.type};base64,${btoa(leaf.binary)}`;
const leafText = (leaf) => decodeCharset(fromBinary(leaf.binary), leaf.charset);

function plainToHtml(text) {
  return text.split(/\r?\n/).map((line) => `<p>${escapeHtml(line) || '<br>'}</p>`).join('');
}

function htmlBody(html, leaves) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const el of doc.querySelectorAll('[src], [background]')) {
    const attr = el.hasAttribute('src') ? 'src' : 'background';
    const ref = el.getAttribute(attr);
    const leaf = leaves.find((l) => (l.cid && ref === `cid:${l.cid}`) || (l.location && (ref === l.location || l.location.endsWith(`/${ref}`))));
    if (leaf && leaf.type.startsWith('image/')) el.setAttribute(attr === 'src' ? 'src' : 'data-bg', dataUrl(leaf));
  }
  return doc.body?.innerHTML || '';
}

function headerBlock(rows) {
  const filled = rows.filter(([, v]) => v);
  if (!filled.length) return '';
  return `<table><tbody>${filled.map(([k, v]) => `<tr><td><b>${k}</b></td><td>${escapeHtml(v)}</td></tr>`).join('')}</tbody></table>`;
}

function attachmentList(names) {
  if (!names.length) return '';
  return `<h3>Attachments</h3><ul>${names.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>`;
}

const formatDate = (d) => (d && !Number.isNaN(d.getTime()) ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');

// .eml and .mht/.mhtml
export function mimeToHtml(bytes, { asEmail = true } = {}) {
  const { headers, leaves } = parseMime(toBinary(bytes));
  const bodies = leaves.filter((l) => !l.attachment && (l.type === 'text/html' || l.type === 'text/plain'));
  const html = bodies.find((l) => l.type === 'text/html');
  const plain = bodies.find((l) => l.type === 'text/plain');
  const content = html ? htmlBody(leafText(html), leaves) : plain ? plainToHtml(leafText(plain)) : '';
  if (!asEmail) return content;
  const date = headers.date ? new Date(headers.date) : null;
  const head = headerBlock([
    ['From', decodeWords(headers.from)], ['To', decodeWords(headers.to)], ['Cc', decodeWords(headers.cc)],
    ['Date', formatDate(date) || headers.date], ['Subject', decodeWords(headers.subject)],
  ]);
  const files = leaves.filter((l) => l.attachment || (l.filename && !l.cid)).map((l) => l.filename || l.type);
  return `${head}<hr>${content}${attachmentList(files)}`;
}

// ---------- Outlook .msg ----------
// Compressed RTF ("LZFu") used for RTF-only Outlook bodies.
const LZFU_PREFIX = '{\\rtf1\\ansi\\mac\\deff0\\deftab720{\\fonttbl;}{\\f0\\fnil \\froman \\fswiss \\fmodern \\fscript \\fdecor MS Sans SerifSymbolArialTimes New RomanCourier{\\colortbl\\red0\\green0\\blue0\r\n\\par \\pard\\plain\\f0\\fs20\\b\\i\\u\\tab\\tx';

export function decompressRtf(data) {
  const u32 = (o) => (data[o] | (data[o + 1] << 8) | (data[o + 2] << 16)) + data[o + 3] * 0x1000000;
  const compSize = u32(0);
  const rawSize = u32(4);
  const magic = u32(8);
  if (magic === 0x414c454d) return toBinary(data.subarray(16, 16 + rawSize)); // "MELA": stored
  if (magic !== 0x75465a4c) throw new Error('Unknown RTF compression');
  const dict = new Uint8Array(4096);
  for (let i = 0; i < LZFU_PREFIX.length; i++) dict[i] = LZFU_PREFIX.charCodeAt(i);
  let write = LZFU_PREFIX.length;
  const out = [];
  let pos = 16;
  const end = Math.min(data.length, compSize + 4);
  while (pos < end) {
    const flags = data[pos++];
    for (let bit = 0; bit < 8 && pos < end; bit++) {
      if (flags & (1 << bit)) {
        const word = (data[pos] << 8) | data[pos + 1];
        pos += 2;
        const offset = word >> 4;
        const length = (word & 0xf) + 2;
        if (offset === write) return toBinary(Uint8Array.from(out));
        for (let i = 0; i < length; i++) {
          const b = dict[(offset + i) % 4096];
          out.push(b);
          dict[write] = b;
          write = (write + 1) % 4096;
        }
      } else {
        const b = data[pos++];
        out.push(b);
        dict[write] = b;
        write = (write + 1) % 4096;
      }
    }
  }
  return toBinary(Uint8Array.from(out));
}

export async function msgToHtml(bytes) {
  const cfb = CFB.read(bytes, { type: 'array' });
  const root = new Map();
  const attachments = new Map();
  cfb.FullPaths.forEach((path, i) => {
    const parts = path.split('/').filter(Boolean);
    const content = cfb.FileIndex[i].content;
    if (!content || cfb.FileIndex[i].type !== 2) return;
    const data = content instanceof Uint8Array ? content : Uint8Array.from(content);
    if (parts.length === 2) root.set(parts[1], data);
    if (parts.length === 3 && parts[1].startsWith('__attach_version1.0_')) {
      const a = attachments.get(parts[1]) || {};
      a[parts[2]] = data;
      attachments.set(parts[1], a);
    }
  });
  const utf16 = new TextDecoder('utf-16le');
  const str = (streams, id) => {
    const u = streams.get ? streams.get(`__substg1.0_${id}001F`) : streams[`__substg1.0_${id}001F`];
    if (u) return utf16.decode(u).replace(/\0+$/, '');
    const a = streams.get ? streams.get(`__substg1.0_${id}001E`) : streams[`__substg1.0_${id}001E`];
    return a ? new TextDecoder('windows-1252').decode(a).replace(/\0+$/, '') : '';
  };

  // Sent date from the property stream (PT_SYSTIME values).
  let date = null;
  const props = root.get('__properties_version1.0');
  if (props) {
    for (let o = 32; o + 16 <= props.length; o += 16) {
      const type = props[o] | (props[o + 1] << 8);
      const id = props[o + 2] | (props[o + 3] << 8);
      if (type === 0x0040 && (id === 0x0039 || id === 0x0e06)) {
        const lo = (props[o + 8] | (props[o + 9] << 8) | (props[o + 10] << 16)) + props[o + 11] * 0x1000000;
        const hi = (props[o + 12] | (props[o + 13] << 8) | (props[o + 14] << 16)) + props[o + 15] * 0x1000000;
        date = new Date((hi * 2 ** 32 + lo) / 10000 - 11644473600000);
        if (id === 0x0039) break;
      }
    }
  }

  const fromName = str(root, '0C1A');
  const fromAddr = str(root, '5D01') || str(root, '0C1F');
  let body = '';
  const htmlBytes = root.get('__substg1.0_10130102') || root.get('__substg1.0_1013001F');
  const rtfBytes = root.get('__substg1.0_10090102');
  const plain = str(root, '1000');
  if (htmlBytes) {
    const { decodeText } = await import('../docs.js');
    body = htmlBody(decodeText(htmlBytes), []);
  } else if (plain) {
    body = plainToHtml(plain);
  } else if (rtfBytes) {
    const { rtfToHtml } = await import('./rtf.js');
    body = rtfToHtml(decompressRtf(rtfBytes));
  }
  const head = headerBlock([
    ['From', fromAddr && fromName && fromName !== fromAddr ? `${fromName} <${fromAddr}>` : fromName || fromAddr],
    ['To', str(root, '0E04')], ['Cc', str(root, '0E03')], ['Date', formatDate(date)], ['Subject', str(root, '0037')],
  ]);
  const files = [...attachments.values()].map((a) => str(a, '3707') || str(a, '3704')).filter(Boolean);
  return `${head}<hr>${body}${attachmentList(files)}`;
}
