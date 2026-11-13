// iPhone/iPad (iOS 26+) and the Mac app: show the app's bars with the
// system's real Liquid Glass controls (ios/App/App/NativeChrome.swift and
// macos/Sources/PlainOffice/Chrome.swift).
//
// Every screen still builds its normal web bars (.topbar, .tabbar, .toolbar);
// here they are hidden and mirrored to native ones. Tapping a native button
// clicks the matching web button, so the screens need no changes.

import { Capacitor, registerPlugin } from '@capacitor/core';

// The Mac app talks over a WebKit message handler that replies with a promise;
// the iPhone app uses a Capacitor plugin. Both offer the same calls.
function macBridge() {
  const handler = window.webkit?.messageHandlers?.plainOfficeChrome;
  if (!handler) return null;
  const listeners = {};
  window.__plainOfficeChrome = { emit: (event, data) => (listeners[event] || []).forEach((fn) => fn(data || {})) };
  const call = (method) => (args = {}) => handler.postMessage({ method, args }).then((r) => r || {});
  return new Proxy({}, {
    get: (_, method) => (method === 'then' ? undefined : method === 'addListener'
      ? (event, fn) => { (listeners[event] ||= []).push(fn); }
      : call(method)),
  });
}
const Chrome = macBridge() || registerPlugin('NativeChrome');
export let nativeChrome = false;

// Our icon names → SF Symbols.
const SF = {
  back: 'chevron.backward', plus: 'plus', more: 'ellipsis', share: 'square.and.arrow.up', undo: 'arrow.uturn.backward',
  redo: 'arrow.uturn.forward', brush: 'paintbrush', play: 'play.fill', folder: 'folder', search: 'magnifyingglass',
  info: 'info.circle', bold: 'bold', italic: 'italic', underline: 'underline', strike: 'strikethrough',
  alignLeft: 'text.alignleft', alignCenter: 'text.aligncenter', alignRight: 'text.alignright', alignJustify: 'text.justify',
  listBullet: 'list.bullet', listNumber: 'list.number', checklist: 'checklist', indent: 'increase.indent', outdent: 'decrease.indent',
  highlight: 'highlighter', table: 'tablecells', image: 'photo', palette: 'paintpalette', chart: 'chart.bar', rowPlus: 'rectangle.split.3x1',
  colPlus: 'rectangle.split.1x2', sort: 'arrow.up.arrow.down', copy: 'doc.on.doc', cut: 'scissors', paste: 'doc.on.clipboard',
  square: 'square.dashed', type: 'textformat', pen: 'pencil.tip', hand: 'hand.point.up.left', eraser: 'eraser', sign: 'signature',
  zoomIn: 'plus.magnifyingglass', zoomOut: 'minus.magnifyingglass', pages: 'square.grid.2x2', merge: 'arrow.triangle.merge',
  rotate: 'rotate.right', trash: 'trash', scan: 'doc.viewfinder', x: 'xmark', check: 'checkmark', home: 'house', grid: 'square.grid.2x2',
  user: 'person.crop.circle', left: 'chevron.left', right: 'chevron.right', up: 'chevron.up', down: 'chevron.down', layers: 'square.3.layers.3d',
  shield: 'checkmark.shield', file: 'doc', edit: 'pencil', clear: 'eraser.line.dashed', wordcount: 'text.word.spacing', link: 'link',
  circle: 'circle', calendar: 'calendar', clock: 'clock', star: 'star', triangle: 'triangle', notes: 'note.text', transition: 'rectangle.portrait.on.rectangle.portrait.angled',
  sigma: 'sum', function: 'function', checkbox: 'checkmark.square', toc: 'list.bullet.indent', pageBreak: 'rectangle.split.1x2',
  roundRect: 'app', diamond: 'diamond', hexagon: 'hexagon', arrowShape: 'arrowshape.right', bubble: 'bubble.left', line: 'line.diagonal',
  superscript: 'textformat.superscript', subscript: 'textformat.subscript', wrap: 'text.word.spacing', borders: 'square.grid.3x3',
};
export const sfSymbol = (name) => SF[name];
const TINT = { doc: '#2b6fdc', sheet: '#1f9d55', slides: '#e8711a', pdf: '#d93a3a' };

const ids = new WeakMap();
const byId = new Map();
let nextId = 1;
function idFor(el) {
  if (!ids.has(el)) { const id = `n${nextId++}`; ids.set(el, id); }
  const id = ids.get(el);
  byId.set(id, new WeakRef(el));
  return id;
}

const iconOf = (el) => el.dataset.icon || el.querySelector('[data-icon]')?.dataset.icon;
const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();

function buttonSpec(btn) {
  const icon = iconOf(btn);
  const label = btn.getAttribute('aria-label') || btn.title || text(btn);
  const isText = btn.classList.contains('tb-text') || btn.classList.contains('btn');
  const title = isText ? text(btn) : '';
  return {
    id: idFor(btn),
    symbol: !title || title.length <= 2 ? SF[icon] : undefined,
    title: title || (SF[icon] ? '' : label),
    label,
    on: btn.classList.contains('on') || btn.classList.contains('primary'),
    prominent: btn.classList.contains('primary'),
    disabled: btn.disabled,
  };
}

const last = (sel) => [...document.querySelectorAll(sel)].filter((el) => !el.closest('[hidden]')).pop();

function topBarState() {
  const bar = last('.topbar');
  if (!bar) return { visible: false };
  const kids = [...bar.children];
  const titleBtn = bar.querySelector('.title');
  const backBtn = kids[0]?.matches('button') && kids[0] !== titleBtn ? kids[0] : null;
  const items = kids.filter((k) => k.matches('button') && k !== backBtn && k !== titleBtn).map(buttonSpec);
  return {
    visible: true,
    title: text(titleBtn?.querySelector('span')) || text(titleBtn),
    subtitle: text(titleBtn?.querySelector('small')),
    back: backBtn ? { id: idFor(backBtn), label: backBtn.getAttribute('aria-label') || 'Back', symbol: 'chevron.backward' } : null,
    renameId: titleBtn && titleBtn.matches('button') ? idFor(titleBtn) : null,
    items,
    tint: TINT[bar.dataset.kind] || undefined,
  };
}

function tabBarState() {
  const bar = document.querySelector('.tabbar');
  if (!bar) return { visible: false };
  const tabs = [...bar.querySelectorAll('.tab')];
  const add = bar.querySelector('.tab-new');
  if (add) byId.set('new', new WeakRef(add));
  tabs.forEach((t) => byId.set(t.dataset.key, new WeakRef(t)));
  return {
    visible: true,
    items: tabs.map((t) => ({ id: t.dataset.key, title: text(t), symbol: SF[iconOf(t)] || 'circle' })),
    selected: bar.querySelector('.tab.on')?.dataset.key,
    accessory: add ? { id: 'new', title: 'New', symbol: 'plus' } : null,
  };
}

function toolbarState() {
  const bar = last('.toolbar');
  if (!bar || bar.hidden) return { visible: false };
  const items = [];
  for (const el of bar.children) {
    if (el.classList.contains('sep')) { if (items.length && !items[items.length - 1].sep) items.push({ sep: true }); continue; }
    if (el.matches('button')) items.push(buttonSpec(el));
  }
  return { visible: items.length > 0, items };
}

const overlayState = () => !!document.querySelector('.scrim, .present');

const sent = {};
function send(method, state) {
  const json = JSON.stringify(state);
  if (sent[method] === json) return;
  sent[method] = json;
  Chrome[method](state).catch(() => {});
}

let queued = false;
function sync() {
  queued = false;
  send('setOverlay', { on: overlayState() });
  send('setTabBar', tabBarState());
  send('setTopBar', topBarState());
  send('setToolbar', toolbarState());
}
// A timer, not requestAnimationFrame: that one pauses while the window is hidden.
const schedule = () => { if (!queued) { queued = true; setTimeout(sync, 16); } };

export async function initNativeChrome() {
  if (Capacitor.getPlatform() !== 'ios' && !window.webkit?.messageHandlers?.plainOfficeChrome) return false;
  try {
    const { available } = await Chrome.isAvailable();
    if (!available) return false;
  } catch {
    return false;
  }
  nativeChrome = true;
  document.documentElement.classList.add('native-chrome');
  Chrome.addListener('tap', ({ id }) => byId.get(id)?.deref()?.click());
  Chrome.addListener('insets', ({ toolbar, top }) => {
    const style = document.documentElement.style;
    style.setProperty('--native-toolbar', `${toolbar || 0}px`);
    if (top != null) style.setProperty('--host-top', `${top}px`); // Mac: height of the glass toolbar above the page
  });
  new MutationObserver(schedule).observe(document.body, {
    subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'hidden', 'disabled', 'aria-label'],
  });
  schedule();
  return true;
}

// ---------- Native menus and alerts (used by ui.js) ----------

export async function nativeSheet(title, items) {
  const { index } = await Chrome.actionSheet({ title: title || '', items });
  return index;
}

export async function nativeAlert(opts) {
  return Chrome.alert(opts);
}
