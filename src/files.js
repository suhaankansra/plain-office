// Getting files into and out of the app: the system file picker, "Open in"
// from other apps, and saving or sharing exports. Everything stays local.

import { Capacitor } from '@capacitor/core';
import { saveDoc, newId, estimateSize } from './store.js';
import { actionSheet, toast } from './ui.js';
import { IWORK_EXTS, iworkReadOnly } from './platform.js';

const TEXT_EXTS = ['txt', 'text', 'log', 'md', 'markdown', 'json', 'xml', 'yml', 'yaml', 'ini', 'cfg', 'conf', 'toml',
  'js', 'ts', 'jsx', 'tsx', 'py', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cs', 'go', 'rs', 'rb', 'php', 'sh', 'sql',
  'css', 'scss', 'tex', 'bib', 'srt', 'vtt', 'sub', 'nfo', 'readme', 'org', 'rst', 'adoc', 'asciidoc', 'wiki', 'diff', 'patch', 'env'];
const DOC_EXTS = ['docx', 'docm', 'dotx', 'dotm', 'doc', 'dot', 'rtf', 'odt', 'ott', 'fodt', 'pages', 'epub', 'html', 'htm', 'xhtml',
  'eml', 'mht', 'mhtml', 'msg', 'fb2', 'mobi', 'azw', 'azw3', 'prc', 'pdb', 'xps', 'oxps', 'ipynb', 'abw', 'zabw'];
const SHEET_EXTS = ['xlsx', 'xlsm', 'xlsb', 'xltx', 'xltm', 'xls', 'xlt', 'xlw', 'numbers', 'ods', 'ots', 'fods', 'csv', 'tsv', 'tab',
  'prn', 'dif', 'slk', 'sylk', 'dbf', 'wk1', 'wk2', 'wk3', 'wk4', '123', 'wq1', 'wq2', 'wb1', 'wb2', 'wb3', 'qpw', 'eth',
  'vcf', 'vcard', 'ics', 'ical', 'ifb'];
const SLIDE_EXTS = ['pptx', 'pptm', 'ppsx', 'ppsm', 'potx', 'potm', 'ppt', 'pps', 'pot', 'key', 'odp', 'otp'];
const PDF_EXTS = ['pdf', 'png', 'jpg', 'jpeg', 'jfif', 'jpe', 'webp', 'gif', 'heic', 'heif', 'bmp', 'tif', 'tiff', 'avif', 'jxl', 'ico', 'svg', 'cbz'];

const KIND_BY_EXT = Object.fromEntries([
  ...TEXT_EXTS.map((e) => [e, 'doc']), ...DOC_EXTS.map((e) => [e, 'doc']),
  ...SHEET_EXTS.map((e) => [e, 'sheet']), ...SLIDE_EXTS.map((e) => [e, 'slides']), ...PDF_EXTS.map((e) => [e, 'pdf']),
]);

// The phone's own picker greys out files it doesn't recognise when given a
// list, so we accept everything and check the type ourselves.
export const OPEN_ACCEPT = '';

export const extOf = (name) => (name.match(/\.([^.]+)$/)?.[1] || '').toLowerCase();
export const baseName = (name) => name.replace(/\.[^.]+$/, '');

// Each editor module exports `create()`, `importFile(bytes, name)` and `open(doc, root, onExit)`.
export const loaders = {
  doc: () => import('./apps/docs.js'),
  sheet: () => import('./apps/sheets.js'),
  slides: () => import('./apps/slides.js'),
  pdf: () => import('./apps/pdf.js'),
};

// capture: 'environment' opens the back camera directly on phones.
export function pickFiles(accept = OPEN_ACCEPT, multiple = false, capture = null) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    if (capture) input.setAttribute('capture', capture);
    input.style.display = 'none';
    input.addEventListener('change', () => { resolve([...input.files]); input.remove(); });
    input.addEventListener('cancel', () => { resolve([]); input.remove(); });
    document.body.append(input);
    input.click();
  });
}

export async function readBytes(file) {
  return new Uint8Array(await file.arrayBuffer());
}

// Files from Android "Open with" often arrive without a usable extension,
// so fall back to looking at the first bytes.
async function sniffExt(bytes) {
  const head = String.fromCharCode(...bytes.slice(0, 8));
  if (head.startsWith('%PDF')) return 'pdf';
  if (head.startsWith('{\\rtf')) return 'rtf';
  if (bytes[0] === 0x89 && head.slice(1, 4) === 'PNG') return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg';
  if (head.startsWith('GIF8')) return 'gif';
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf) {
    const { compoundKind } = await import('./apps/formats/legacy.js');
    return compoundKind(bytes) || '';
  }
  if (head.startsWith('PK')) {
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(bytes);
    if (zip.file('word/document.xml')) return 'docx';
    if (zip.file('xl/workbook.xml') || zip.file('xl/workbook.bin')) return 'xlsx';
    if (zip.file('ppt/presentation.xml')) return 'pptx';
    const mimetype = zip.file('mimetype') && (await zip.file('mimetype').async('text')).trim();
    if (mimetype === 'application/epub+zip') return 'epub';
    if (mimetype?.endsWith('opendocument.text')) return 'odt';
    if (mimetype?.endsWith('opendocument.spreadsheet')) return 'ods';
    if (mimetype?.endsWith('opendocument.presentation')) return 'odp';
    const { iworkKind } = await import('./apps/formats/iwork.js');
    return iworkKind(zip) || 'zip';
  }
  // Mostly printable bytes: treat as a text file.
  const sample = bytes.slice(0, 2048);
  const printable = sample.filter((b) => b === 9 || b === 10 || b === 13 || b >= 32).length;
  if (sample.length && printable / sample.length > 0.95) return 'txt';
  return '';
}

export async function importBytes(bytes, name) {
  let ext = extOf(name);
  if (!KIND_BY_EXT[ext]) {
    const sniffed = await sniffExt(bytes);
    if (sniffed) {
      name = `${ext ? baseName(name) : name}.${sniffed}`;
      ext = sniffed;
    }
  }
  if (ext === 'zip') return importFromZip(bytes, name);
  const kind = await refineKind(ext, bytes, KIND_BY_EXT[ext]);
  if (!kind) {
    const err = new Error(ext ? `Plain Office can't open .${ext} files yet` : "Plain Office doesn't recognise this file");
    err.unknown = true;
    throw err;
  }
  const mod = await loaders[kind]();
  const data = await mod.importFile(bytes, name);
  const doc = { id: newId(), name: baseName(name) || 'Untitled', kind, data, size: estimateSize(data) };
  if (iworkReadOnly && IWORK_EXTS.includes(ext)) doc.readOnly = true;
  return saveDoc(doc);
}

// Some extensions hold different things: JSON records and Excel 2003 XML
// open best as a spreadsheet.
async function refineKind(ext, bytes, kind) {
  if (ext !== 'json' && ext !== 'xml') return kind;
  const head = new TextDecoder().decode(bytes.subarray(0, 4096));
  if (ext === 'xml') return /urn:schemas-microsoft-com:office:spreadsheet/.test(head) ? 'sheet' : kind;
  try {
    const { jsonRows } = await import('./apps/sheets.js');
    return jsonRows(JSON.parse(new TextDecoder().decode(bytes))) ? 'sheet' : kind;
  } catch {
    return kind;
  }
}

// A .zip: open the file inside it, asking which one if there are several.
async function importFromZip(bytes, name) {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(bytes);
  const entries = Object.values(zip.files)
    .filter((f) => !f.dir && !/(^|\/)(__MACOSX|\.)/.test(f.name) && KIND_BY_EXT[extOf(f.name)])
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (!entries.length) throw new Error('No files Plain Office can open were found in this zip');
  let entry = entries[0];
  if (entries.length > 1) {
    const choice = await actionSheet(`Open a file from ${name}`, entries.slice(0, 60).map((f) => ({
      icon: 'file',
      label: f.name.split('/').pop(),
      hint: f.name.includes('/') ? f.name.slice(0, f.name.lastIndexOf('/')) : '',
      value: f.name,
    })));
    if (!choice) return null;
    entry = zip.file(choice);
  }
  return importBytes(await entry.async('uint8array'), entry.name.split('/').pop());
}

// Last resort for unknown files: a document with whatever readable text is inside.
export async function importAsText(bytes, name) {
  const { salvageText } = await import('./apps/formats/misc.js');
  const { escapeHtml } = await import('./ui.js');
  const lines = salvageText(bytes);
  if (!lines.length) throw new Error('No readable text was found in this file');
  const data = lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('');
  return saveDoc({ id: newId(), name: baseName(name) || 'Recovered text', kind: 'doc', data, size: data.length });
}

export async function createDoc(kind, name) {
  const mod = await loaders[kind]();
  const data = mod.create();
  return saveDoc({ id: newId(), name, kind, data, size: 0 });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const safeName = (name) => name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'document';

// Hands a finished file to the user. On phones this opens the system share
// sheet (Save to Files, Google Drive, email, ...). In a browser it downloads.
export async function exportFile(blob, filename) {
  filename = safeName(filename);
  if (Capacitor.isNativePlatform()) {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const { Share } = await import('@capacitor/share');
    const written = await Filesystem.writeFile({
      path: filename,
      data: await blobToBase64(blob),
      directory: Directory.Cache,
    });
    try {
      await Share.share({ title: filename, files: [written.uri] });
    } catch (err) {
      if (!/cancel/i.test(String(err?.message))) throw err;
    }
    return;
  }
  // Windows app: a real Save dialog (windows/src/main.rs).
  const tauri = window.__TAURI__?.core;
  if (tauri) {
    const saved = await tauri.invoke('save_file', new Uint8Array(await blob.arrayBuffer()), { headers: { 'x-file-name': encodeURIComponent(filename) } });
    if (saved) toast(`Saved “${saved}”`);
    return;
  }
  // The Mac app shows a Save dialog for this download; the Linux app saves it to Downloads.
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// Files sent to the app with "Open in Plain Office" / "Open with".
export async function listenForOpenedFiles(onFile) {
  if (!Capacitor.isNativePlatform()) return;
  const { App } = await import('@capacitor/app');
  const { Filesystem } = await import('@capacitor/filesystem');
  const handle = async (url) => {
    if (!url || !/^(file|content):/.test(url)) return;
    try {
      const { data } = await Filesystem.readFile({ path: url });
      const bytes = typeof data === 'string' ? base64ToBytes(data) : await readBytes(data);
      const name = decodeURIComponent(url.split(/[/?#]/).filter(Boolean).pop() || 'Opened file');
      onFile(bytes, name);
    } catch (err) {
      onFile(null, null, err);
    }
  };
  App.addListener('appUrlOpen', ({ url }) => handle(url));
  const launch = await App.getLaunchUrl();
  if (launch?.url) handle(launch.url);
}
