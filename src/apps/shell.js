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
  bar.setSubtitle = (text) => { sub.textContent = text; };
  return bar;
}

// Saves the document and keeps its size up to date for the file list.
export async function persist(doc) {
  doc.size = estimateSize(doc.data);
  await saveDoc(doc);
}
