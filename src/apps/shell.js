// The top bar every editor shares: back, a tappable title to rename, extra
// buttons, and a "more" menu.

import { h, iconBtn, askText, toast } from '../ui.js';
import { saveDoc, estimateSize } from '../store.js';

export function topBar(doc, { onBack, buttons = [], subtitle = '' }) {
  const sub = h('small', {}, subtitle);
  const label = h('span', {}, doc.name);
  const title = h('button', { class: 'title', 'aria-label': 'Rename', onClick: rename }, label, sub);

  async function rename() {
    const name = await askText('Rename', { value: doc.name });
    if (!name?.trim()) return;
    doc.name = name.trim();
    label.textContent = doc.name;
    await saveDoc(doc);
    toast('Renamed');
  }

  const bar = h('header', { class: 'topbar' }, iconBtn('back', 'Back to files', onBack), title, ...buttons);
  let subtitleText = subtitle;
  let savedTimer;
  const show = (saved) => { sub.textContent = [doc.readOnly && 'Read only', subtitleText, saved && 'Saved'].filter(Boolean).join(' · '); };
  bar.setSubtitle = (text) => { subtitleText = text; show(false); };
  // A quiet "Saved" after each automatic save, so people know their work is safe.
  const onSaved = (e) => {
    if (!bar.isConnected) return window.removeEventListener('doc-saved', onSaved);
    if (e.detail !== doc.id) return;
    show(true);
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => show(false), 1800);
  };
  window.addEventListener('doc-saved', onSaved);
  show(false);
  return bar;
}

// Saves the document and keeps its size up to date for the file list.
export async function persist(doc) {
  doc.size = estimateSize(doc.data);
  await saveDoc(doc);
  window.dispatchEvent(new CustomEvent('doc-saved', { detail: doc.id }));
}
