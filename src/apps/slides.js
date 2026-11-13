// Slides: a presentation editor that opens and saves PowerPoint (.pptx).
// Slides use a fixed 960x540 canvas that is scaled to fit the screen.

import { h, icon, iconBtn, keepFocus, toast, busy, actionSheet, pickColor, confirmBox, customDialog, debounce, escapeHtml } from '../ui.js';
import { exportFile, pickFiles } from '../files.js';
import { topBar, persist } from './shell.js';
import { sanitize, shrinkImage } from './docs.js';
import { chartSvg, CHART_TYPES, dataToText, textToData } from './charts.js';
import { formatPanel, group, row, segmented, toggles, stepper, swatches, switchRow, actions, choices, chips, note, FONTS, fontLabel } from './panel.js';

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

async function pptxToSlides(bytes) {
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

// Text-only slide outlines ([{ title, lines }]) from Keynote and old .ppt files.
function outlineToDeck(outline) {
  const slides = outline.map(({ title, lines }) => {
    const els = lines.length ? LAYOUTS.content() : LAYOUTS.title().slice(0, 1);
    els[0].html = escapeHtml(title || '');
    if (lines.length) els[1].html = `<ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`;
    return { id: newId(), els };
  });
  return { theme: 0, slides };
}

export async function importFile(bytes, name = '') {
  const ext = name.split('.').pop().toLowerCase();
  if (ext === 'ppt' || ext === 'pps' || ext === 'pot') {
    const { pptToSlides } = await import('./formats/legacy.js');
    return outlineToDeck(pptToSlides(bytes));
  }
  if (ext === 'key') {
    const { keynoteToSlides } = await import('./formats/iwork.js');
    const { slides, preview } = await keynoteToSlides(bytes);
    if (slides.length) return outlineToDeck(slides);
    if (preview) return { theme: 0, slides: [{ id: newId(), els: [{ id: newId(), type: 'image', src: preview, x: 0, y: 0, w: W, h: H }] }] };
    throw new Error('Could not read this Keynote file');
  }
  if (ext === 'odp' || ext === 'otp') {
    const { odpToSlides } = await import('./formats/odf.js');
    const deck = await odpToSlides(bytes);
    const k = Math.min(W / deck.width, H / deck.height);
    return {
      theme: 0,
      slides: deck.slides.map((sl) => ({
        id: newId(),
        els: sl.els.map((e) => {
          const box = { x: e.x * k, y: e.y * k, w: e.w * k, h: e.h * k };
          return e.type === 'image'
            ? { id: newId(), type: 'image', src: e.src, ...box }
            : text({ ...box, html: sanitize(e.html), size: e.title ? 40 : 24, bold: e.title, role: e.title ? 'title' : undefined });
        }),
      })),
    };
  }
  return pptxToSlides(bytes);
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
      const look = {
        rotate: el.rot || undefined,
        line: el.stroke && el.strokeW ? { color: toHex(el.stroke), width: el.strokeW * 0.75, dashType: el.dash === 'dashed' ? 'dash' : el.dash === 'dotted' ? 'sysDot' : 'solid' } : undefined,
        shadow: el.shadow ? { type: 'outer', blur: 8, offset: 4, angle: 90, color: '000000', opacity: 0.3 } : undefined,
      };
      const transparency = el.opacity != null && el.opacity < 1 ? Math.round((1 - el.opacity) * 100) : undefined;
      if (el.type === 'image') slide.addImage({ data: el.src, ...pos, rotate: look.rotate, transparency, rounding: el.radius > 0 && Math.abs(el.w - el.h) < 2 && el.radius >= el.w / 2 });
      else if (el.type === 'chart') {
        const kind = { column: 'bar', bar: 'bar', line: 'line', area: 'area', pie: 'pie', doughnut: 'doughnut' }[el.chartType] || 'bar';
        const series = el.chartType === 'pie' || el.chartType === 'doughnut' ? el.data.series.slice(0, 1) : el.data.series;
        slide.addChart(pptx.ChartType[kind], series.map((sr) => ({ name: sr.name, labels: el.data.labels, values: sr.values })), {
          ...pos,
          barDir: el.chartType === 'bar' ? 'bar' : 'col',
          showLegend: el.legend !== false,
          legendPos: 'b',
          showTitle: !!el.title,
          title: el.title || undefined,
          chartColors: ['2B6FDC', 'E8711A', '1F9D55', 'D93A3A', '6A4CD6', '14A3A3'],
        });
      } else if (el.type === 'shape') {
        const type = {
          rect: 'rect', roundRect: 'roundRect', ellipse: 'ellipse', triangle: 'triangle', diamond: 'diamond', star: 'star5',
          arrow: 'rightArrow', hexagon: 'hexagon', bubble: 'wedgeRoundRectCallout', line: 'line',
        }[el.shape] || 'rect';
        const isLine = el.shape === 'line';
        slide.addShape(pptx.ShapeType[type], {
          ...pos,
          ...(isLine ? { y: inch(el.y + el.h / 2), h: 0 } : {}),
          fill: !isLine && el.fill ? { color: toHex(el.fill), transparency } : isLine ? undefined : { type: 'none' },
          line: isLine ? { color: toHex(el.stroke || el.fill || theme.accent), width: (el.strokeW || 4) * 0.75 } : look.line,
          rotate: look.rotate,
          shadow: look.shadow,
          rectRadius: el.shape === 'roundRect' ? Math.min(0.5, (el.radius ?? 28) / Math.min(el.w, el.h)) : undefined,
        });
      } else if (/<table/i.test(el.html)) {
        const rows = [...h('div', { html: el.html }).querySelectorAll('tr')].map((tr) => [...tr.children].map((td) => ({ text: td.textContent.trim() })));
        if (rows.length) {
          slide.addTable(rows, { ...pos, fontSize: Math.round(el.size * 0.75 * (10 / (W / 96))), color: toHex(el.color || theme.color), border: { type: 'solid', pt: 1, color: toHex(el.color || theme.color) }, fontFace: 'Arial' });
        }
      } else {
        const runs = htmlToRuns(el.html, {
          color: toHex(el.color || (el.role === 'title' ? theme.accent : theme.color)), bold: !!el.bold, italic: !!el.italic,
          underline: el.underline ? { style: 'sng' } : undefined, strike: el.strike ? 'sngStrike' : undefined,
        });
        slide.addText(runs.length ? runs : '', {
          ...pos,
          fontSize: Math.round(el.size * 0.75 * (10 / (W / 96))),
          align: el.align,
          valign: el.valign === 'middle' ? 'middle' : el.valign === 'bottom' ? 'bottom' : 'top',
          fontFace: el.font ? fontLabel(el.font) : 'Arial',
          lineSpacingMultiple: el.lh ? Math.round((el.lh / 1.2) * 100) / 100 : undefined,
          margin: 4,
          fill: el.fill ? { color: toHex(el.fill), transparency } : undefined,
          ...look,
        });
      }
    }
    if (s.notes) slide.addNotes(s.notes);
  }
  return pptx.write({ outputType: 'blob' });
}

// Text box contents as plain lines, bullets or numbers.
function setListKind(html, kind) {
  const items = /<li/i.test(html)
    ? [...h('div', { html }).querySelectorAll('li')].map((li) => li.innerHTML)
    : html.split(/<br\s*\/?>|<\/div>|<\/p>/i).map((t) => t.replace(/<(div|p)[^>]*>/gi, '')).filter((t) => t.trim());
  if (kind === 'none') return items.map((t) => `<div>${t}</div>`).join('');
  const tag = kind === 'ol' ? 'ol' : 'ul';
  return `<${tag}>${(items.length ? items : ['']).map((t) => `<li>${t}</li>`).join('')}</${tag}>`;
}

// ---------- Rendering ----------
function renderSlide(s, theme, { editable = false } = {}) {
  const node = h('div', { class: 'slide', style: { background: s.bg || theme.bg, color: theme.color } });
  for (const el of s.els) node.append(renderEl(el, theme, editable, s.bg || theme.bg));
  return node;
}

export const SHAPES = [
  { value: 'rect', label: 'Rectangle', icon: 'square' },
  { value: 'roundRect', label: 'Rounded', icon: 'roundRect' },
  { value: 'ellipse', label: 'Circle', icon: 'circle' },
  { value: 'triangle', label: 'Triangle', icon: 'triangle' },
  { value: 'diamond', label: 'Diamond', icon: 'diamond' },
  { value: 'star', label: 'Star', icon: 'star' },
  { value: 'arrow', label: 'Arrow', icon: 'arrowShape' },
  { value: 'hexagon', label: 'Hexagon', icon: 'hexagon' },
  { value: 'bubble', label: 'Speech bubble', icon: 'bubble' },
  { value: 'line', label: 'Line', icon: 'line' },
];
const starPoints = () => Array.from({ length: 10 }, (_, i) => {
  const r = i % 2 ? 21 : 48;
  const a = -Math.PI / 2 + (i * Math.PI) / 5;
  return `${(50 + Math.cos(a) * r).toFixed(1)},${(53 + Math.sin(a) * r).toFixed(1)}`;
}).join(' ');
const SVG_SHAPES = {
  triangle: '<polygon points="50,3 97,97 3,97"/>',
  diamond: '<polygon points="50,2 98,50 50,98 2,50"/>',
  star: `<polygon points="${starPoints()}"/>`,
  arrow: '<polygon points="2,30 60,30 60,5 98,50 60,95 60,70 2,70"/>',
  hexagon: '<polygon points="25,3 75,3 98,50 75,97 25,97 2,50"/>',
  bubble: '<path d="M10,4 H90 Q97,4 97,11 V64 Q97,71 90,71 H42 L22,95 L27,71 H10 Q3,71 3,64 V11 Q3,4 10,4 Z"/>',
};
const DASH = (el) => (el.dash === 'dashed' ? `${el.strokeW * 3} ${el.strokeW * 2}` : el.dash === 'dotted' ? `${el.strokeW} ${el.strokeW * 1.6}` : '');

function renderEl(el, theme, editable, slideBg) {
  const style = { left: `${el.x}px`, top: `${el.y}px`, width: `${el.w}px`, height: `${el.h}px` };
  if (el.rot) style.transform = `rotate(${el.rot}deg)`;
  if (el.opacity != null && el.opacity < 1) style.opacity = String(el.opacity);
  if (el.shadow) style.filter = 'drop-shadow(0 8px 14px rgba(0, 0, 0, 0.3))';
  const border = el.stroke && el.strokeW ? `${el.strokeW}px ${el.dash || 'solid'} ${el.stroke}` : '';
  if (el.type === 'image') {
    return h('div', { class: 'el image', 'data-id': el.id, style: { ...style, border, borderRadius: el.radius ? `${el.radius}px` : '', overflow: 'hidden' } },
      h('img', { src: el.src, alt: '', draggable: false }));
  }
  if (el.type === 'chart') {
    return h('div', {
      class: 'el chart', 'data-id': el.id,
      style: { ...style, color: theme.color, '--chart-bg': el.fill || slideBg, background: el.fill || 'transparent', border, borderRadius: el.radius ? `${el.radius}px` : '' },
      html: chartSvg({ type: el.chartType, title: el.title, data: el.data, width: el.w, height: el.h, showLegend: el.legend !== false }),
    });
  }
  if (el.type === 'shape') {
    if (el.shape === 'rect' || el.shape === 'roundRect' || el.shape === 'ellipse') {
      return h('div', { class: `el shape ${el.shape}`, 'data-id': el.id, style: {
        ...style, background: el.fill || 'transparent', border, boxSizing: 'border-box',
        borderRadius: el.shape === 'ellipse' ? '50%' : `${el.radius ?? (el.shape === 'roundRect' ? 28 : 0)}px`,
      } });
    }
    const stroke = el.shape === 'line' ? (el.stroke || el.fill || theme.accent) : (el.stroke && el.strokeW ? el.stroke : 'none');
    const width = el.shape === 'line' ? (el.strokeW || 4) : (el.strokeW || 0);
    const body = el.shape === 'line' ? '<line x1="0" y1="50" x2="100" y2="50"/>' : SVG_SHAPES[el.shape] || SVG_SHAPES.triangle;
    const dash = DASH({ ...el, strokeW: width });
    return h('div', { class: `el shape ${el.shape}`, 'data-id': el.id, style,
      html: `<svg viewBox="0 0 100 100" preserveAspectRatio="none" width="100%" height="100%" overflow="visible"><g fill="${el.shape === 'line' ? 'none' : (el.fill || 'none')}" stroke="${stroke}" stroke-width="${width}" stroke-dasharray="${dash}" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke">${body.replace(/\/>$/, ' vector-effect="non-scaling-stroke"/>')}</g></svg>` });
  }
  const valign = el.valign && el.valign !== 'top' ? { display: 'flex', flexDirection: 'column', justifyContent: el.valign === 'middle' ? 'center' : 'flex-end' } : {};
  return h('div', {
    class: 'el text',
    'data-id': el.id,
    html: el.html,
    style: {
      ...style,
      ...valign,
      fontSize: `${el.size}px`,
      fontWeight: el.bold ? '700' : '400',
      fontStyle: el.italic ? 'italic' : '',
      textDecoration: [el.underline && 'underline', el.strike && 'line-through'].filter(Boolean).join(' '),
      fontFamily: el.font || '',
      lineHeight: el.lh ? String(el.lh) : '',
      textAlign: el.align,
      color: el.color || (el.role === 'title' ? theme.accent : theme.color),
      background: el.fill || 'transparent',
      border,
      borderRadius: el.radius ? `${el.radius}px` : '',
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
  const readOnly = !!doc.readOnly;
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
  const save = readOnly ? Object.assign(() => {}, { flush() {} }) : debounce(() => persist(doc), 600);

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
  const elMenuSlot = () => stage.append(elMenu);
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
    placeMenu();
  }

  function renderThumbs() {
    thumbs.replaceChildren(...data.slides.map((s, i) => {
      const mini = renderSlide(s, theme());
      mini.style.transform = `scale(${108 / W})`;
      return h('button', { class: `thumb${i === current ? ' on' : ''}`, 'aria-label': `Slide ${i + 1}`, onClick: () => (i === current ? (readOnly ? null : slideMenu()) : goTo(i)) },
        mini, h('span', { class: 'num' }, i + 1));
    }), readOnly ? '' : h('button', { class: 'thumb add', 'aria-label': 'New slide', onClick: addSlide }, icon('plus')));
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
    placeMenu();
    if (panel.isOpen) panel.refresh();
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
    elMenu.hidden = true;
    toolbar.hidden = false;
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
    toolbar.hidden = true;
    save();
    renderThumbs();
    placeMenu();
  }

  // Drag to move, drag the round handle to resize, tap a selected text box to type.
  let drag = null;
  stage.addEventListener('pointerdown', (e) => {
    if (readOnly) return; // look, don't touch
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
    if (!drag.moved) { snapshot(); drag.moved = true; elMenu.hidden = true; }
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
    if (moved) { save(); renderThumbs(); placeMenu(); if (panel.isOpen) panel.refresh(); return; }
    if (wasSelected && el.type === 'text') startEditing(id);
    else placeMenu();
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
    stopEditing();
    const value = await actionSheet('Insert', [
      { icon: 'type', label: 'Text box', value: 'text' },
      { icon: 'triangle', label: 'Shape', hint: 'star, arrow, bubble…', value: 'shape' },
      { icon: 'image', label: 'Picture', value: 'image' },
      { icon: 'table', label: 'Table', value: 'table' },
      { icon: 'chart', label: 'Chart', value: 'chart' },
      { icon: 'layers', label: 'New slide', value: 'slide' },
    ]);
    if (value === 'text') addElement(text({ x: 280, y: 220, w: 400, h: 80, size: 28 }));
    if (value === 'slide') addSlide();
    if (value === 'shape') {
      const shape = await new Promise((resolve) => {
        const grid = h('div', { class: 'shape-grid' }, SHAPES.map((sh) => h('button', {
          'aria-label': sh.label, title: sh.label,
          onClick: () => { grid.closest('.action-sheet').closeSheet(null); resolve(sh.value); },
        }, icon(sh.icon), h('span', {}, sh.label))));
        actionSheet('Shapes', [{ node: grid }]).then(() => resolve(null));
      });
      if (!shape) return;
      const line = shape === 'line';
      addElement({ id: newId(), type: 'shape', shape, x: line ? 330 : 380, y: line ? 260 : 170, w: line ? 300 : 200, h: line ? 20 : 200, fill: line ? undefined : theme().accent, stroke: line ? theme().accent : undefined, strokeW: line ? 4 : undefined });
    }
    if (value === 'table') {
      const cells = (r) => `<tr>${[1, 2, 3].map((c) => `<td>${r === 0 ? `Heading ${c}` : ''}</td>`).join('')}</tr>`;
      addElement(text({ x: 120, y: 150, w: 720, h: 240, size: 22, html: `<table><tbody>${[0, 1, 2, 3].map(cells).join('')}</tbody></table>` }));
    }
    if (value === 'chart') {
      const chartType = await actionSheet('Chart type', CHART_TYPES.map((t) => ({ icon: t.icon, label: t.label, value: t.value })));
      if (!chartType) return;
      addElement({
        id: newId(), type: 'chart', chartType, x: 180, y: 110, w: 600, h: 360, title: '',
        data: { labels: ['Q1', 'Q2', 'Q3', 'Q4'], series: [{ name: '2025', values: [12, 18, 15, 22] }, { name: '2026', values: [16, 21, 24, 30] }] },
      });
    }
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
    if (cmd === 'italic') el.italic = !el.italic;
    if (cmd === 'underline') el.underline = !el.underline;
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

  function deleteSelected() {
    if (!selectedId || editingId) return;
    snapshot();
    slide().els = slide().els.filter((e) => e.id !== selectedId);
    selectedId = null;
    renderAll();
    save();
  }

  // ---- Changing the selected object ----
  function updateEl(fn, { rerender = true } = {}) {
    const el = selectedId && findEl(selectedId);
    if (!el) return;
    snapshot();
    fn(el);
    const wasEditing = editingId;
    if (rerender) {
      if (wasEditing) stopEditing();
      renderStage();
      renderThumbsSoon();
      if (wasEditing) startEditing(wasEditing);
    }
    save();
  }
  function updateSlide(fn) {
    snapshot();
    fn(slide());
    renderAll();
    save();
  }
  function arrangeEl(action) {
    const el = selectedId && findEl(selectedId);
    if (!el) return;
    stopEditing();
    snapshot();
    const els = slide().els;
    const i = els.indexOf(el);
    if (action === 'front') { els.splice(i, 1); els.push(el); }
    if (action === 'back') { els.splice(i, 1); els.unshift(el); }
    if (action === 'forward' && i < els.length - 1) [els[i], els[i + 1]] = [els[i + 1], els[i]];
    if (action === 'backward' && i > 0) [els[i], els[i - 1]] = [els[i - 1], els[i]];
    if (action === 'left') el.x = 0;
    if (action === 'hcenter') el.x = Math.round((W - el.w) / 2);
    if (action === 'right') el.x = W - el.w;
    if (action === 'top') el.y = 0;
    if (action === 'vcenter') el.y = Math.round((H - el.h) / 2);
    if (action === 'bottom') el.y = H - el.h;
    if (action === 'dup') { const copy = { ...JSON.parse(JSON.stringify(el)), id: newId(), x: el.x + 24, y: el.y + 24 }; els.push(copy); selectedId = copy.id; }
    if (action === 'del') { els.splice(i, 1); selectedId = null; }
    renderAll();
    save();
    if (panel.isOpen) panel.refresh();
  }

  // ---- Floating menu over the selected object (like Keynote's) ----
  const elMenu = h('div', { class: 'el-menu', hidden: true });
  function placeMenu() {
    const el = selectedId && !editingId && !drag && findEl(selectedId);
    if (!el || readOnly || panel.isOpen) { elMenu.hidden = true; return; }
    elMenu.replaceChildren(
      el.type === 'text' ? keepFocus(h('button', { onClick: () => startEditing(el.id) }, 'Edit')) : null,
      el.type === 'chart' ? h('button', { onClick: () => editChartData() }, 'Data') : null,
      h('button', { onClick: () => openFormat() }, 'Format'),
      h('button', { onClick: () => arrangeEl('dup') }, 'Copy'),
      h('button', { class: 'danger', onClick: () => arrangeEl('del') }, 'Delete'),
    );
    elMenu.hidden = false;
    const fr = frame.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    const mw = elMenu.offsetWidth;
    const left = fr.left - sr.left + (el.x + el.w / 2) * scale - mw / 2;
    let top = fr.top - sr.top + el.y * scale - 50;
    if (top < 4) top = fr.top - sr.top + (el.y + el.h) * scale + 10;
    elMenu.style.left = `${Math.max(4, Math.min(sr.width - mw - 4, left))}px`;
    elMenu.style.top = `${Math.max(4, Math.min(sr.height - 44, top))}px`;
  }

  async function editChartData() {
    const el = selectedId && findEl(selectedId);
    if (!el || el.type !== 'chart') return;
    const text = await customDialog('Chart data', (box, close) => {
      const area = h('textarea', { class: 'field', rows: 8, style: { fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '14px' } });
      area.value = dataToText(el.data);
      box.append(
        h('p', {}, 'One row per line, values separated by commas. The first row holds the series names.'),
        area,
        h('div', { class: 'row' },
          h('button', { class: 'btn', onClick: () => close(null) }, 'Cancel'),
          h('button', { class: 'btn primary', onClick: () => close(area.value) }, 'Done')));
      setTimeout(() => area.focus(), 50);
    });
    if (text == null) return;
    const data = textToData(text);
    if (!data.series.length) return toast('No numbers found');
    updateEl((e) => { e.data = data; });
  }

  // ---- Format panel ----
  const TRANSITIONS = [
    { value: '', label: 'None' },
    { value: 'dissolve', label: 'Dissolve' },
    { value: 'push', label: 'Push' },
    { value: 'movein', label: 'Move in' },
    { value: 'zoom', label: 'Zoom' },
    { value: 'flip', label: 'Flip' },
  ];
  function styleTab(el) {
    const isLine = el.type === 'shape' && el.shape === 'line';
    const out = [];
    if (el.type === 'chart') {
      out.push(group('Chart type', actions(CHART_TYPES.map((t) => ({ icon: t.icon, label: (t.value === el.chartType ? '● ' : '') + t.label, onClick: () => { updateEl((e) => { e.chartType = t.value; }); panel.refresh(); } })), 3)));
      const title = h('input', { class: 'fp-input', value: el.title || '', placeholder: 'No title' });
      title.addEventListener('change', () => updateEl((e) => { e.title = title.value.trim(); }));
      out.push(group(null, row('Title', title), switchRow('Legend', el.legend !== false, (on) => updateEl((e) => { e.legend = on; })),
        h('button', { class: 'fp-link', onClick: editChartData }, 'Edit chart data')));
    }
    if (!isLine && el.type !== 'image') {
      out.push(group(el.type === 'text' ? 'Background' : 'Fill', swatches(el.fill, (c) => updateEl((e) => { e.fill = c === 'none' ? undefined : c; }), { allowNone: true })));
    }
    out.push(group(isLine ? 'Line' : 'Border',
      isLine ? null : segmented([{ value: '', label: 'None' }, { value: 'solid', label: 'Solid' }, { value: 'dashed', label: 'Dashed' }, { value: 'dotted', label: 'Dotted' }],
        el.stroke && el.strokeW ? (el.dash || 'solid') : '', (v) => updateEl((e) => {
          if (!v) { e.stroke = undefined; return; }
          e.stroke = e.stroke || theme().color;
          e.strokeW = e.strokeW || 3;
          e.dash = v === 'solid' ? undefined : v;
        }), { wide: true }),
      isLine ? segmented([{ value: '', label: 'Solid' }, { value: 'dashed', label: 'Dashed' }, { value: 'dotted', label: 'Dotted' }], el.dash || '', (v) => updateEl((e) => { e.dash = v || undefined; }), { wide: true }) : null,
      swatches(isLine ? (el.stroke || el.fill || theme().accent) : el.stroke, (c) => updateEl((e) => { e.stroke = c === 'none' ? undefined : c; if (!e.strokeW) e.strokeW = isLine ? 4 : 3; })),
      row('Width', stepper(el.strokeW || (isLine ? 4 : 0), { min: isLine ? 1 : 0, max: 30, format: (v) => `${v} pt` }, (v) => updateEl((e) => { e.strokeW = v; if (v && !e.stroke && !isLine) e.stroke = theme().color; })))));
    const rounded = el.type === 'image' || el.type === 'text' || el.type === 'chart' || el.shape === 'rect' || el.shape === 'roundRect';
    out.push(group(null,
      rounded ? row('Corner radius', stepper(el.radius ?? (el.shape === 'roundRect' ? 28 : 0), { min: 0, max: 200, step: 4, format: (v) => `${v}` }, (v) => updateEl((e) => { e.radius = v; }))) : null,
      switchRow('Shadow', !!el.shadow, (on) => updateEl((e) => { e.shadow = on || undefined; })),
      row('Opacity', stepper(Math.round((el.opacity ?? 1) * 100), { min: 10, max: 100, step: 10, format: (v) => `${v}%` }, (v) => updateEl((e) => { e.opacity = v >= 100 ? undefined : v / 100; })))));
    return out;
  }
  function textTab(el) {
    const ranged = () => editingId && !getSelection().isCollapsed;
    const inline = (command, key) => () => {
      if (ranged()) { document.execCommand(command); findEl(editingId).html = slideEl.querySelector(`[data-id="${editingId}"]`).innerHTML; save(); return; }
      updateEl((e) => { e[key] = !e[key]; });
    };
    return [
      group(null, toggles([
        { icon: 'bold', title: 'Bold', on: !!el.bold, onClick: inline('bold', 'bold') },
        { icon: 'italic', title: 'Italic', on: !!el.italic, onClick: inline('italic', 'italic') },
        { icon: 'underline', title: 'Underline', on: !!el.underline, onClick: inline('underline', 'underline') },
        { icon: 'strike', title: 'Strikethrough', on: !!el.strike, onClick: inline('strikeThrough', 'strike') },
      ])),
      group('Font', chips(FONTS.map((f) => ({ value: f.label, label: f.label, style: { fontFamily: f.css } })), fontLabel(el.font) || 'System',
        (label) => updateEl((e) => { e.font = FONTS.find((f) => f.label === label).css; }))),
      group(null, row('Size', stepper(el.size, { min: 8, max: 200, step: 2, format: (v) => `${v} pt` }, (v) => updateEl((e) => { e.size = v; })))),
      group('Colour', swatches(el.color || (el.role === 'title' ? theme().accent : theme().color), (c) => {
        if (ranged()) { document.execCommand('styleWithCSS', false, true); document.execCommand('foreColor', false, c); findEl(editingId).html = slideEl.querySelector(`[data-id="${editingId}"]`).innerHTML; save(); return; }
        updateEl((e) => { e.color = c === 'none' ? undefined : c; });
      })),
      group('Alignment',
        segmented([
          { value: 'left', icon: 'alignLeft', title: 'Left' }, { value: 'center', icon: 'alignCenter', title: 'Center' },
          { value: 'right', icon: 'alignRight', title: 'Right' }, { value: 'justify', icon: 'alignJustify', title: 'Justify' },
        ], el.align || 'left', (v) => updateEl((e) => { e.align = v; }), { wide: true }),
        segmented([
          { value: 'top', icon: 'alignTop', title: 'Top' }, { value: 'middle', icon: 'alignMiddle', title: 'Middle' }, { value: 'bottom', icon: 'alignBottom', title: 'Bottom' },
        ], el.valign || 'top', (v) => updateEl((e) => { e.valign = v === 'top' ? undefined : v; }), { wide: true })),
      group('Line spacing', segmented([{ value: 1, label: '1.0' }, { value: 1.2, label: '1.2' }, { value: 1.5, label: '1.5' }, { value: 2, label: '2.0' }],
        el.lh || 1.2, (v) => updateEl((e) => { e.lh = v === 1.2 ? undefined : v; }), { wide: true })),
      group('Bullets', segmented([{ value: 'none', label: 'None' }, { value: 'ul', icon: 'listBullet', title: 'Bullets' }, { value: 'ol', icon: 'listNumber', title: 'Numbers' }],
        /<ol/i.test(el.html) ? 'ol' : /<ul/i.test(el.html) ? 'ul' : 'none', (v) => updateEl((e) => { e.html = setListKind(e.html, v); }), { wide: true })),
    ];
  }
  function arrangeTab(el) {
    const num = (label, key, step = 10) => row(label, stepper(Math.round(el[key]), { min: key === 'w' || key === 'h' ? 10 : -2000, max: 4000, step }, (v) => updateEl((e) => { e[key] = v; })));
    return [
      group(null, actions([
        { icon: 'forward', label: 'Forward', onClick: () => arrangeEl('forward') },
        { icon: 'backward', label: 'Backward', onClick: () => arrangeEl('backward') },
        { icon: 'up', label: 'To front', onClick: () => arrangeEl('front') },
        { icon: 'down', label: 'To back', onClick: () => arrangeEl('back') },
      ], 4)),
      group('Align on slide', actions([
        { icon: 'alignHLeft', label: 'Left', onClick: () => arrangeEl('left') },
        { icon: 'alignHCenter', label: 'Center', onClick: () => arrangeEl('hcenter') },
        { icon: 'alignHRight', label: 'Right', onClick: () => arrangeEl('right') },
        { icon: 'alignTop', label: 'Top', onClick: () => arrangeEl('top') },
        { icon: 'alignMiddle', label: 'Middle', onClick: () => arrangeEl('vcenter') },
        { icon: 'alignBottom', label: 'Bottom', onClick: () => arrangeEl('bottom') },
      ], 3)),
      group('Size & position', num('X', 'x'), num('Y', 'y'), num('Width', 'w'), num('Height', 'h'),
        row('Rotate', stepper(el.rot || 0, { min: -180, max: 180, step: 15, format: (v) => `${v}°` }, (v) => updateEl((e) => { e.rot = v || undefined; })))),
      group(null, actions([
        { icon: 'copy', label: 'Duplicate', onClick: () => arrangeEl('dup') },
        { icon: 'trash', label: 'Delete', danger: true, onClick: () => arrangeEl('del') },
      ], 2)),
    ];
  }
  function slideTabs() {
    const s = slide();
    return [
      { key: 'slide', label: 'Slide', render: () => [
        group('Background', swatches(s.bg || theme().bg, (c) => updateSlide((sl) => { sl.bg = c === 'none' ? undefined : c; }), { allowNone: true })),
        group('Transition', choices(TRANSITIONS, s.transition?.type || '', (v) => updateSlide((sl) => { sl.transition = v ? { ...(sl.transition || {}), type: v } : undefined; }))),
        s.transition?.type && group(null, row('Speed', segmented([{ value: 0.4, label: 'Fast' }, { value: 0.7, label: 'Normal' }, { value: 1.2, label: 'Slow' }],
          s.transition.dur || 0.7, (v) => updateSlide((sl) => { sl.transition.dur = v; })))),
        s.transition?.type && h('button', { class: 'btn', style: { width: '100%', marginBottom: '12px' }, onClick: () => present(current) }, 'Preview from this slide'),
      ] },
      { key: 'theme', label: 'Theme', render: () => [
        group(null, choices(THEMES.map((t, i) => ({
          value: i,
          label: h('span', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
            h('span', { style: { width: '48px', height: '28px', borderRadius: '6px', background: t.bg, border: '1px solid var(--line)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: t.accent, fontWeight: 700, fontSize: '13px' } }, 'Aa'),
            t.name),
        })), data.theme, (i) => { snapshot(); data.theme = i; renderAll(); save(); })),
      ] },
      { key: 'notes', label: 'Notes', render: () => {
        const area = h('textarea', { placeholder: 'Presenter notes for this slide (they go into the PowerPoint file too)' });
        area.value = s.notes || '';
        area.addEventListener('input', () => { s.notes = area.value; save(); });
        return [group(null, area), note('Only you see these notes.')];
      } },
    ];
  }
  const panel = formatPanel({
    title: 'Format',
    onClose: () => { brushBtn.classList.remove('on'); requestAnimationFrame(() => { renderStage(); placeMenu(); }); },
    tabs: () => {
      const el = selectedId && findEl(selectedId);
      if (!el) return slideTabs();
      return [
        { key: 'style', label: 'Style', render: () => styleTab(el) },
        el.type === 'text' && { key: 'text', label: 'Text', render: () => textTab(el) },
        { key: 'arrange', label: 'Arrange', render: () => arrangeTab(el) },
      ];
    },
  });
  function openFormat(tab) {
    if (panel.isOpen && !tab) { panel.close(); return; }
    brushBtn.classList.add('on');
    elMenu.hidden = true;
    panel.show(root, tab);
    requestAnimationFrame(renderStage);
  }

  function onKey(e) {
    if (editingId || document.querySelector('.scrim, .present')) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId && !readOnly) { e.preventDefault(); deleteSelected(); }
    if (e.key === 'ArrowRight' || e.key === 'PageDown') goTo(Math.min(current + 1, data.slides.length - 1));
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') goTo(Math.max(current - 1, 0));
  }
  document.addEventListener('keydown', onKey);

  // ---- Present (with slide transitions) ----
  function present(start = current) {
    stopEditing();
    let i = typeof start === 'number' ? start : current;
    const view = h('div', { class: 'present' });
    const counter = h('div', { class: 'counter' });
    let shown = null;
    const build = (idx) => {
      const f = h('div', { class: 'slide-frame' });
      const s = renderSlide(data.slides[idx], theme());
      f.append(s);
      f.style.background = data.slides[idx].bg || theme().bg;
      fitFrame(f, s, window.innerWidth, window.innerHeight);
      return f;
    };
    const show = (dir = 0) => {
      const next = build(i);
      counter.textContent = `${i + 1} / ${data.slides.length}`;
      const tr = dir > 0 ? data.slides[i].transition : null;
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      if (!shown || !tr?.type || reduce) { shown?.remove(); view.prepend(next); shown = next; return; }
      const old = shown;
      const dur = `${tr.dur || 0.7}s`;
      next.style.animationDuration = dur;
      old.style.animationDuration = dur;
      old.classList.add(`tr-${tr.type}-out`);
      next.classList.add(`tr-${tr.type}-in`);
      old.after(next);
      shown = next;
      let gone = false;
      const done = () => { if (!gone) { gone = true; old.remove(); } };
      next.addEventListener('animationend', done, { once: true });
      setTimeout(done, (tr.dur || 0.7) * 1000 + 400);
    };
    const onResize = () => { const f = build(i); shown?.replaceWith(f); shown = f; };
    const close = () => { view.remove(); window.removeEventListener('keydown', keys); window.removeEventListener('resize', onResize); document.exitFullscreen?.().catch(() => {}); };
    const step = (d) => {
      const to = Math.max(0, Math.min(data.slides.length - 1, i + d));
      if (to === i) return;
      i = to;
      show(d);
    };
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
    view.append(counter, iconBtn('x', 'End show', close, { class: 'icon-btn close' }));
    document.body.append(view);
    window.addEventListener('keydown', keys);
    window.addEventListener('resize', onResize);
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
  const boldBtn = keepFocus(iconBtn('bold', 'Bold', () => format('bold')));
  function refreshToolbar() {
    const el = selectedId && findEl(selectedId);
    boldBtn.classList.toggle('on', !!el?.bold);
  }
  // Shown while typing in a text box; everything else lives in Format.
  const toolbar = h('nav', { class: 'toolbar', 'aria-label': 'Text tools', hidden: true },
    keepFocus(h('button', { class: 'tb-text tb-aa', 'aria-label': 'Text format', onClick: () => openFormat('text') }, 'Aa')),
    sep(),
    boldBtn,
    keepFocus(iconBtn('italic', 'Italic', () => format('italic'))),
    keepFocus(iconBtn('underline', 'Underline', () => format('underline'))),
    keepFocus(h('button', { class: 'tb-text', 'aria-label': 'Smaller text', onClick: () => format('smaller') }, h('span', { style: { fontSize: '12px' } }, 'A'), '−')),
    keepFocus(h('button', { class: 'tb-text', 'aria-label': 'Bigger text', onClick: () => format('bigger') }, h('span', { style: { fontSize: '18px' } }, 'A'), '+')),
    keepFocus(iconBtn('alignLeft', 'Align left', () => format('align:left'))),
    keepFocus(iconBtn('alignCenter', 'Center', () => format('align:center'))),
    keepFocus(iconBtn('listBullet', 'Bullets', () => format('bullets'))),
    sep(),
    keepFocus(h('button', { class: 'tb-text', onClick: () => stopEditing() }, 'Done')),
  );

  async function moreMenu() {
    stopEditing();
    const value = await actionSheet(null, [
      { icon: 'share', label: 'Save a copy / share', value: 'export' },
      { icon: 'redo', label: 'Redo', value: 'redo' },
      { icon: 'transition', label: 'Transition & background', value: 'slide' },
      { icon: 'palette', label: 'Theme', value: 'theme' },
      { icon: 'notes', label: 'Presenter notes', value: 'notes' },
      { icon: 'layers', label: 'This slide…', value: 'slideMenu' },
    ]);
    if (value === 'export') exportMenu();
    if (value === 'redo') redo();
    if (value === 'slide' || value === 'theme' || value === 'notes') { selectEl(null); openFormat(value); }
    if (value === 'slideMenu') slideMenu();
  }

  async function close() {
    stopEditing();
    save.flush();
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
    onExit();
  }

  const brushBtn = keepFocus(iconBtn('brush', 'Format', () => openFormat()));
  const bar = topBar(doc, {
    onBack: close,
    buttons: readOnly ? [iconBtn('play', 'Present', () => present())] : [
      iconBtn('undo', 'Undo', undo),
      brushBtn,
      keepFocus(iconBtn('plus', 'Insert', insertMenu)),
      iconBtn('play', 'Present', () => present()),
      iconBtn('more', 'More', moreMenu),
    ],
  });

  const onResize = debounce(() => { if (!editingId) renderStage(); }, 150);
  elMenuSlot();
  window.addEventListener('resize', onResize);

  if (readOnly) root.append(bar, stage, thumbs);
  else root.append(bar, stage, thumbs, toolbar);
  renderAll();
  requestAnimationFrame(renderStage);
  return close;
}
