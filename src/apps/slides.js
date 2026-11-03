// Slides: a presentation editor that opens and saves PowerPoint (.pptx).
// Slides use a fixed 960x540 canvas that is scaled to fit the screen.

import { h, icon, iconBtn, keepFocus, toast, busy, actionSheet, pickColor, confirmBox, debounce, escapeHtml } from '../ui.js';
import { exportFile, pickFiles } from '../files.js';
import { topBar, persist } from './shell.js';
import { sanitize, shrinkImage } from './docs.js';

const W = 960;
const H = 540;
let uid = 0;
const newId = () => `e${Date.now().toString(36)}${(uid++).toString(36)}`;

const THEMES = [
  { name: 'Clean', bg: '#ffffff', color: '#1d2125', accent: '#2b6fdc' },
  { name: 'Midnight', bg: '#14213d', color: '#ffffff', accent: '#fca311' },
  { name: 'Sunrise', bg: '#fff4e6', color: '#3d2c1e', accent: '#e8711a' },
  { name: 'Forest', bg: '#e9f5ec', color: '#1b3b26', accent: '#1f9d55' },
  { name: 'Slate', bg: '#2a2e33', color: '#e9ecef', accent: '#5fa8ff' },
  { name: 'Rose', bg: '#fdecef', color: '#4a1d2a', accent: '#c2409b' },
];

const text = (props) => ({ id: newId(), type: 'text', size: 28, align: 'left', html: '', ...props });

const LAYOUTS = {
  title: () => [
    text({ x: 80, y: 170, w: 800, h: 110, size: 54, bold: true, align: 'center', html: '' , role: 'title' }),
    text({ x: 80, y: 300, w: 800, h: 60, size: 26, align: 'center', html: '', role: 'subtitle' }),
  ],
  content: () => [
    text({ x: 60, y: 40, w: 840, h: 80, size: 40, bold: true, role: 'title' }),
    text({ x: 60, y: 140, w: 840, h: 360, size: 26, html: '<ul><li></li></ul>' }),
  ],
  two: () => [
    text({ x: 60, y: 40, w: 840, h: 80, size: 40, bold: true, role: 'title' }),
    text({ x: 60, y: 140, w: 405, h: 360, size: 24, html: '<ul><li></li></ul>' }),
    text({ x: 495, y: 140, w: 405, h: 360, size: 24, html: '<ul><li></li></ul>' }),
  ],
  section: () => [
    text({ x: 80, y: 200, w: 800, h: 100, size: 48, bold: true, role: 'title' }),
  ],
  blank: () => [],
};

export function create() {
  const slide = { id: newId(), els: LAYOUTS.title() };
  slide.els[0].html = 'Presentation title';
  slide.els[1].html = 'Your name · Date';
  return { theme: 0, slides: [slide] };
}

// ---------- PPTX import ----------
const EMU_PER_PX = 914400 / 96;

export async function importFile(bytes) {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(bytes);
  const xml = async (path) => {
    const f = zip.file(path);
    return f ? new DOMParser().parseFromString(await f.async('text'), 'application/xml') : null;
  };
  const relsOf = async (path) => {
    const dir = path.slice(0, path.lastIndexOf('/'));
    const rels = await xml(`${dir}/_rels/${path.slice(dir.length + 1)}.rels`);
    const map = {};
    for (const r of rels?.getElementsByTagName('Relationship') || []) {
      const target = r.getAttribute('Target');
      map[r.getAttribute('Id')] = { target: target.startsWith('/') ? target.slice(1) : new URL(target, `http://x/${dir}/`).pathname.slice(1), type: r.getAttribute('Type') };
    }
    return map;
  };

  const pres = await xml('ppt/presentation.xml');
  const size = pres.getElementsByTagName('p:sldSz')[0];
  const cx = Number(size?.getAttribute('cx')) || 12192000;
  const cy = Number(size?.getAttribute('cy')) || 6858000;
  const scale = Math.min(W / (cx / EMU_PER_PX), H / (cy / EMU_PER_PX));
  const presRels = await relsOf('ppt/presentation.xml');
  const ids = [...pres.getElementsByTagName('p:sldId')].map((n) => n.getAttribute('r:id'));

  const px = (emu) => (Number(emu) / EMU_PER_PX) * scale;
  const xfrmOf = (node) => {
    const xfrm = node.getElementsByTagName('a:xfrm')[0];
    const off = xfrm?.getElementsByTagName('a:off')[0];
    const ext = xfrm?.getElementsByTagName('a:ext')[0];
    if (!off || !ext) return null;
    return { x: px(off.getAttribute('x')), y: px(off.getAttribute('y')), w: px(ext.getAttribute('cx')), h: px(ext.getAttribute('cy')) };
  };
  const colorOf = (node) => {
    const c = node?.getElementsByTagName('a:srgbClr')[0];
    return c ? `#${c.getAttribute('val')}` : null;
  };

  const slides = [];
  for (const rid of ids) {
    const path = presRels[rid]?.target;
    const doc = path && await xml(path);
    if (!doc) continue;
    const rels = await relsOf(path);
    const slide = { id: newId(), els: [] };
    const bg = doc.getElementsByTagName('p:bg')[0];
    if (bg) slide.bg = colorOf(bg) || undefined;

    for (const sp of doc.getElementsByTagName('p:sp')) {
      const ph = sp.getElementsByTagName('p:ph')[0];
      const phType = ph?.getAttribute('type') || (ph ? 'body' : null);
      const isTitle = phType === 'title' || phType === 'ctrTitle';
      const box = xfrmOf(sp) || (isTitle ? { x: 60, y: 30, w: 840, h: 90 } : phType === 'subTitle' ? { x: 80, y: 300, w: 800, h: 80 } : { x: 60, y: 140, w: 840, h: 360 });
      const paras = [...sp.getElementsByTagName('a:p')];
      let maxSize = 0;
      let align = 'left';
      const htmlParas = paras.map((p) => {
        const algn = p.getElementsByTagName('a:pPr')[0]?.getAttribute('algn');
        if (algn === 'ctr') align = 'center';
        else if (algn === 'r') align = 'right';
        const runs = [...p.childNodes].filter((n) => n.nodeName === 'a:r' || n.nodeName === 'a:br').map((r) => {
          if (r.nodeName === 'a:br') return '<br>';
          const rPr = r.getElementsByTagName('a:rPr')[0];
          const t = escapeHtml(r.getElementsByTagName('a:t')[0]?.textContent || '');
          const sz = Number(rPr?.getAttribute('sz')) / 100;
          if (sz) maxSize = Math.max(maxSize, sz);
          let out = t;
          if (rPr?.getAttribute('b') === '1') out = `<b>${out}</b>`;
          if (rPr?.getAttribute('i') === '1') out = `<i>${out}</i>`;
          if (rPr?.getAttribute('u') && rPr.getAttribute('u') !== 'none') out = `<u>${out}</u>`;
          const color = colorOf(rPr);
          if (color) out = `<span style="color:${color}">${out}</span>`;
          return out;
        }).join('');
        const explicit = p.getElementsByTagName('a:buChar')[0] || p.getElementsByTagName('a:buAutoNum')[0];
        const bullet = !!explicit || (!isTitle && phType && phType !== 'subTitle' && !p.getElementsByTagName('a:buNone')[0]);
        return { html: runs, bullet };
      }).filter((p) => p.html);
      if (!htmlParas.length) {
        // Plain shapes (rectangles, circles) with a solid fill.
        const geom = sp.getElementsByTagName('a:prstGeom')[0]?.getAttribute('prst');
        const spFill = [...(sp.getElementsByTagName('p:spPr')[0]?.children || [])].find((n) => n.nodeName === 'a:solidFill');
        if (box && spFill && (geom === 'rect' || geom === 'ellipse')) {
          slide.els.push({ id: newId(), type: 'shape', shape: geom, ...box, fill: colorOf(spFill) || '#888888' });
        }
        continue;
      }
      let html = '';
      for (let i = 0; i < htmlParas.length; i++) {
        if (htmlParas[i].bullet) {
          html += '<ul>';
          while (i < htmlParas.length && htmlParas[i].bullet) html += `<li>${htmlParas[i++].html}</li>`;
          html += '</ul>';
          i--;
        } else {
          html += `<div>${htmlParas[i].html}</div>`;
        }
      }
      const fill = sp.getElementsByTagName('p:spPr')[0]?.getElementsByTagName('a:solidFill')[0];
      slide.els.push(text({
        ...box,
        html: sanitize(html),
        size: Math.round((maxSize || (isTitle ? 40 : 24)) * scale * 1.333),
        bold: isTitle,
        align,
        fill: fill && fill.parentNode.nodeName === 'p:spPr' ? colorOf(fill) : undefined,
        role: isTitle ? 'title' : undefined,
      }));
    }

    for (const pic of doc.getElementsByTagName('p:pic')) {
      const blip = pic.getElementsByTagName('a:blip')[0];
      const target = rels[blip?.getAttribute('r:embed')]?.target;
      const file = target && zip.file(target);
      const box = xfrmOf(pic);
      if (!file || !box) continue;
      const ext = target.split('.').pop().toLowerCase();
      const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' }[ext];
      if (!mime) continue;
      slide.els.push({ id: newId(), type: 'image', ...box, src: `data:${mime};base64,${await file.async('base64')}` });
    }
    slides.push(slide);
  }
  if (!slides.length) return create();
  return { theme: 0, slides };
}

// ---------- PPTX export ----------
function htmlToRuns(html, base) {
  const root = h('div', { html });
  const runs = [];
  const walk = (node, style) => {
    if (node.nodeType === 3) {
      if (node.nodeValue) runs.push({ text: node.nodeValue, options: { ...style } });
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName;
    const next = { ...style };
    if (tag === 'B' || tag === 'STRONG' || /bold|[6-9]00/.test(node.style.fontWeight)) next.bold = true;
    if (tag === 'I' || tag === 'EM' || node.style.fontStyle === 'italic') next.italic = true;
    if (tag === 'U' || node.style.textDecoration.includes('underline')) next.underline = { style: 'sng' };
    if (node.style.color) next.color = toHex(node.style.color);
    if (tag === 'BR') { runs.push({ text: '', options: { ...style, breakLine: true } }); return; }
    const block = tag === 'DIV' || tag === 'P' || tag === 'LI';
    if (tag === 'LI') next.bullet = true;
    const start = runs.length;
    node.childNodes.forEach((c) => walk(c, next));
    if (block) {
      if (runs.length === start) runs.push({ text: '', options: { ...next } });
      runs[runs.length - 1].options.breakLine = true;
      if (tag === 'LI') runs[start].options.bullet = true;
      for (let i = start + 1; i < runs.length; i++) delete runs[i].options.bullet;
    }
  };
  root.childNodes.forEach((c) => walk(c, base));
  if (runs.length) delete runs[runs.length - 1].options.breakLine;
  return runs;
}

function toHex(color) {
  if (!color) return undefined;
  if (color.startsWith('#')) return color.slice(1, 7).toUpperCase();
  const m = color.match(/\d+/g);
  return m ? m.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('').toUpperCase() : undefined;
}

export async function toPptx(data) {
  const PptxGenJS = (await import('pptxgenjs')).default;
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';
  const theme = THEMES[data.theme] || THEMES[0];
  const inch = (px) => (px / W) * 10;
  for (const s of data.slides) {
    const slide = pptx.addSlide();
    slide.background = { color: toHex(s.bg || theme.bg) };
    for (const el of s.els) {
      const pos = { x: inch(el.x), y: inch(el.y), w: inch(el.w), h: inch(el.h) };
      if (el.type === 'image') slide.addImage({ data: el.src, ...pos });
      else if (el.type === 'shape') {
        slide.addShape(el.shape === 'ellipse' ? pptx.ShapeType.ellipse : pptx.ShapeType.rect, { ...pos, fill: { color: toHex(el.fill) } });
      } else {
        const runs = htmlToRuns(el.html, { color: toHex(el.color || (el.role === 'title' ? theme.accent : theme.color)), bold: !!el.bold });
        slide.addText(runs.length ? runs : '', {
          ...pos,
          fontSize: Math.round(el.size * 0.75 * (10 / (W / 96))),
          align: el.align,
          valign: 'top',
          fontFace: 'Arial',
          margin: 4,
          fill: el.fill ? { color: toHex(el.fill) } : undefined,
        });
      }
    }
  }
  return pptx.write({ outputType: 'blob' });
}

// ---------- Rendering ----------
function renderSlide(s, theme, { editable = false } = {}) {
  const node = h('div', { class: 'slide', style: { background: s.bg || theme.bg, color: theme.color } });
  for (const el of s.els) node.append(renderEl(el, theme, editable));
  return node;
}

function renderEl(el, theme) {
  const style = { left: `${el.x}px`, top: `${el.y}px`, width: `${el.w}px`, height: `${el.h}px` };
  if (el.type === 'image') {
    return h('div', { class: 'el image', 'data-id': el.id, style }, h('img', { src: el.src, alt: '', draggable: false }));
  }
  if (el.type === 'shape') {
    return h('div', { class: `el shape ${el.shape}`, 'data-id': el.id, style: { ...style, background: el.fill } });
  }
  return h('div', {
    class: 'el text',
    'data-id': el.id,
    html: el.html,
    style: {
      ...style,
      fontSize: `${el.size}px`,
      fontWeight: el.bold ? '700' : '400',
      textAlign: el.align,
      color: el.color || (el.role === 'title' ? theme.accent : theme.color),
      background: el.fill || 'transparent',
    },
  });
}

function fitFrame(frame, slideEl, availW, availH) {
  const scale = Math.min(availW / W, availH / H);
  frame.style.width = `${W * scale}px`;
  frame.style.height = `${H * scale}px`;
  slideEl.style.transform = `scale(${scale})`;
  return scale;
}

// ---------- Editor ----------
export async function open(doc, root, onExit) {
  const data = doc.data;
  let current = 0;
  let selectedId = null;
  let editingId = null;
  let scale = 1;
  const history = [];
  const future = [];

  const theme = () => THEMES[data.theme] || THEMES[0];
  const slide = () => data.slides[current];
  const findEl = (id) => slide().els.find((e) => e.id === id);
  const save = debounce(() => persist(doc), 600);

  function snapshot() {
    history.push(JSON.stringify(data));
    if (history.length > 40) history.shift();
    future.length = 0;
  }
  function restore(json) {
    const d = JSON.parse(json);
    data.slides = d.slides;
    data.theme = d.theme;
    current = Math.min(current, data.slides.length - 1);
    selectedId = null;
    editingId = null;
    renderAll();
    save();
  }
  const undo = () => { if (!history.length) return toast('Nothing to undo'); stopEditing(); future.push(JSON.stringify(data)); restore(history.pop()); };
  const redo = () => { if (!future.length) return toast('Nothing to redo'); history.push(JSON.stringify(data)); restore(future.pop()); };

  const stage = h('div', { class: 'stage' });
  const frame = h('div', { class: 'slide-frame' });
  stage.append(frame);
  let slideEl;
  const thumbs = h('div', { class: 'thumbs' });

  function renderStage() {
    slideEl = renderSlide(slide(), theme());
    frame.replaceChildren(slideEl);
    frame.style.background = slide().bg || theme().bg;
    scale = fitFrame(frame, slideEl, stage.clientWidth - 24, stage.clientHeight - 24);
    for (const node of slideEl.querySelectorAll('.el')) {
      if (node.dataset.id === selectedId) markSelected(node);
    }
    refreshToolbar();
  }

  function renderThumbs() {
    thumbs.replaceChildren(...data.slides.map((s, i) => {
      const mini = renderSlide(s, theme());
      mini.style.transform = `scale(${108 / W})`;
      return h('button', { class: `thumb${i === current ? ' on' : ''}`, 'aria-label': `Slide ${i + 1}`, onClick: () => (i === current ? slideMenu() : goTo(i)) },
        mini, h('span', { class: 'num' }, i + 1));
    }), h('button', { class: 'thumb add', 'aria-label': 'New slide', onClick: addSlide }, icon('plus')));
    thumbs.children[current]?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }

  const renderThumbsSoon = debounce(renderThumbs, 400);
  function renderAll() { renderStage(); renderThumbs(); }

  function goTo(i) {
    stopEditing();
    current = i;
    selectedId = null;
    renderAll();
  }

  function markSelected(node) {
    node.classList.add('selected');
    if (!node.querySelector('.handle')) node.append(h('div', { class: 'handle', 'data-handle': '1' }));
  }

  function selectEl(id) {
    if (editingId && editingId !== id) stopEditing();
    selectedId = id;
    for (const node of slideEl.querySelectorAll('.el')) {
      node.classList.remove('selected');
      node.querySelector('.handle')?.remove();
      if (node.dataset.id === id) markSelected(node);
    }
    refreshToolbar();
  }

  function startEditing(id) {
    const node = slideEl.querySelector(`[data-id="${id}"]`);
    if (!node || !node.classList.contains('text')) return;
    snapshot();
    editingId = id;
    node.querySelector('.handle')?.remove();
    node.classList.add('editing');
    node.contentEditable = 'true';
    node.focus();
    const range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(false);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    node.addEventListener('input', () => {
      findEl(id).html = node.innerHTML;
      save();
      renderThumbsSoon();
    });
    refreshToolbar();
  }

  function stopEditing() {
    if (!editingId) return;
    const node = slideEl?.querySelector(`[data-id="${editingId}"]`);
    if (node) {
      const el = findEl(editingId);
      if (el) el.html = sanitize(node.innerHTML);
      node.contentEditable = 'false';
      node.classList.remove('editing');
    }
    editingId = null;
    save();
    renderThumbs();
  }

  // Drag to move, drag the round handle to resize, tap a selected text box to type.
  let drag = null;
  stage.addEventListener('pointerdown', (e) => {
    const node = e.target.closest('.el');
    if (!node) {
      if (e.target === stage || e.target.classList.contains('slide')) { stopEditing(); selectEl(null); }
      return;
    }
    const id = node.dataset.id;
    if (id === editingId) return;
    const el = findEl(id);
    const wasSelected = selectedId === id;
    selectEl(id);
    drag = { id, el, node, x: e.clientX, y: e.clientY, ox: el.x, oy: el.y, ow: el.w, oh: el.h, resize: !!e.target.dataset.handle, moved: false, wasSelected };
    node.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = (e.clientX - drag.x) / scale;
    const dy = (e.clientY - drag.y) / scale;
    if (!drag.moved && Math.hypot(dx, dy) * scale < 6) return;
    if (!drag.moved) { snapshot(); drag.moved = true; }
    if (drag.resize) {
      drag.el.w = Math.max(30, Math.round(drag.ow + dx));
      drag.el.h = Math.max(20, Math.round(drag.oh + dy));
      drag.node.style.width = `${drag.el.w}px`;
      drag.node.style.height = `${drag.el.h}px`;
    } else {
      drag.el.x = Math.round(Math.max(-drag.el.w + 20, Math.min(W - 20, drag.ox + dx)));
      drag.el.y = Math.round(Math.max(-drag.el.h + 20, Math.min(H - 20, drag.oy + dy)));
      drag.node.style.left = `${drag.el.x}px`;
      drag.node.style.top = `${drag.el.y}px`;
    }
  });
  stage.addEventListener('pointerup', () => {
    if (!drag) return;
    const { moved, wasSelected, id, el } = drag;
    drag = null;
    if (moved) { save(); renderThumbs(); return; }
    if (wasSelected && el.type === 'text') startEditing(id);
  });

  // ---- Commands ----
  function addElement(el) {
    stopEditing();
    snapshot();
    slide().els.push(el);
    selectedId = el.id;
    renderAll();
    save();
    if (el.type === 'text') startEditing(el.id);
  }

  async function addSlide() {
    stopEditing();
    const layout = await new Promise((resolve) => {
      const mini = (rects) => h('div', { class: 'mini' }, rects.map(([x, y, w, hh]) => h('i', { style: { left: `${x}%`, top: `${y}%`, width: `${w}%`, height: `${hh}%` } })));
      const opt = (key, label, rects) => h('button', { onClick: () => { grid.closest('.action-sheet').closeSheet(null); resolve(key); } }, mini(rects), label);
      const grid = h('div', { class: 'layout-grid' },
        opt('title', 'Title', [[15, 35, 70, 14], [25, 56, 50, 8]]),
        opt('content', 'Title & content', [[8, 8, 60, 12], [8, 28, 84, 6], [8, 40, 84, 6], [8, 52, 70, 6]]),
        opt('two', 'Two columns', [[8, 8, 60, 12], [8, 30, 40, 50], [52, 30, 40, 50]]),
        opt('section', 'Section header', [[15, 40, 70, 16]]),
        opt('blank', 'Blank', []));
      actionSheet('New slide', [{ node: grid }]).then(() => resolve(null));
    });
    if (!layout) return;
    snapshot();
    data.slides.splice(current + 1, 0, { id: newId(), els: LAYOUTS[layout]() });
    current += 1;
    selectedId = null;
    renderAll();
    save();
  }

  async function slideMenu() {
    const value = await actionSheet(`Slide ${current + 1}`, [
      { icon: 'copy', label: 'Duplicate slide', value: 'dup' },
      current > 0 ? { icon: 'left', label: 'Move earlier', value: 'up' } : null,
      current < data.slides.length - 1 ? { icon: 'right', label: 'Move later', value: 'down' } : null,
      { icon: 'palette', label: 'Background color', value: 'bg' },
      data.slides.length > 1 ? { icon: 'trash', label: 'Delete slide', value: 'del', danger: true } : null,
    ]);
    if (!value) return;
    if (value === 'bg') {
      const color = await pickColor('Slide background', { allowNone: true });
      if (!color) return;
      snapshot();
      slide().bg = color === 'none' ? undefined : color;
    } else if (value === 'del') {
      if (!await confirmBox(`Delete slide ${current + 1}?`, null, { ok: 'Delete', danger: true })) return;
      snapshot();
      data.slides.splice(current, 1);
      current = Math.min(current, data.slides.length - 1);
    } else {
      snapshot();
      if (value === 'dup') {
        const copy = JSON.parse(JSON.stringify(slide()));
        copy.id = newId();
        copy.els.forEach((e) => { e.id = newId(); });
        data.slides.splice(current + 1, 0, copy);
        current += 1;
      } else {
        const to = value === 'up' ? current - 1 : current + 1;
        [data.slides[current], data.slides[to]] = [data.slides[to], data.slides[current]];
        current = to;
      }
    }
    selectedId = null;
    renderAll();
    save();
  }

  async function insertMenu() {
    const value = await actionSheet('Insert', [
      { icon: 'type', label: 'Text box', value: 'text' },
      { icon: 'image', label: 'Picture', value: 'image' },
      { icon: 'square', label: 'Rectangle', value: 'rect' },
      { icon: 'circle', label: 'Circle', value: 'ellipse' },
    ]);
    if (value === 'text') addElement(text({ x: 280, y: 220, w: 400, h: 80, size: 28 }));
    if (value === 'rect' || value === 'ellipse') addElement({ id: newId(), type: 'shape', shape: value, x: 380, y: 170, w: 200, h: 200, fill: theme().accent });
    if (value === 'image') {
      const [file] = await pickFiles('image/*');
      if (!file) return;
      const src = await shrinkImage(file, 1600);
      const img = new Image();
      img.src = src;
      await img.decode();
      const ratio = img.naturalWidth / img.naturalHeight;
      const w = ratio > W / H ? 600 : 340 * ratio;
      const hh = w / ratio;
      addElement({ id: newId(), type: 'image', src, x: (W - w) / 2, y: (H - hh) / 2, w, h: hh });
    }
  }

  async function themeMenu() {
    const value = await actionSheet('Theme', THEMES.map((t, i) => ({
      label: h('span', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
        h('span', { style: { width: '44px', height: '26px', borderRadius: '6px', background: t.bg, border: '1px solid var(--line)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: t.accent, fontWeight: 700, fontSize: '13px' } }, 'Aa'),
        `${i === data.theme ? '✓ ' : ''}${t.name}`),
      value: String(i),
    })));
    if (value == null) return;
    snapshot();
    data.theme = Number(value);
    renderAll();
    save();
  }

  // Text formatting applies to the selected box, or to selected words while typing.
  function format(cmd) {
    const el = selectedId && findEl(selectedId);
    if (!el || el.type !== 'text') return toast('Tap a text box first');
    const hasRange = editingId && !getSelection().isCollapsed;
    if (hasRange && (cmd === 'bold' || cmd === 'italic' || cmd === 'underline')) {
      document.execCommand(cmd);
      return;
    }
    snapshot();
    if (cmd === 'bold') el.bold = !el.bold;
    if (cmd === 'bigger') el.size = Math.min(160, Math.round(el.size * 1.15));
    if (cmd === 'smaller') el.size = Math.max(10, Math.round(el.size / 1.15));
    if (cmd.startsWith('align:')) el.align = cmd.slice(6);
    if (cmd === 'bullets') {
      if (editingId) { document.execCommand('insertUnorderedList'); return; }
      el.html = /<li/i.test(el.html) ? el.html.replace(/<\/?(ul|ol)[^>]*>/gi, '').replace(/<li[^>]*>/gi, '<div>').replace(/<\/li>/gi, '</div>') : `<ul>${(el.html.split(/<br>|<\/div>/i).map((t) => t.replace(/<div[^>]*>/gi, '')).filter((t) => t.trim()).map((t) => `<li>${t}</li>`).join('')) || '<li></li>'}</ul>`;
    }
    const wasEditing = editingId;
    editingId = null;
    renderAll();
    save();
    if (wasEditing) startEditing(wasEditing);
  }

  async function colorFor(kind) {
    const el = selectedId && findEl(selectedId);
    if (!el) return toast('Tap something on the slide first');
    const color = await pickColor(kind === 'fill' ? 'Fill color' : 'Text color', { allowNone: kind === 'fill' });
    if (!color) return;
    snapshot();
    if (kind === 'fill') el.fill = color === 'none' ? undefined : color;
    else el.color = color;
    renderAll();
    save();
  }

  async function arrange() {
    const el = selectedId && findEl(selectedId);
    if (!el) return toast('Tap something on the slide first');
    const value = await actionSheet('Arrange', [
      { icon: 'up', label: 'Bring to front', value: 'front' },
      { icon: 'down', label: 'Send to back', value: 'back' },
      { icon: 'alignCenter', label: 'Center on slide', value: 'center' },
      { icon: 'copy', label: 'Duplicate', value: 'dup' },
      { icon: 'trash', label: 'Delete', value: 'del', danger: true },
    ]);
    if (!value) return;
    stopEditing();
    snapshot();
    const els = slide().els;
    const idx = els.indexOf(el);
    if (value === 'front') { els.splice(idx, 1); els.push(el); }
    if (value === 'back') { els.splice(idx, 1); els.unshift(el); }
    if (value === 'center') { el.x = Math.round((W - el.w) / 2); el.y = Math.round((H - el.h) / 2); }
    if (value === 'dup') { const copy = { ...el, id: newId(), x: el.x + 20, y: el.y + 20 }; els.push(copy); selectedId = copy.id; }
    if (value === 'del') { els.splice(idx, 1); selectedId = null; }
    renderAll();
    save();
  }

  function deleteSelected() {
    if (!selectedId || editingId) return;
    snapshot();
    slide().els = slide().els.filter((e) => e.id !== selectedId);
    selectedId = null;
    renderAll();
    save();
  }

  function onKey(e) {
    if (editingId || document.querySelector('.scrim, .present')) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) { e.preventDefault(); deleteSelected(); }
    if (e.key === 'ArrowRight' || e.key === 'PageDown') goTo(Math.min(current + 1, data.slides.length - 1));
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') goTo(Math.max(current - 1, 0));
  }
  document.addEventListener('keydown', onKey);

  // ---- Present ----
  function present() {
    stopEditing();
    let i = current;
    const view = h('div', { class: 'present' });
    const inner = h('div', { class: 'slide-frame' });
    const counter = h('div', { class: 'counter' });
    const show = () => {
      const s = renderSlide(data.slides[i], theme());
      inner.replaceChildren(s);
      inner.style.background = data.slides[i].bg || theme().bg;
      fitFrame(inner, s, window.innerWidth, window.innerHeight);
      counter.textContent = `${i + 1} / ${data.slides.length}`;
    };
    const close = () => { view.remove(); window.removeEventListener('keydown', keys); window.removeEventListener('resize', show); document.exitFullscreen?.().catch(() => {}); };
    const step = (d) => { i = Math.max(0, Math.min(data.slides.length - 1, i + d)); show(); };
    const keys = (e) => {
      if (e.key === 'Escape') close();
      if (['ArrowRight', 'ArrowDown', ' ', 'PageDown'].includes(e.key)) step(1);
      if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key)) step(-1);
    };
    let startX = null;
    view.addEventListener('pointerdown', (e) => { startX = e.clientX; });
    view.addEventListener('pointerup', (e) => {
      if (e.target.closest('.close')) return;
      const dx = e.clientX - (startX ?? e.clientX);
      if (Math.abs(dx) > 40) step(dx < 0 ? 1 : -1);
      else step(e.clientX > window.innerWidth / 3 ? 1 : -1);
    });
    view.dismiss = close;
    view.append(inner, counter, iconBtn('x', 'End show', close, { class: 'icon-btn close' }));
    document.body.append(view);
    window.addEventListener('keydown', keys);
    window.addEventListener('resize', show);
    document.documentElement.requestFullscreen?.().catch(() => {});
    show();
  }

  // ---- Export ----
  async function exportMenu() {
    stopEditing();
    save.flush();
    const value = await actionSheet('Save a copy / share', [
      { badge: 'slides', label: 'PowerPoint', hint: '.pptx', value: 'pptx' },
      { badge: 'pdf', label: 'PDF', hint: '.pdf', value: 'pdf' },
    ]);
    if (!value) return;
    try {
      await busy('Preparing file…', async () => {
        if (value === 'pptx') {
          await exportFile(await toPptx(data), `${doc.name}.pptx`);
        } else {
          const { elementsToPdf } = await import('./render-pdf.js');
          const host = h('div', { style: { position: 'fixed', left: '-20000px', top: '0' } });
          const nodes = data.slides.map((s) => {
            const n = renderSlide(s, theme());
            n.style.position = 'relative';
            n.style.background = s.bg || theme().bg;
            return n;
          });
          host.append(...nodes);
          document.body.append(host);
          await Promise.all([...host.querySelectorAll('img')].map((img) => img.decode().catch(() => {})));
          try { await exportFile(await elementsToPdf(nodes, W, H), `${doc.name}.pdf`); } finally { host.remove(); }
        }
      });
    } catch (err) {
      console.error(err);
      toast('Export failed: ' + (err.message || err));
    }
  }

  // ---- Toolbar ----
  const sep = () => h('span', { class: 'sep' });
  const textBtn = (label, onClick, iconName) => keepFocus(h('button', { class: 'tb-text', onClick }, iconName ? icon(iconName) : null, label));
  const boldBtn = keepFocus(iconBtn('bold', 'Bold', () => format('bold')));
  function refreshToolbar() {
    const el = selectedId && findEl(selectedId);
    boldBtn.classList.toggle('on', !!el?.bold);
  }
  const toolbar = h('nav', { class: 'toolbar', 'aria-label': 'Slide tools' },
    textBtn('Insert', insertMenu, 'plus'),
    textBtn('Slide', addSlide, 'layers'),
    sep(),
    boldBtn,
    keepFocus(iconBtn('italic', 'Italic', () => format('italic'))),
    keepFocus(h('button', { class: 'tb-text', 'aria-label': 'Smaller text', onClick: () => format('smaller') }, h('span', { style: { fontSize: '12px' } }, 'A'), '−')),
    keepFocus(h('button', { class: 'tb-text', 'aria-label': 'Bigger text', onClick: () => format('bigger') }, h('span', { style: { fontSize: '18px' } }, 'A'), '+')),
    keepFocus(h('button', { class: 'tb-text', 'aria-label': 'Text color', onClick: () => colorFor('text') }, h('span', { class: 'tb-stack' }, 'A', h('span', { class: 'color-dot', style: { background: '#e8711a' } })))),
    keepFocus(iconBtn('palette', 'Fill color', () => colorFor('fill'))),
    keepFocus(iconBtn('alignLeft', 'Align left', () => format('align:left'))),
    keepFocus(iconBtn('alignCenter', 'Center', () => format('align:center'))),
    keepFocus(iconBtn('listBullet', 'Bullets', () => format('bullets'))),
    sep(),
    iconBtn('layers', 'Arrange', arrange),
    textBtn('Theme', themeMenu),
  );

  async function close() {
    stopEditing();
    save.flush();
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
    onExit();
  }

  const bar = topBar(doc, {
    onBack: close,
    buttons: [
      iconBtn('undo', 'Undo', undo),
      iconBtn('redo', 'Redo', redo),
      iconBtn('play', 'Present', present),
      iconBtn('share', 'Save a copy / share', exportMenu),
    ],
  });

  const onResize = debounce(() => { if (!editingId) renderStage(); }, 150);
  window.addEventListener('resize', onResize);

  root.append(bar, stage, thumbs, toolbar);
  renderAll();
  requestAnimationFrame(renderStage);
  return close;
}
