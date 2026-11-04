import './styles.css';
import { Capacitor } from '@capacitor/core';
import { h, icon, iconBtn, badge, toast, busy, progressBox, actionSheet, askText, confirmBox, formatDate, formatSize, escapeHtml } from './ui.js';
import { listDocs, getDoc, saveDoc, deleteDoc, newId } from './store.js';
import { pickFiles, readBytes, importBytes, importAsText, createDoc, loaders, listenForOpenedFiles, baseName } from './files.js';
import { version } from '../package.json';

const root = document.getElementById('app');
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
    { badge: 'pages', label: 'PDF to Pages', hint: '.pages', value: 'pages' },
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
  renderList();
}

const listEl = h('div');

async function renderList() {
  const docs = (await listDocs())
    .filter((d) => filter === 'all' || d.kind === filter)
    .filter((d) => !query || d.name.toLowerCase().includes(query.toLowerCase()));
  if (!docs.length) {
    listEl.replaceChildren(query || filter !== 'all'
      ? h('div', { class: 'empty' }, 'No files match.')
      : h('div', { class: 'empty' }, icon('file'), h('strong', {}, 'No files yet'), h('span', {}, 'Create one above, open a file from your phone, or scan a page.')));
    return;
  }
  listEl.replaceChildren(h('div', { class: 'file-list' }, docs.map((d) =>
    h('div', { class: 'file-item' },
      h('button', { class: 'file-row', onClick: () => openDoc(d.id) },
        badge(d.kind, true),
        h('div', { class: 'meta' },
          h('div', { class: 'name' }, d.name),
          h('div', { class: 'sub' }, [KIND_LABEL[d.kind], formatDate(d.updated), formatSize(d.size)].filter(Boolean).join(' · ')))),
      iconBtn('more', `More options for ${d.name}`, () => rowMenu(d))))));
}

async function showAbout() {
  let storage = '';
  try {
    const { usage } = await navigator.storage.estimate();
    storage = formatSize(usage);
  } catch { /* not available */ }
  actionSheet(null, [{
    node: h('div', { class: 'about' },
      h('img', { src: './icon.svg', alt: '' }),
      h('h2', {}, 'Plain Office'),
      h('p', { class: 'muted' }, `Version ${version}`),
      h('p', {}, 'Your files are stored only on this phone. The app has no internet access, no accounts, no ads and no tracking.'),
      storage ? h('p', { class: 'muted' }, `Storage used: ${storage}`) : null,
      h('p', { class: 'muted' }, 'Free and open source (MIT licence): github.com/suhaankansra/plain-office')),
  }]);
}

function showHome() {
  const tile = (kind, label, onClick) => h('button', { class: 'new-tile', onClick }, badge(kind), label);
  const tool = (art, label, onClick) => h('button', { class: 'tool', onClick }, h('div', { class: 'tool-art' }, art), h('span', {}, label));
  const arrow = () => h('span', { class: 'tool-arrow' }, '→');
  const chips = h('div', { class: 'chips' });
  const renderChips = () => chips.replaceChildren(...[['all', 'All'], ['doc', 'Docs'], ['sheet', 'Sheets'], ['slides', 'Slides'], ['pdf', 'PDFs']].map(([key, label]) =>
    h('button', { class: `chip${filter === key ? ' on' : ''}`, onClick: () => { filter = key; renderChips(); renderList(); } }, label)));
  renderChips();

  root.replaceChildren(h('main', { class: 'home' },
    h('div', { class: 'home-head' }, h('img', { src: './icon.svg', alt: '' }), h('h1', {}, 'Plain Office'), iconBtn('info', 'About Plain Office', showAbout)),
    h('div', { class: 'section-title' }, 'Create new'),
    h('div', { class: 'new-grid' },
      tile('doc', 'Document', () => newDoc('doc')),
      tile('sheet', 'Sheet', () => newDoc('sheet')),
      tile('slides', 'Slides', () => newDoc('slides')),
      tile('pdf', 'PDF', pdfMenu)),
    h('div', { class: 'action-row' },
      h('button', { class: 'open-btn', onClick: openFromPicker }, icon('folder'), 'Open a file'),
      h('button', { class: 'open-btn', onClick: scanDocument }, icon('scan'), 'Scan')),
    h('div', { class: 'section-title' }, 'Tools'),
    h('div', { class: 'tools' },
      tool([badge('pdf', true), arrow(), badge('doc', true)], 'PDF to Word', () => convertPdfFile('docx')),
      tool([badge('pdf', true), arrow(), badge('pages', true)], 'PDF to Pages', () => convertPdfFile('pages')),
      tool([icon('image'), arrow(), badge('pdf', true)], 'Photos to PDF', () => makePdf('images')),
      tool([icon('merge')], 'Combine PDFs', () => makePdf('merge')),
      tool([icon('scan'), arrow(), badge('doc', true)], 'Text from photo', textFromPhoto),
      tool([badge('pdf', true), arrow(), icon('edit')], 'Edit PDF text', () => convertPdfFile('doc'))),
    h('div', { class: 'section-title' }, 'Recent'),
    h('label', { class: 'search' }, icon('search'),
      h('input', { type: 'search', placeholder: 'Search files', value: query, onInput: (e) => { query = e.target.value; renderList(); } })),
    chips,
    listEl));
  renderList();
  enter();
}

// Android hardware back button: close a popup, then the editor, then the app.
if (Capacitor.isNativePlatform()) {
  import('@capacitor/app').then(({ App }) => {
    App.addListener('backButton', async () => {
      const popup = [...document.querySelectorAll('.scan-view, .scrim, .present')].pop();
      if (popup) return popup.dismiss ? popup.dismiss() : popup.click();
      if (closeEditor) return closeEditor();
      App.exitApp();
    });
  });
}

listenForOpenedFiles((bytes, name, err) => {
  if (err) return toast('Could not read the shared file');
  openIncoming(bytes, name);
});

showHome();
