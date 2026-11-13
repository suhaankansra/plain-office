// Small DOM + UI helpers shared by every screen. No framework on purpose:
// it keeps the app tiny and easy for contributors to read.

export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'html') node.innerHTML = value;
    else if (key in node && typeof value !== 'string') node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const ICONS = {
  back: '<path d="M15 18l-6-6 6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  folder: '<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  more: '<circle cx="12" cy="5" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="12" cy="19" r="1.2"/>',
  share: '<path d="M4 12v7a2 2 0 002 2h12a2 2 0 002-2v-7M16 6l-4-4-4 4M12 2v14"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 010 11H11"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 000 11H13"/>',
  bold: '<path d="M7 5h6a3.5 3.5 0 010 7H7zM7 12h7a3.5 3.5 0 010 7H7z"/>',
  italic: '<path d="M19 4h-9M14 20H5M15 4L9 20"/>',
  underline: '<path d="M6 4v6a6 6 0 0012 0V4M4 21h16"/>',
  strike: '<path d="M16 6.5C15.2 5 13.8 4 12 4c-2.5 0-4.5 1.5-4.5 3.5 0 1.3.8 2.3 2.2 3M4 12h16M8 17.5c.8 1.5 2.2 2.5 4 2.5 2.5 0 4.5-1.5 4.5-3.5 0-.6-.2-1.1-.4-1.5"/>',
  alignLeft: '<path d="M4 6h16M4 10h10M4 14h16M4 18h10"/>',
  alignCenter: '<path d="M4 6h16M7 10h10M4 14h16M7 18h10"/>',
  alignRight: '<path d="M4 6h16M10 10h10M4 14h16M10 18h10"/>',
  alignJustify: '<path d="M4 6h16M4 10h16M4 14h16M4 18h16"/>',
  listBullet: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
  listNumber: '<path d="M10 6h10M10 12h10M10 18h10M4 4h1.5v4M4 8h3M4 14.5c0-1 .8-1.5 1.5-1.5s1.5.5 1.5 1.3c0 1-3 2.2-3 3.7h3"/>',
  indent: '<path d="M4 6h16M10 10h10M10 14h10M4 18h16M4 9l3 3-3 3"/>',
  outdent: '<path d="M4 6h16M10 10h10M10 14h10M4 18h16M7 9l-3 3 3 3"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16M15 4v16"/>',
  link: '<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>',
  eraser: '<path d="M20 20H8l-5-5 10-10 8 8-7 7"/><path d="M7 11l6 6"/>',
  type: '<path d="M4 7V5h16v2M9 19h6M12 5v14"/>',
  palette: '<circle cx="12" cy="12" r="9"/><circle cx="8" cy="10" r="1.3"/><circle cx="12" cy="7.5" r="1.3"/><circle cx="16" cy="10" r="1.3"/><path d="M12 21c-1.5 0-2-1-2-2s1-2 2-2h2a3 3 0 003-3"/>',
  highlight: '<path d="M9 11l-5 5v4h4l5-5M14 6l4 4M9 11l5-5 4 4-5 5z"/>',
  pen: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>',
  sign: '<path d="M3 17c3 0 4-6 6-6s1 6 3 6 2-3 4-3 2 2 5 2M3 21h18"/>',
  square: '<rect x="4" y="4" width="16" height="16" rx="1"/>',
  circle: '<circle cx="12" cy="12" r="8"/>',
  hand: '<path d="M18 11V6a2 2 0 00-4 0v5M14 10V4a2 2 0 00-4 0v6M10 10.5V6a2 2 0 00-4 0v8a8 8 0 0016 0v-3a2 2 0 00-4 0"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 002 2h8a2 2 0 002-2l1-12M9 7V4h6v3"/>',
  rotate: '<path d="M21 12a9 9 0 11-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  left: '<path d="M15 18l-6-6 6-6"/>',
  right: '<path d="M9 18l6-6-6-6"/>',
  up: '<path d="M18 15l-6-6-6 6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/>',
  paste: '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4V3h6v1"/>',
  cut: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L12 12"/>',
  play: '<path d="M7 4l13 8-13 8z"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  check: '<path d="M5 12l5 5L20 7"/>',
  sum: '<path d="M18 5H6l6 7-6 7h12"/>',
  sort: '<path d="M7 4v16M3 16l4 4 4-4M14 6h7M14 12h5M14 18h3"/>',
  rowPlus: '<rect x="3" y="4" width="18" height="6" rx="1"/><path d="M12 14v6M9 17h6"/>',
  colPlus: '<rect x="4" y="3" width="6" height="18" rx="1"/><path d="M14 12h6M17 9v6"/>',
  pages: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="9" rx="1"/><rect x="3" y="15" width="7" height="6" rx="1"/><rect x="14" y="15" width="7" height="6" rx="1"/>',
  merge: '<path d="M8 3v5a4 4 0 004 4h0a4 4 0 014 4v5M16 3v5a4 4 0 01-4 4"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  zoomIn: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M8 11h6M11 8v6"/>',
  zoomOut: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M8 11h6"/>',
  file: '<path d="M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9z"/><path d="M14 3v6h6"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  clear: '<path d="M4 7h11M10 7l-3 13M15 15l5 5M20 15l-5 5"/>',
  wordcount: '<path d="M4 6h16M4 12h10M4 18h7"/>',
  home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v9a1 1 0 001 1h4v-6h4v6h4a1 1 0 001-1v-9"/>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4.5 4.3-6.5 8-6.5s7 2 8 6.5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  scan: '<path d="M4 8V5a1 1 0 011-1h3M16 4h3a1 1 0 011 1v3M20 16v3a1 1 0 01-1 1h-3M8 20H5a1 1 0 01-1-1v-3M4 12h16"/>',
};

export function icon(name) {
  const wrap = document.createElement('span');
  wrap.innerHTML = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  return wrap.firstChild;
}

export function iconBtn(name, label, onClick, extra = {}) {
  const btn = h('button', { class: 'icon-btn', 'aria-label': label, title: label, ...extra }, icon(name));
  if (onClick) btn.addEventListener('click', onClick);
  return btn;
}

// Toolbar buttons must not steal focus from the editor, or the text
// selection is lost before the command runs (especially on iOS).
export function keepFocus(node) {
  node.addEventListener('mousedown', (e) => e.preventDefault());
  node.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse') e.preventDefault(); });
  return node;
}

export function badge(kind, small = false) {
  const label = { doc: 'W', sheet: 'S', slides: 'P', pdf: 'PDF', pages: 'Pg' }[kind];
  return h('div', { class: `badge ${kind}${small ? ' sm' : ''}` }, label);
}

let toastTimer;
export function toast(message) {
  document.querySelector('.toast')?.remove();
  clearTimeout(toastTimer);
  const node = h('div', { class: 'toast', role: 'status' }, message);
  document.body.append(node);
  toastTimer = setTimeout(() => node.remove(), 2400);
}

export async function busy(message, task) {
  const node = h('div', { class: 'busy' }, h('div', {}, h('span', { class: 'spinner' }), message));
  document.body.append(node);
  try {
    return await task();
  } finally {
    node.remove();
  }
}

// Like busy(), but the caller updates the message (e.g. "Reading page 2 of 5").
export function progressBox(message) {
  const label = h('span', {}, message);
  const node = h('div', { class: 'busy' }, h('div', {}, h('span', { class: 'spinner' }), label));
  document.body.append(node);
  return { update: (text) => { label.textContent = text; }, close: () => node.remove() };
}

function overlay(content, center = false) {
  const scrim = h('div', { class: `scrim${center ? ' center' : ''}` }, content);
  document.body.append(scrim);
  return scrim;
}

// Bottom action sheet. items: [{ icon, label, hint, danger, onClick }] or { section: 'Title' }
export function actionSheet(title, items) {
  return new Promise((resolve) => {
    const close = (value) => { scrim.remove(); resolve(value); };
    const sheet = h('div', { class: 'action-sheet' }, h('div', { class: 'grab' }), title ? h('h3', {}, title) : null);
    for (const item of items) {
      if (!item) continue;
      if (item.node) { sheet.append(item.node); continue; }
      if (item.section) { sheet.append(h('h3', {}, item.section)); continue; }
      sheet.append(h('button', {
        class: `sheet-item${item.danger ? ' danger' : ''}`,
        onClick: () => { close(item.value ?? true); item.onClick?.(); },
      }, item.badge ? badge(item.badge, true) : item.icon ? icon(item.icon) : null, item.label, item.hint ? h('span', { class: 'hint' }, item.hint) : null));
    }
    const scrim = overlay(sheet);
    scrim.addEventListener('click', (e) => { if (e.target === scrim) close(null); });
    sheet.closeSheet = close;
  });
}

export function pickColor(title, { allowNone = false } = {}) {
  const colors = ['#000000', '#434a52', '#8a939d', '#ffffff', '#d93a3a', '#e8711a', '#f2c200', '#1f9d55', '#14a3a3', '#2b6fdc', '#6a4cd6', '#c2409b',
    '#ffd6d6', '#ffe4c7', '#fff3a8', '#cff2dc', '#cdeefa', '#dde6ff'];
  let picked = null;
  const grid = h('div', { class: 'swatches' });
  const choose = (color) => { picked = color; grid.closest('.action-sheet').closeSheet(null); };
  if (allowNone) grid.append(h('button', { class: 'swatch none', 'aria-label': 'None', onClick: () => choose('none') }));
  for (const color of colors) {
    grid.append(h('button', { class: 'swatch', style: { background: color }, 'aria-label': color, onClick: () => choose(color) }));
  }
  return actionSheet(title, [{ node: grid }]).then(() => picked);
}

export function askText(title, { value = '', placeholder = '', ok = 'OK', multiline = false } = {}) {
  return new Promise((resolve) => {
    const input = multiline
      ? h('textarea', { class: 'field', rows: 4, placeholder })
      : h('input', { class: 'field', value, placeholder, enterkeyhint: 'done' });
    if (multiline) input.value = value;
    const close = (v) => { scrim.remove(); resolve(v); };
    const dialog = h('form', { class: 'dialog', onSubmit: (e) => { e.preventDefault(); close(input.value); } },
      h('h3', {}, title), input,
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn', onClick: () => close(null) }, 'Cancel'),
        h('button', { type: 'submit', class: 'btn primary' }, ok)));
    const scrim = overlay(dialog, true);
    setTimeout(() => { input.focus(); if (!multiline) input.select(); }, 50);
  });
}

export function confirmBox(title, message, { ok = 'OK', danger = false } = {}) {
  return new Promise((resolve) => {
    const close = (v) => { scrim.remove(); resolve(v); };
    const scrim = overlay(h('div', { class: 'dialog' }, h('h3', {}, title), message ? h('p', {}, message) : null,
      h('div', { class: 'row' },
        h('button', { class: 'btn', onClick: () => close(false) }, 'Cancel'),
        h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onClick: () => close(true) }, ok))), true);
  });
}

// Custom dialog with arbitrary content; resolves with whatever `finish` is called with.
export function customDialog(title, build) {
  return new Promise((resolve) => {
    const close = (v) => { scrim.remove(); resolve(v); };
    const dialog = h('div', { class: 'dialog' }, h('h3', {}, title));
    build(dialog, close);
    const scrim = overlay(dialog, true);
  });
}

export function debounce(fn, ms) {
  let timer;
  const wrapped = (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
  wrapped.flush = (...args) => { clearTimeout(timer); return fn(...args); };
  return wrapped;
}

export function formatDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

export function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
