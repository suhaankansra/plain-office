import './styles.css';
import { Capacitor } from '@capacitor/core';
import { h, icon, iconBtn, badge, toast, busy, progressBox, actionSheet, askText, confirmBox, formatDate, formatSize, escapeHtml } from './ui.js';
import { listDocs, getDoc, saveDoc, deleteDoc, newId } from './store.js';
import { pickFiles, readBytes, importBytes, importAsText, createDoc, loaders, listenForOpenedFiles, baseName } from './files.js';
import { version } from '../package.json';
import * as defaultApp from './default-app.js';
import { canMakePages, host, isDesktopApp } from './platform.js';
import { initNativeChrome } from './native-chrome.js';

const root = document.getElementById('app');

// Liquid Glass look on iPhone and Mac, and on Windows over the system's Mica
// material (add ?glass to the address to preview it elsewhere).
document.documentElement.classList.add(`host-${host}`);
if (Capacitor.getPlatform() === 'ios' || host === 'macos' || host === 'windows' || new URLSearchParams(location.search).has('glass')) {
  document.documentElement.classList.add('glass');
}
if (host === 'windows' && window.plainOfficeHost?.mica) document.documentElement.classList.add('mica'); // Windows 11
const KIND_LABEL = { doc: 'Document', sheet: 'Spreadsheet', slides: 'Presentation', pdf: 'PDF' };
let closeEditor = null;
let filter = 'all';
let query = '';

async function openDoc(id) {
  const doc = await getDoc(id);
  if (!doc) return toast('That file no longer exists');
  try {
    const mod = await loaders[doc.kind]();
    root.replaceChildren();
    closeEditor = await mod.open(doc, root, (nextId) => { closeEditor = null; if (nextId) openDoc(nextId); else showHome(); });
    enter();
  } catch (err) {
    console.error(err);
    toast(`Could not open “${doc.name}”`);
    showHome();
  }
}

async function openFromPicker() {
  const files = await pickFiles();
  if (!files.length) return;
  await openIncoming(await readBytes(files[0]), files[0].name);
}

async function openIncoming(bytes, name) {
  try {
    const doc = await busy('Opening…', () => importBytes(bytes, name));
    if (!doc) return;
    if (closeEditor) await closeEditor();
    openDoc(doc.id);
  } catch (err) {
    console.error(err);
    if (err.unknown && await confirmBox(err.message, 'Plain Office can still show any readable text inside it.', { ok: 'Show text' })) {
      try {
        const doc = await importAsText(bytes, name);
        if (closeEditor) await closeEditor();
        openDoc(doc.id);
      } catch (e) {
        toast(e.message);
      }
      return;
    }
    toast(err.message || 'Could not open that file');
  }
}

async function newDoc(kind) {
  const doc = await createDoc(kind, `Untitled ${KIND_LABEL[kind].toLowerCase()}`);
  openDoc(doc.id);
}

async function scanDocument() {
  const { scan } = await import('./apps/scanner.js');
  const pages = await scan();
  if (!pages) return;
  const pdf = await loaders.pdf();
  const doc = await busy('Making PDF…', async () => {
    const data = await pdf.fromImageUrls(pages);
    const name = `Scan ${new Date().toLocaleDateString(undefined, { dateStyle: 'medium' })}`;
    return saveDoc({ id: newId(), name, kind: 'pdf', data, size: Math.round(pages.reduce((n, p) => n + p.url.length * 0.75, 0)) });
  });
  openDoc(doc.id);
}

// A short fade between screens.
function enter() {
  root.classList.remove('screen-in');
  void root.offsetWidth;
  root.classList.add('screen-in');
}

async function pdfMenu() {
  const choice = await actionSheet('PDF tools', [
    { icon: 'scan', label: 'Scan a document', value: 'scan' },
    { icon: 'folder', label: 'Open a PDF to edit', value: 'open' },
    { icon: 'image', label: 'Turn photos into a PDF', value: 'images' },
    { icon: 'merge', label: 'Combine several PDFs', value: 'merge' },
    { badge: 'doc', label: 'PDF to Word', hint: '.docx', value: 'docx' },
    canMakePages ? { badge: 'pages', label: 'PDF to Pages', hint: '.pages', value: 'pages' } : null,
  ]);
  if (!choice) return;
  if (choice === 'scan') return scanDocument();
  if (choice === 'docx' || choice === 'pages') return convertPdfFile(choice);
  makePdf(choice);
}

// PDF -> Word or Pages, straight from the home screen.
async function convertPdfFile(target) {
  const [file] = await pickFiles('.pdf,application/pdf');
  if (!file) return;
  try {
    const { convertPdf } = await import('./apps/convert.js');
    const id = await convertPdf(await readBytes(file), baseName(file.name), target);
    if (id) openDoc(id);
  } catch (err) {
    console.error(err);
    toast(`Could not convert: ${err.message || err}`);
  }
}

// OCR a photo into a new document.
async function textFromPhoto() {
  const choice = await actionSheet('Text from a photo', [
    { icon: 'image', label: 'Take a photo', value: 'camera' },
    { icon: 'folder', label: 'Choose a photo', value: 'library' },
  ]);
  if (!choice) return;
  const [file] = await pickFiles('image/*', false, choice === 'camera' ? 'environment' : null);
  if (!file) return;
  const box = progressBox('Reading text…');
  try {
    const [{ recognize }, { shrinkImage }] = await Promise.all([import('./ocr.js'), import('./apps/docs.js')]);
    const r = await recognize(await shrinkImage(file, 2400), (v) => box.update(`Reading text… ${Math.round(v * 100)}%`));
    if (!r.paragraphs.length) return toast('No text found in that photo');
    const data = r.paragraphs.map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
    const doc = await saveDoc({ id: newId(), name: `Text from ${baseName(file.name)}`, kind: 'doc', data, size: data.length });
    openDoc(doc.id);
  } catch (err) {
    console.error(err);
    toast(`Could not read the text: ${err.message || err}`);
  } finally {
    box.close();
  }
}

async function makePdf(choice) {
  const accept = choice === 'images' ? 'image/*' : '.pdf,application/pdf';
  const files = await pickFiles(accept, choice !== 'open');
  if (!files.length) return;
  try {
    const pdf = await loaders.pdf();
    const doc = await busy('Preparing…', async () => {
      const data = await pdf.fromFiles(await Promise.all(files.map(readBytes)), files.map((f) => f.name));
      const name = choice === 'images' ? 'Photos' : files.length > 1 ? 'Combined' : baseName(files[0].name);
      return saveDoc({ id: newId(), name, kind: 'pdf', data, size: files.reduce((n, f) => n + f.size, 0) });
    });
    openDoc(doc.id);
  } catch (err) {
    console.error(err);
    toast(err.message || 'Could not read those files');
  }
}

async function rowMenu(meta) {
  const choice = await actionSheet(meta.name, [
    { icon: 'edit', label: 'Rename', value: 'rename' },
    { icon: 'copy', label: 'Make a copy', value: 'copy' },
    { icon: 'trash', label: 'Delete', value: 'delete', danger: true },
  ]);
  if (choice === 'rename') {
    const name = await askText('Rename', { value: meta.name });
    if (name?.trim()) {
      const doc = await getDoc(meta.id);
      doc.name = name.trim();
      await saveDoc(doc);
    }
  } else if (choice === 'copy') {
    const doc = await getDoc(meta.id);
    await saveDoc({ ...doc, id: newId(), name: `${doc.name} (copy)`, created: undefined });
  } else if (choice === 'delete') {
    if (await confirmBox(`Delete “${meta.name}”?`, 'This removes it from this phone. It cannot be undone.', { ok: 'Delete', danger: true })) {
      await deleteDoc(meta.id);
      toast('Deleted');
    }
  }
  showHome();
}

// ---------- Home screen: bottom tabs (Home, Files, +, Tools, Me) ----------
let tab = 'home';
const TABS = [
  { key: 'home', label: 'Home', icon: 'home' },
  { key: 'files', label: 'Files', icon: 'folder' },
  { key: 'new' },
  { key: 'tools', label: 'Tools', icon: 'grid' },
  { key: 'me', label: 'Me', icon: 'user' },
];

function fileRow(d) {
  return h('div', { class: 'file-item' },
    h('button', { class: 'file-row', onClick: () => openDoc(d.id) },
      badge(d.kind, true),
      h('div', { class: 'meta' },
        h('div', { class: 'name' }, d.name),
        h('div', { class: 'sub' }, [d.readOnly && 'Read only', KIND_LABEL[d.kind], formatDate(d.updated), formatSize(d.size)].filter(Boolean).join(' · ')))),
    iconBtn('more', `More options for ${d.name}`, () => rowMenu(d)));
}

// limit: show only the most recent few (Home); otherwise use the Files filters.
async function renderList(el, { limit = 0 } = {}) {
  let docs = await listDocs();
  if (limit) docs = docs.slice(0, limit);
  else docs = docs.filter((d) => (filter === 'all' || d.kind === filter) && (!query || d.name.toLowerCase().includes(query.toLowerCase())));
  if (!docs.length) {
    el.replaceChildren(!limit && (query || filter !== 'all')
      ? h('div', { class: 'empty' }, 'No files match.')
      : h('div', { class: 'empty' }, icon('file'), h('strong', {}, 'No files yet'), h('span', {}, 'Tap + to make one, open a file from your phone, or scan a page.')));
    return;
  }
  el.replaceChildren(h('div', { class: 'file-list' }, docs.map(fileRow)));
}

const header = (title, ...extra) => h('div', { class: 'home-head' }, h('h1', {}, title), ...extra);
const section = (title, ...extra) => h('div', { class: 'section-row' }, h('div', { class: 'section-title' }, title), ...extra);

function homeTab() {
  const tile = (kind, label, onClick) => h('button', { class: 'new-tile', onClick }, badge(kind), label);
  const list = h('div');
  renderList(list, { limit: 8 });
  return [
    header('Plain Office', h('img', { src: './icon.svg', alt: '', class: 'head-logo' })),
    h('button', { class: 'search', onClick: () => switchTab('files', true) }, icon('search'), h('span', {}, 'Search files')),
    h('div', { class: 'new-grid' },
      tile('doc', 'Document', () => newDoc('doc')),
      tile('sheet', 'Sheet', () => newDoc('sheet')),
      tile('slides', 'Slides', () => newDoc('slides')),
      tile('pdf', 'PDF', pdfMenu)),
    h('div', { class: 'action-row' },
      h('button', { class: 'open-btn', onClick: openFromPicker }, icon('folder'), 'Open a file'),
      h('button', { class: 'open-btn', onClick: scanDocument }, icon('scan'), 'Scan')),
    section('Recent', h('button', { class: 'link-btn', onClick: () => switchTab('files') }, 'See all')),
    list,
  ];
}

function filesTab(focusSearch) {
  const list = h('div');
  const chips = h('div', { class: 'chips' });
  const renderChips = () => chips.replaceChildren(...[['all', 'All'], ['doc', 'Docs'], ['sheet', 'Sheets'], ['slides', 'Slides'], ['pdf', 'PDFs']].map(([key, label]) =>
    h('button', { class: `chip${filter === key ? ' on' : ''}`, onClick: () => { filter = key; renderChips(); renderList(list); } }, label)));
  renderChips();
  renderList(list);
  const input = h('input', { type: 'search', placeholder: 'Search files', value: query, onInput: (e) => { query = e.target.value; renderList(list); } });
  if (focusSearch) setTimeout(() => input.focus(), 50);
  return [
    header('Files', iconBtn('folder', 'Open a file from your phone', openFromPicker)),
    h('label', { class: 'search' }, icon('search'), input),
    chips,
    list,
  ];
}

function toolsTab() {
  const tool = (art, label, onClick) => h('button', { class: 'tool', onClick }, h('div', { class: 'tool-art' }, art), h('span', {}, label));
  const arrow = () => h('span', { class: 'tool-arrow' }, '→');
  return [
    header('Tools'),
    section('PDF'),
    h('div', { class: 'tools' },
      tool([icon('scan')], 'Scan a document', scanDocument),
      tool([badge('pdf', true), arrow(), icon('edit')], 'Edit a PDF', () => makePdf('open')),
      tool([icon('image'), arrow(), badge('pdf', true)], 'Photos to PDF', () => makePdf('images')),
      tool([icon('merge')], 'Combine PDFs', () => makePdf('merge')),
      tool([badge('pdf', true), arrow(), badge('doc', true)], 'PDF to Word', () => convertPdfFile('docx')),
      canMakePages ? tool([badge('pdf', true), arrow(), badge('pages', true)], 'PDF to Pages', () => convertPdfFile('pages')) : null,
      tool([badge('pdf', true), arrow(), icon('type')], 'Edit PDF text', () => convertPdfFile('doc'))),
    section('Text'),
    h('div', { class: 'tools' },
      tool([icon('scan'), arrow(), badge('doc', true)], 'Text from photo', textFromPhoto)),
  ];
}

function meTab() {
  const row = (iconName, label, hint, onClick) => h(onClick ? 'button' : 'div', { class: 'menu-row', onClick },
    icon(iconName), h('span', { class: 'label' }, label), hint ? h('span', { class: 'hint' }, hint) : null, onClick ? icon('right') : null);
  const storage = h('span', { class: 'hint' });
  navigator.storage?.estimate?.().then(({ usage }) => { storage.textContent = formatSize(usage); }).catch(() => {});
  return [
    header('Me'),
    h('div', { class: 'me-card' },
      h('img', { src: './icon.svg', alt: '' }),
      h('div', {}, h('strong', {}, 'Plain Office'), h('span', {}, `Version ${version}`))),
    h('div', { class: 'menu-list' },
      defaultApp.supported() ? row('check', 'Open documents with Plain Office', null, defaultApp.showDefaultApps) : null,
      h('div', { class: 'menu-row' }, icon('file'), h('span', { class: 'label' }, 'Storage used'), storage),
      row('shield', 'Privacy', 'No internet, no tracking', () => toast('Your files stay on this device. Plain Office has no internet access, accounts, ads or tracking.')),
      row('info', 'Free and open source', 'MIT licence')),
    h('p', { class: 'me-note' }, 'Source code: github.com/suhaankansra/plain-office'),
  ];
}

async function newMenu() {
  const choice = await actionSheet('Create new', [
    { badge: 'doc', label: 'Document', value: 'doc' },
    { badge: 'sheet', label: 'Spreadsheet', value: 'sheet' },
    { badge: 'slides', label: 'Presentation', value: 'slides' },
    { badge: 'pdf', label: 'PDF', hint: 'scan, photos, combine', value: 'pdf' },
    { icon: 'folder', label: 'Open a file', value: 'open' },
  ]);
  if (choice === 'pdf') pdfMenu();
  else if (choice === 'open') openFromPicker();
  else if (choice) newDoc(choice);
}

function switchTab(key, focusSearch = false) {
  if (key === 'new') return newMenu();
  tab = key;
  showHome(focusSearch);
}

function showHome(focusSearch = false) {
  const content = { home: homeTab, files: filesTab, tools: toolsTab, me: meTab }[tab](focusSearch);
  const tabbar = h('nav', { class: 'tabbar', 'aria-label': 'Sections' }, TABS.map((t) => (t.key === 'new'
    ? h('button', { class: 'tab-new', 'aria-label': 'Create new', onClick: newMenu }, h('span', {}, icon('plus')))
    : h('button', { class: `tab${tab === t.key ? ' on' : ''}`, 'data-key': t.key, 'aria-current': tab === t.key ? 'page' : null, onClick: () => switchTab(t.key) }, icon(t.icon), t.label))));
  root.replaceChildren(h('main', { class: `home tab-${tab}` }, content), tabbar);
  enter();
}

// Back: close a popup, then the editor, then go back to the Home tab.
// Returns false when there's nothing to close.
function goBack() {
  const popup = [...document.querySelectorAll('.scan-view, .scrim, .present')].pop();
  if (popup) { if (popup.dismiss) popup.dismiss(); else popup.click(); return true; }
  if (closeEditor) { closeEditor(); return true; }
  if (tab !== 'home') { switchTab('home'); return true; }
  return false;
}

// Android hardware back button; on the home screen it leaves the app.
if (Capacitor.isNativePlatform()) {
  import('@capacitor/app').then(({ App }) => {
    App.addListener('backButton', () => { if (!goBack()) App.exitApp(); });
  });
}

// Escape works like the phone's back button on Chromebooks and computers: close a menu.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.querySelector('.scan-view, .scrim, .present')) { e.preventDefault(); goBack(); }
  // Windows and Linux apps: Ctrl+N new, Ctrl+O open (the Mac app has a real menu bar for these).
  if (isDesktopApp && host !== 'macos' && e.ctrlKey && !e.shiftKey && !e.altKey && !document.querySelector('.scrim')) {
    if (e.key === 'o') { e.preventDefault(); openFromPicker(); }
    if (e.key === 'n' && !closeEditor) { e.preventDefault(); newMenu(); }
  }
});

// Hooks for the computer and Linux phone apps (macos/, windows/, linux/):
// files opened from Finder / Explorer / the file manager, menu commands, and
// confirming saved copies.
window.plainOffice = {
  open: (b64, name) => openIncoming(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), name),
  back: goBack,
  saved: (name) => toast(`Saved “${name}”`),
  command: async (id) => {
    if (id === 'open') return openFromPicker();
    if (id === 'new') return newMenu();
    if (id === 'close') return (closeEditor || document.querySelector('.scan-view, .scrim, .present')) ? goBack() : false; // else the app closes the window
    if (['doc', 'sheet', 'slides'].includes(id)) { if (closeEditor) await closeEditor(); return newDoc(id); }
    if (id === 'pdf') return pdfMenu();
    if (['home', 'files', 'tools', 'me'].includes(id)) { if (closeEditor) await closeEditor(); return switchTab(id); }
    return false;
  },
};

// Installed as a web app (Chromebooks, desktops): work offline once loaded.
// Not needed inside the phone apps, which ship their files.
const isWebsite = !Capacitor.isNativePlatform() && (location.protocol === 'https:' || location.hostname === 'localhost');
if (import.meta.env.PROD && isWebsite && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('Offline mode unavailable', err));
}

// Files opened from the ChromeOS Files app (or "Open with" on desktops).
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async ({ files }) => {
    for (const handle of files || []) {
      const file = await handle.getFile();
      await openIncoming(await readBytes(file), file.name);
    }
  });
}

listenForOpenedFiles((bytes, name, err) => {
  if (err) return toast('Could not read the shared file');
  if (defaultApp.handleSample(name)) return; // our own "set as default" sample came back
  openIncoming(bytes, name);
});

initNativeChrome();
showHome();

// Android: offer once to make Plain Office the app that opens documents.
setTimeout(() => { if (!closeEditor) defaultApp.maybeAsk(); }, 1200);
