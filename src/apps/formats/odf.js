// OpenDocument text (.odt) and presentation (.odp) readers, as made by
// LibreOffice, OpenOffice, Google Docs exports and others.

import { escapeHtml } from '../../ui.js';

const NS = {
  text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
  style: 'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
  fo: 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0',
  table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
  draw: 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0',
  svg: 'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0',
  xlink: 'http://www.w3.org/1999/xlink',
  office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
  presentation: 'urn:oasis:names:tc:opendocument:xmlns:presentation:1.0',
};

async function load(bytes) {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(bytes);
  const parse = async (name) => {
    const f = zip.file(name);
    return f ? new DOMParser().parseFromString(await f.async('text'), 'application/xml') : null;
  };
  return { zip, content: await parse('content.xml'), styles: await parse('styles.xml') };
}

// Style name -> CSS and flags, from both style files.
function readStyles(...docs) {
  const map = {};
  const lists = {};
  for (const doc of docs) {
    if (!doc) continue;
    for (const s of doc.getElementsByTagNameNS(NS.style, 'style')) {
      const name = s.getAttributeNS(NS.style, 'name');
      const css = [];
      const tp = s.getElementsByTagNameNS(NS.style, 'text-properties')[0];
      const pp = s.getElementsByTagNameNS(NS.style, 'paragraph-properties')[0];
      if (tp) {
        if (tp.getAttributeNS(NS.fo, 'font-weight') === 'bold') css.push('font-weight:700');
        if (tp.getAttributeNS(NS.fo, 'font-style') === 'italic') css.push('font-style:italic');
        const deco = [];
        const ul = tp.getAttributeNS(NS.style, 'text-underline-style');
        if (ul && ul !== 'none') deco.push('underline');
        const lt = tp.getAttributeNS(NS.style, 'text-line-through-style');
        if (lt && lt !== 'none') deco.push('line-through');
        if (deco.length) css.push(`text-decoration:${deco.join(' ')}`);
        const color = tp.getAttributeNS(NS.fo, 'color');
        if (color && color !== '#000000') css.push(`color:${color}`);
        const bg = tp.getAttributeNS(NS.fo, 'background-color');
        if (bg && bg !== 'transparent') css.push(`background-color:${bg}`);
        const size = tp.getAttributeNS(NS.fo, 'font-size');
        if (size && size.endsWith('pt')) css.push(`font-size:${size}`);
      }
      if (pp) {
        const al = pp.getAttributeNS(NS.fo, 'text-align');
        const a = { center: 'center', end: 'right', right: 'right', justify: 'justify' }[al];
        if (a) css.push(`text-align:${a}`);
      }
      map[name] = { css: css.join(';'), parent: s.getAttributeNS(NS.style, 'parent-style-name') };
    }
    for (const l of doc.getElementsByTagNameNS(NS.text, 'list-style')) {
      const first = [...l.children][0];
      lists[l.getAttributeNS(NS.style, 'name')] = first?.localName === 'list-level-style-number' ? 'ol' : 'ul';
    }
  }
  return { map, lists };
}

function cssOf(styles, name) {
  const parts = [];
  for (let n = name, guard = 0; n && styles.map[n] && guard < 10; n = styles.map[n].parent, guard++) {
    if (styles.map[n].css) parts.unshift(styles.map[n].css);
  }
  return parts.join(';');
}

async function imageSrc(zip, href) {
  const f = href && zip?.file(href.replace(/^\.\//, ''));
  if (!f) return null;
  const ext = href.split('.').pop().toLowerCase();
  const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' }[ext];
  return mime ? `data:${mime};base64,${await f.async('base64')}` : null;
}

async function toHtml(node, ctx) {
  let out = '';
  for (const child of node.childNodes) {
    if (child.nodeType === 3) { out += escapeHtml(child.nodeValue); continue; }
    if (child.nodeType !== 1) continue;
    const name = child.localName;
    const style = cssOf(ctx.styles, child.getAttributeNS(NS.text, 'style-name') || child.getAttributeNS(NS.table, 'style-name'));
    const attr = style ? ` style="${escapeHtml(style)}"` : '';
    const inner = () => toHtml(child, ctx);
    switch (child.namespaceURI === NS.text || child.namespaceURI === NS.table || child.namespaceURI === NS.draw ? name : '') {
      case 'h': {
        const level = Math.min(Number(child.getAttributeNS(NS.text, 'outline-level')) || 1, 3);
        out += `<h${level}${attr}>${(await inner()) || '<br>'}</h${level}>`;
        break;
      }
      case 'p': out += `<p${attr}>${(await inner()) || '<br>'}</p>`; break;
      case 'span': out += attr ? `<span${attr}>${await inner()}</span>` : await inner(); break;
      case 'a': out += `<a href="${escapeHtml(child.getAttributeNS(NS.xlink, 'href') || '')}">${await inner()}</a>`; break;
      case 's': out += '&nbsp;'.repeat(Number(child.getAttributeNS(NS.text, 'c')) || 1); break;
      case 'tab': out += '&emsp;'; break;
      case 'line-break': out += '<br>'; break;
      case 'list': {
        const tag = ctx.styles.lists[child.getAttributeNS(NS.text, 'style-name')] || ctx.listTag || 'ul';
        out += `<${tag}>${await toHtml(child, { ...ctx, listTag: tag })}</${tag}>`;
        break;
      }
      case 'list-item': case 'list-header': out += `<li>${await inner()}</li>`; break;
      case 'table': out += `<table><tbody>${await inner()}</tbody></table>`; break;
      case 'table-header-rows': case 'table-rows': out += await inner(); break;
      case 'table-row': out += `<tr>${await inner()}</tr>`; break;
      case 'table-cell': {
        const span = child.getAttributeNS(NS.table, 'number-columns-spanned');
        out += `<td${span ? ` colspan="${span}"` : ''}>${await inner()}</td>`;
        break;
      }
      case 'frame': case 'text-box': case 'section': case 'g': out += await inner(); break;
      case 'image': {
        // Flat files embed the picture as base64 instead of linking to it.
        const inline = child.getElementsByTagNameNS(NS.office, 'binary-data')[0]?.textContent.replace(/\s+/g, '');
        const mime = inline?.startsWith('/9j/') ? 'image/jpeg' : 'image/png';
        const src = inline ? `data:${mime};base64,${inline}` : await imageSrc(ctx.zip, child.getAttributeNS(NS.xlink, 'href'));
        if (src) out += `<img src="${src}" alt="">`;
        break;
      }
      case 'note': case 'sequence-decls': case 'tracked-changes': case 'table-columns': case 'table-column': case 'soft-page-break': break;
      default: out += await inner();
    }
  }
  return out;
}

export async function odtToHtml(bytes) {
  const { zip, content, styles } = await load(bytes);
  if (!content) throw new Error('Could not read this OpenDocument file');
  const body = content.getElementsByTagNameNS(NS.office, 'text')[0];
  return toHtml(body, { zip, styles: readStyles(styles, content) });
}

// Flat OpenDocument text (.fodt): everything in one XML file.
export async function fodtToHtml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const body = doc.getElementsByTagNameNS(NS.office, 'text')[0];
  if (!body) throw new Error('Could not read this OpenDocument file');
  return toHtml(body, { zip: null, styles: readStyles(doc) });
}

// ---------- Presentations ----------
function toPx(len) {
  const m = /^(-?[\d.]+)(cm|mm|in|pt|px)?$/.exec(len || '');
  if (!m) return 0;
  const v = Number(m[1]);
  return v * ({ cm: 37.795, mm: 3.7795, in: 96, pt: 4 / 3, px: 1 }[m[2] || 'px']);
}

// .odp -> { width, height, slides: [{ bg, els: [{ type, x, y, w, h, html|src, title }] }] }
export async function odpToSlides(bytes) {
  const { zip, content, styles } = await load(bytes);
  if (!content) throw new Error('Could not read this OpenDocument file');
  const st = readStyles(styles, content);
  const layout = styles?.getElementsByTagNameNS(NS.style, 'page-layout-properties')[0];
  const width = toPx(layout?.getAttributeNS(NS.fo, 'page-width')) || 1066;
  const height = toPx(layout?.getAttributeNS(NS.fo, 'page-height')) || 600;
  const slides = [];
  for (const page of content.getElementsByTagNameNS(NS.draw, 'page')) {
    const els = [];
    for (const frame of page.children) {
      const box = {
        x: toPx(frame.getAttributeNS(NS.svg, 'x')), y: toPx(frame.getAttributeNS(NS.svg, 'y')),
        w: toPx(frame.getAttributeNS(NS.svg, 'width')), h: toPx(frame.getAttributeNS(NS.svg, 'height')),
      };
      const image = frame.getElementsByTagNameNS(NS.draw, 'image')[0];
      const textBox = frame.getElementsByTagNameNS(NS.draw, 'text-box')[0] || (frame.localName === 'custom-shape' || frame.localName === 'rect' ? frame : null);
      if (textBox && textBox.textContent.trim()) {
        const cls = frame.getAttributeNS(NS.presentation, 'class');
        els.push({ type: 'text', ...box, html: await toHtml(textBox, { zip, styles: st }), title: cls === 'title' });
      } else if (image) {
        const src = await imageSrc(zip, image.getAttributeNS(NS.xlink, 'href'));
        if (src) els.push({ type: 'image', ...box, src });
      }
    }
    slides.push({ els });
  }
  return { width, height, slides };
}
