// Getting files into and out of the app: the system file picker, "Open in"
// from other apps, and saving or sharing exports. Everything stays local.

import { Capacitor } from '@capacitor/core';
import { saveDoc, newId, estimateSize } from './store.js';

const KIND_BY_EXT = {
  docx: 'doc', txt: 'doc', md: 'doc', html: 'doc', htm: 'doc',
  xlsx: 'sheet', xlsm: 'sheet', xls: 'sheet', csv: 'sheet', ods: 'sheet', tsv: 'sheet',
  pptx: 'slides',
  pdf: 'pdf', png: 'pdf', jpg: 'pdf', jpeg: 'pdf', webp: 'pdf', gif: 'pdf',
};

export const OPEN_ACCEPT = '.docx,.txt,.md,.html,.htm,.xlsx,.xlsm,.xls,.csv,.tsv,.ods,.pptx,.pdf,.png,.jpg,.jpeg,.webp,.gif';

export const extOf = (name) => (name.match(/\.([^.]+)$/)?.[1] || '').toLowerCase();
export const baseName = (name) => name.replace(/\.[^.]+$/, '');

// Each editor module exports `create()`, `importFile(bytes, name)` and `open(doc, root, onExit)`.
export const loaders = {
  doc: () => import('./apps/docs.js'),
  sheet: () => import('./apps/sheets.js'),
  slides: () => import('./apps/slides.js'),
  pdf: () => import('./apps/pdf.js'),
};

export function pickFiles(accept = OPEN_ACCEPT, multiple = false) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
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
  const head = String.fromCharCode(...bytes.slice(0, 5));
  if (head.startsWith('%PDF')) return 'pdf';
  if (bytes[0] === 0x89 && head.slice(1, 4) === 'PNG') return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg';
  if (head.startsWith('PK')) {
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(bytes);
    if (zip.file('word/document.xml')) return 'docx';
    if (zip.file('xl/workbook.xml')) return 'xlsx';
    if (zip.file('ppt/presentation.xml')) return 'pptx';
  }
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
  const kind = KIND_BY_EXT[ext];
  if (!kind) {
    if (ext === 'doc' || ext === 'ppt') throw new Error(`Old .${ext} files aren't supported yet. Save it as .${ext}x first.`);
    throw new Error(`Can't open .${ext || '?'} files`);
  }
  const mod = await loaders[kind]();
  const data = await mod.importFile(bytes, name);
  const doc = { id: newId(), name: baseName(name) || 'Untitled', kind, data, size: estimateSize(data) };
  return saveDoc(doc);
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
