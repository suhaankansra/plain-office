// The Format panel every editor shares: a panel that slides up from the
// bottom with tabs (like Text / Style / Arrange), so you can keep seeing your
// work while you change it. Plus the small controls it's built from.

import { h, icon, keepFocus } from '../ui.js';

export const COLORS = ['#000000', '#434a52', '#8a939d', '#c9ced6', '#ffffff', '#d93a3a', '#e8711a', '#f2c200', '#1f9d55', '#14a3a3',
  '#2b6fdc', '#6a4cd6', '#c2409b', '#ffd6d6', '#ffe4c7', '#fff3a8', '#cff2dc', '#cdeefa', '#dde6ff', '#f1dcff'];

// Fonts that exist on (or fall back nicely on) iPhone, Android and computers.
export const FONTS = [
  { label: 'Georgia', css: 'Georgia, "Noto Serif", serif' },
  { label: 'Times New Roman', css: '"Times New Roman", Times, "Noto Serif", serif' },
  { label: 'Helvetica', css: 'Helvetica, Arial, Roboto, sans-serif' },
  { label: 'Arial', css: 'Arial, Roboto, sans-serif' },
  { label: 'Verdana', css: 'Verdana, Roboto, sans-serif' },
  { label: 'Trebuchet MS', css: '"Trebuchet MS", Roboto, sans-serif' },
  { label: 'Avenir', css: 'Avenir, "Avenir Next", Montserrat, Roboto, sans-serif' },
  { label: 'Courier New', css: '"Courier New", Courier, "Roboto Mono", monospace' },
  { label: 'Rounded', css: 'ui-rounded, "SF Pro Rounded", "Arial Rounded MT Bold", Nunito, Roboto, sans-serif' },
  { label: 'System', css: '-apple-system, system-ui, "Segoe UI", Roboto, sans-serif' },
];
export const fontLabel = (css) => {
  const first = (css || '').split(',')[0].replace(/["']/g, '').trim().toLowerCase();
  return FONTS.find((f) => f.css.split(',')[0].replace(/["']/g, '').trim().toLowerCase() === first)?.label || (css ? first.replace(/\b\w/g, (c) => c.toUpperCase()) : '');
};

// Buttons that don't steal the text selection from the editor.
const btn = (props, ...children) => keepFocus(h('button', { type: 'button', ...props }, ...children));

/**
 * tabs: a list (or a function returning one, re-read on refresh) of
 * { key, label, render: () => nodes }.
 */
export function formatPanel({ title = 'Format', tabs, onClose }) {
  let current = null;
  const seg = h('div', { class: 'fp-tabs', role: 'tablist' });
  const body = h('div', { class: 'fp-body' });
  const done = btn({ class: 'fp-done', onClick: () => close() }, 'Done');
  const el = h('section', { class: 'format-panel', 'aria-label': title }, h('div', { class: 'fp-head' }, seg, done), body);
  let open = false;

  function render() {
    const list = (typeof tabs === 'function' ? tabs() : tabs).filter(Boolean);
    if (!list.some((t) => t.key === current)) current = list[0]?.key;
    seg.hidden = list.length < 2;
    seg.replaceChildren(...list.map((t) => btn({
      class: `fp-tab${t.key === current ? ' on' : ''}`,
      role: 'tab',
      'aria-selected': t.key === current ? 'true' : 'false',
      onClick: () => { current = t.key; render(); },
    }, t.label)));
    const tab = list.find((t) => t.key === current);
    const top = body.scrollTop;
    body.replaceChildren(...(tab ? [tab.render()].flat().filter(Boolean) : []));
    body.scrollTop = top;
  }
  function show(container, key) {
    if (key) current = key;
    if (!open) { container.append(el); open = true; }
    render();
  }
  function close() {
    if (!open) return;
    el.remove();
    open = false;
    onClose?.();
  }
  return { el, show, close, refresh: () => open && render(), get isOpen() { return open; }, set tab(key) { current = key; } };
}

// ---------- Controls ----------

export function group(title, ...rows) {
  return h('div', { class: 'fp-group' }, title ? h('div', { class: 'fp-gtitle' }, title) : null, h('div', { class: 'fp-card' }, ...rows));
}

export function row(label, control, extra = {}) {
  return h('div', { class: 'fp-row', ...extra }, h('span', { class: 'fp-label' }, label), control);
}

// One choice from a few: [{ value, label | icon, title }].
export function segmented(options, value, onChange, { wide = false } = {}) {
  const wrap = h('div', { class: `fp-seg${wide ? ' wide' : ''}` });
  const paint = () => wrap.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', options[i].value === value));
  for (const o of options) {
    wrap.append(btn({
      'aria-label': o.title || (typeof o.label === 'string' ? o.label : ''),
      title: o.title || '',
      onClick: () => { value = o.value; paint(); onChange(o.value); },
    }, o.icon ? icon(o.icon) : o.label));
  }
  paint();
  return wrap;
}

// Independent on/off buttons, e.g. Bold Italic Underline: [{ label | icon, title, on, onClick }].
export function toggles(items) {
  return h('div', { class: 'fp-seg wide' }, items.filter(Boolean).map((t) => {
    const b = btn({ class: t.on ? 'on' : '', 'aria-label': t.title, title: t.title, 'aria-pressed': t.on ? 'true' : 'false' }, t.icon ? icon(t.icon) : t.label);
    b.addEventListener('click', () => { t.on = !t.on; b.classList.toggle('on', t.on); t.onClick(t.on); });
    return b;
  }));
}

export function stepper(value, { min = 0, max = 999, step = 1, format = (v) => String(v) }, onChange) {
  const out = h('span', { class: 'fp-val' }, format(value));
  const set = (v) => {
    value = Math.max(min, Math.min(max, Math.round(v * 100) / 100));
    out.textContent = format(value);
    onChange(value);
  };
  return h('div', { class: 'fp-stepper' },
    btn({ 'aria-label': 'Less', onClick: () => set(value - step) }, '−'),
    out,
    btn({ 'aria-label': 'More', onClick: () => set(value + step) }, '+'));
}

// A row of colour dots. value: current colour; allowNone adds a "none" dot.
export function swatches(value, onPick, { allowNone = false } = {}) {
  const wrap = h('div', { class: 'fp-swatches' });
  const norm = (c) => (c || '').toLowerCase();
  const paint = () => wrap.querySelectorAll('[data-c]').forEach((b) => b.classList.toggle('on', norm(b.dataset.c) === norm(value)));
  const pick = (c) => { value = c; paint(); onPick(c); };
  if (allowNone) wrap.append(btn({ class: 'fp-dot none', 'data-c': 'none', 'aria-label': 'None', onClick: () => pick('none') }));
  for (const c of COLORS) wrap.append(btn({ class: 'fp-dot', 'data-c': c, 'aria-label': c, style: { background: c }, onClick: () => pick(c) }));
  // Any colour, with the phone's own colour picker.
  const custom = h('input', { type: 'color', 'aria-label': 'Other colour', value: /^#[0-9a-f]{6}$/i.test(value || '') ? value : '#2b6fdc' });
  custom.addEventListener('input', () => pick(custom.value));
  wrap.append(h('label', { class: 'fp-dot custom', title: 'Other colour' }, custom));
  paint();
  return wrap;
}

export function switchRow(label, on, onChange) {
  const input = h('input', { type: 'checkbox', class: 'fp-switch', role: 'switch', checked: !!on });
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'fp-row' }, h('span', { class: 'fp-label' }, label), input);
}

// Big buttons with an icon and a label: [{ icon, label, onClick, danger }].
export function actions(items, cols = 3) {
  return h('div', { class: 'fp-actions', style: { gridTemplateColumns: `repeat(${cols}, 1fr)` } },
    items.filter(Boolean).map((a) => btn({ class: a.danger ? 'danger' : '', onClick: a.onClick }, a.icon ? icon(a.icon) : null, h('span', {}, a.label))));
}

// A list to pick one from, with a tick: [{ value, label (string or node), hint }].
export function choices(options, value, onPick) {
  const wrap = h('div', { class: 'fp-choices' });
  const paint = () => wrap.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', options[i].value === value));
  for (const o of options) {
    wrap.append(btn({ onClick: () => { value = o.value; paint(); onPick(o.value); } },
      h('span', { class: 'fp-choice-label' }, o.label), o.hint ? h('span', { class: 'fp-hint' }, o.hint) : null, icon('check')));
  }
  paint();
  return wrap;
}

// Horizontally scrolling chips: [{ value, label, style }].
export function chips(options, value, onPick) {
  const wrap = h('div', { class: 'fp-chips' });
  const paint = () => wrap.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', options[i].value === value));
  for (const o of options) wrap.append(btn({ style: o.style, onClick: () => { value = o.value; paint(); onPick(o.value); } }, o.label));
  paint();
  return wrap;
}

export const note = (text) => h('p', { class: 'fp-note' }, text);
