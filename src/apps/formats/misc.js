// Handy uncommon formats: Jupyter notebooks, AbiWord, XPS print files,
// contacts (.vcf), calendars (.ics), and pulling text out of unknown files.

import { escapeHtml } from '../../ui.js';

// ---------- Jupyter notebooks (.ipynb) ----------
export function ipynbToHtml(text, markdownToHtml) {
  const nb = JSON.parse(text);
  const join = (src) => (Array.isArray(src) ? src.join('') : src || '');
  const out = [];
  for (const cell of nb.cells || []) {
    const source = join(cell.source);
    if (cell.cell_type === 'markdown') out.push(markdownToHtml(source));
    else if (cell.cell_type === 'code') {
      out.push(`<pre style="background:#f3f4f6;padding:8px;border-radius:6px;white-space:pre-wrap"><code>${escapeHtml(source)}</code></pre>`);
      for (const o of cell.outputs || []) {
        const data = o.data || {};
        if (data['image/png']) out.push(`<p><img src="data:image/png;base64,${join(data['image/png']).replace(/\s+/g, '')}" alt=""></p>`);
        else if (data['image/jpeg']) out.push(`<p><img src="data:image/jpeg;base64,${join(data['image/jpeg']).replace(/\s+/g, '')}" alt=""></p>`);
        else {
          const plain = o.text || data['text/plain'] || (o.traceback ? o.traceback.join('\n').replace(/\x1b\[[\d;]*m/g, '') : '');
          if (join(plain)) out.push(`<pre style="white-space:pre-wrap">${escapeHtml(join(plain))}</pre>`);
        }
      }
    } else if (source) {
      out.push(`<pre>${escapeHtml(source)}</pre>`);
    }
  }
  return out.join('');
}

// ---------- AbiWord (.abw, .zabw is gzip of the same) ----------
export function abwToHtml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const images = {};
  for (const d of doc.getElementsByTagName('d')) {
    if (d.getAttribute('base64') === 'yes') images[d.getAttribute('name')] = `data:${d.getAttribute('mime-type') || 'image/png'};base64,${d.textContent.replace(/\s+/g, '')}`;
  }
  const css = (props) => (props || '').split(';').map((p) => p.trim()).filter(Boolean).map((p) => {
    const [k, v] = p.split(':').map((x) => x.trim());
    if (k === 'color' || k === 'bgcolor') return `${k === 'color' ? 'color' : 'background-color'}:#${v.replace('#', '')}`;
    if (['font-weight', 'font-style', 'text-decoration', 'text-align', 'font-size'].includes(k)) return `${k}:${v}`;
    return '';
  }).filter(Boolean).join(';');
  const walk = (node) => [...node.childNodes].map((n) => {
    if (n.nodeType === 3) return escapeHtml(n.nodeValue);
    if (n.nodeType !== 1) return '';
    const style = css(n.getAttribute('props'));
    const attr = style ? ` style="${escapeHtml(style)}"` : '';
    switch (n.localName) {
      case 'p': {
        const level = /Heading (\d)/.exec(n.getAttribute('style') || '')?.[1];
        const tag = level ? `h${Math.min(Number(level), 3)}` : 'p';
        return `<${tag}${attr}>${walk(n) || '<br>'}</${tag}>`;
      }
      case 'c': return attr ? `<span${attr}>${walk(n)}</span>` : walk(n);
      case 'br': return '<br>';
      case 'tab': return '&emsp;';
      case 'image': return images[n.getAttribute('dataid')] ? `<img src="${images[n.getAttribute('dataid')]}" alt="">` : '';
      case 'table': {
        // Cells are listed flat; "top-attach" says which row each belongs to.
        const rows = new Map();
        for (const cell of [...n.children].filter((c) => c.localName === 'cell')) {
          const top = Number(/top-attach:\s*(\d+)/.exec(cell.getAttribute('props') || '')?.[1] || 0);
          if (!rows.has(top)) rows.set(top, []);
          rows.get(top).push(`<td>${walk(cell)}</td>`);
        }
        return `<table><tbody>${[...rows.keys()].sort((a, b) => a - b).map((r) => `<tr>${rows.get(r).join('')}</tr>`).join('')}</tbody></table>`;
      }
      case 'a': return `<a href="${escapeHtml(n.getAttribute('xlink:href') || '')}">${walk(n)}</a>`;
      case 'data': case 'styles': case 'metadata': case 'pagesize': case 'history': case 'revisions': case 'lists': return '';
      default: return walk(n);
    }
  }).join('');
  return walk(doc.documentElement);
}

// ---------- XPS / OpenXPS (.xps, .oxps) ----------
export async function xpsToHtml(bytes) {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(bytes);
  const pages = Object.keys(zip.files).filter((n) => /\.fpage$/i.test(n))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!pages.length) throw new Error('No pages found in this XPS file');
  const out = [];
  for (const name of pages) {
    const doc = new DOMParser().parseFromString(await zip.file(name).async('text'), 'application/xml');
    const glyphs = [...doc.getElementsByTagName('Glyphs')].map((g) => ({
      text: g.getAttribute('UnicodeString') || '',
      x: Number(g.getAttribute('OriginX')) || 0,
      y: Number(g.getAttribute('OriginY')) || 0,
      size: Number(g.getAttribute('FontRenderingEmSize')) || 12,
    })).filter((g) => g.text.trim());
    glyphs.sort((a, b) => a.y - b.y || a.x - b.x);
    const lines = [];
    for (const g of glyphs) {
      const line = lines.at(-1);
      if (line && Math.abs(line.y - g.y) < g.size * 0.4) line.parts.push(g);
      else lines.push({ y: g.y, parts: [g] });
    }
    out.push(lines.map((l) => `<p>${escapeHtml(l.parts.sort((a, b) => a.x - b.x).map((p) => p.text.replace(/^\{\}/, '')).join(' '))}</p>`).join(''));
  }
  return out.join('<hr>');
}

// ---------- Contacts and calendars -> spreadsheet ----------
// Joins folded lines (leading space) and quoted-printable soft breaks (trailing "=").
function unfold(text) {
  const out = [];
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const prev = out.length - 1;
    if (prev >= 0 && /^[ \t]/.test(line)) out[prev] += line.slice(1);
    else if (prev >= 0 && /QUOTED-PRINTABLE/i.test(out[prev]) && out[prev].endsWith('=')) out[prev] = out[prev].slice(0, -1) + line;
    else out.push(line);
  }
  return out;
}

function parseLine(line) {
  const colon = line.search(/:(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  if (colon < 0) return null;
  const [name, ...params] = line.slice(0, colon).split(';');
  let value = line.slice(colon + 1);
  const p = Object.fromEntries(params.map((x) => { const [k, v = ''] = x.split('='); return [k.toUpperCase(), v.replace(/"/g, '')]; }));
  if ((p.ENCODING || '').toUpperCase() === 'QUOTED-PRINTABLE') {
    const bytes = [];
    value.replace(/=([0-9A-F]{2})|([^=])/gi, (m, hex, ch) => { bytes.push(hex ? parseInt(hex, 16) : ch.charCodeAt(0)); return m; });
    try { value = new TextDecoder(p.CHARSET || 'utf-8').decode(Uint8Array.from(bytes)); } catch { /* keep raw */ }
  }
  value = value.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
  return { name: name.toUpperCase().replace(/^item\d+\./i, ''), params: p, value };
}

export function rowsToSheet(name, header, rows) {
  const cells = {};
  const cols = {};
  const all = [header, ...rows];
  all.forEach((row, r) => row.forEach((v, c) => {
    if (v === '' || v == null) return;
    const ref = `${String.fromCharCode(65 + c)}${r + 1}`;
    cells[ref] = { v: String(v).startsWith('=') ? `'${v}` : String(v), ...(r === 0 ? { b: true } : {}) };
    cols[c] = Math.max(cols[c] || 80, Math.min(320, String(v).length * 8 + 16));
  }));
  return { sheets: [{ name, cells, cols }], active: 0 };
}

export function vcfToSheet(text) {
  const contacts = [];
  let cur = null;
  for (const raw of unfold(text)) {
    const line = parseLine(raw.trim());
    if (!line) continue;
    if (line.name === 'BEGIN' && /vcard/i.test(line.value)) { cur = { tel: [], email: [], adr: [] }; continue; }
    if (line.name === 'END' && cur) { contacts.push(cur); cur = null; continue; }
    if (!cur) continue;
    switch (line.name) {
      case 'FN': cur.fn = line.value; break;
      case 'N': cur.n = line.value.split(';').filter(Boolean).reverse().join(' '); break;
      case 'TEL': cur.tel.push(line.value.replace(/^tel:/i, '')); break;
      case 'EMAIL': cur.email.push(line.value); break;
      case 'ORG': cur.org = line.value.split(';').filter(Boolean).join(', '); break;
      case 'TITLE': cur.title = line.value; break;
      case 'ADR': cur.adr.push(line.value.split(';').filter(Boolean).join(', ')); break;
      case 'BDAY': cur.bday = line.value; break;
      case 'NOTE': cur.note = line.value; break;
      case 'URL': cur.url = line.value; break;
      default:
    }
  }
  if (!contacts.length) throw new Error('No contacts found in this file');
  return rowsToSheet('Contacts', ['Name', 'Phone', 'Email', 'Organization', 'Job title', 'Address', 'Birthday', 'Website', 'Notes'],
    contacts.map((c) => [c.fn || c.n || '', c.tel.join(', '), c.email.join(', '), c.org || '', c.title || '', c.adr.join(' | '), c.bday || '', c.url || '', c.note || '']));
}

function icsDate(value, params) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value);
  if (!m) return value;
  const [, y, mo, d, hh, mm, ss, z] = m;
  if (!hh) return new Date(+y, mo - 1, +d).toLocaleDateString(undefined, { dateStyle: 'medium' });
  const date = z ? new Date(Date.UTC(+y, mo - 1, +d, +hh, +mm, +ss)) : new Date(+y, mo - 1, +d, +hh, +mm, +ss);
  const zone = !z && params.TZID ? ` (${params.TZID})` : '';
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) + zone;
}

export function icsToSheet(text) {
  const events = [];
  let cur = null;
  for (const raw of unfold(text)) {
    const line = parseLine(raw.trim());
    if (!line) continue;
    if (line.name === 'BEGIN' && line.value.toUpperCase() === 'VEVENT') { cur = {}; continue; }
    if (line.name === 'END' && line.value.toUpperCase() === 'VEVENT' && cur) { events.push(cur); cur = null; continue; }
    if (!cur) continue;
    if (line.name === 'SUMMARY') cur.summary = line.value;
    if (line.name === 'DTSTART') { cur.startRaw = line.value; cur.start = icsDate(line.value, line.params); }
    if (line.name === 'DTEND') cur.end = icsDate(line.value, line.params);
    if (line.name === 'LOCATION') cur.location = line.value;
    if (line.name === 'DESCRIPTION') cur.description = line.value;
    if (line.name === 'ORGANIZER') cur.organizer = line.value.replace(/^mailto:/i, '');
    if (line.name === 'RRULE') cur.repeats = line.value.match(/FREQ=(\w+)/)?.[1]?.toLowerCase() || 'yes';
  }
  if (!events.length) throw new Error('No events found in this calendar file');
  events.sort((a, b) => String(a.startRaw).localeCompare(String(b.startRaw)));
  return rowsToSheet('Events', ['Event', 'Starts', 'Ends', 'Location', 'Organizer', 'Repeats', 'Details'],
    events.map((e) => [e.summary || '', e.start || '', e.end || '', e.location || '', e.organizer || '', e.repeats || '', e.description || '']));
}

// ---------- Unknown files: keep every readable run of text ----------
export function salvageText(bytes) {
  const runs = [];
  // UTF-16LE runs (common in Windows binaries) and 8-bit runs.
  let cur = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const c = bytes[i] | (bytes[i + 1] << 8);
    if ((c >= 32 && c < 0xd800) || c === 9) cur += String.fromCharCode(c);
    else { if (cur.length >= 6) runs.push(cur); cur = ''; }
  }
  if (cur.length >= 6) runs.push(cur);
  const latin = new TextDecoder('windows-1252').decode(bytes).split(/[\x00-\x08\x0e-\x1f\x7f]+/).filter((s) => s.trim().length >= 6);
  const pick = latin.join('').length >= runs.join('').length ? latin : runs;
  return pick.map((s) => s.trim()).filter((s) => /[A-Za-z0-9\u00c0-\uffff]{3}/.test(s));
}
