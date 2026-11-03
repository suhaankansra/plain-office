import './styles.css';
import { Capacitor } from '@capacitor/core';
import { h, icon, iconBtn, badge, toast, busy, actionSheet, askText, confirmBox, formatDate, formatSize } from './ui.js';
import { listDocs, getDoc, saveDoc, deleteDoc, newId } from './store.js';
import { pickFiles, readBytes, importBytes, importAsText, createDoc, loaders, listenForOpenedFiles, baseName } from './files.js';

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

async function pdfMenu() {
  const choice = await actionSheet('PDF tools', [
    { icon: 'scan', label: 'Scan a document', value: 'scan' },
    { icon: 'folder', label: 'Open a PDF to edit', value: 'open' },
    { icon: 'image', label: 'Turn photos into a PDF', value: 'images' },
    { icon: 'merge', label: 'Combine several PDFs', value: 'merge' },
  ]);
  if (!choice) return;
  if (choice === 'scan') return scanDocument();
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
    listEl.replaceChildren(h('div', { class: 'empty' }, query ? 'No files match your search.' : 'No files yet. Create one above or open a file from your phone.'));
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

function showHome() {
  const tile = (kind, label, onClick) => h('button', { class: 'new-tile', onClick }, badge(kind), label);
  const chips = h('div', { class: 'chips' });
  const renderChips = () => chips.replaceChildren(...[['all', 'All'], ['doc', 'Docs'], ['sheet', 'Sheets'], ['slides', 'Slides'], ['pdf', 'PDFs']].map(([key, label]) =>
    h('button', { class: `chip${filter === key ? ' on' : ''}`, onClick: () => { filter = key; renderChips(); renderList(); } }, label)));
  renderChips();

  root.replaceChildren(h('main', { class: 'home' },
    h('div', { class: 'home-head' }, h('img', { src: './icon.svg', alt: '' }), h('h1', {}, 'Plain Office')),
    h('div', { class: 'section-title' }, 'Create new'),
    h('div', { class: 'new-grid' },
      tile('doc', 'Document', () => newDoc('doc')),
      tile('sheet', 'Sheet', () => newDoc('sheet')),
      tile('slides', 'Slides', () => newDoc('slides')),
      tile('pdf', 'PDF', pdfMenu)),
    h('div', { class: 'action-row' },
      h('button', { class: 'open-btn', onClick: openFromPicker }, icon('folder'), 'Open a file'),
      h('button', { class: 'open-btn', onClick: scanDocument }, icon('scan'), 'Scan')),
    h('div', { class: 'section-title' }, 'Recent'),
    h('label', { class: 'search' }, icon('search'),
      h('input', { type: 'search', placeholder: 'Search files', value: query, onInput: (e) => { query = e.target.value; renderList(); } })),
    chips,
    listEl));
  renderList();
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
