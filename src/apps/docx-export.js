// Converts the editor's HTML into a real Word (.docx) file. It reads the
// live, styled DOM so whatever the user sees (bold, colors, sizes, lists,
// tables, images) is what ends up in Word.

import {
  Document, Packer, Paragraph, TextRun, ImageRun, ExternalHyperlink, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, LevelFormat, ShadingType, BorderStyle, PageBreak,
} from 'docx';

const BLOCK = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'UL', 'OL', 'LI', 'TABLE', 'HR', 'PRE', 'SECTION', 'ARTICLE', 'FIGURE', 'HEADER', 'FOOTER']);
const HEADINGS = { H1: HeadingLevel.HEADING_1, H2: HeadingLevel.HEADING_2, H3: HeadingLevel.HEADING_3, H4: HeadingLevel.HEADING_4, H5: HeadingLevel.HEADING_5, H6: HeadingLevel.HEADING_6 };
const DEFAULT_COLOR = '1D2125';

function toHex(rgb) {
  const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/);
  if (!m || (m[4] !== undefined && Number(m[4]) === 0)) return null;
  return [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('').toUpperCase();
}

function isBlank(nodes) {
  return nodes.every((n) => n.nodeType === 3 && !n.nodeValue.trim());
}

function imageRun(img) {
  if (!img.complete || !img.naturalWidth) return null;
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext('2d').drawImage(img, 0, 0);
  const b64 = canvas.toDataURL('image/png').split(',')[1];
  const bin = atob(b64);
  const data = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
  const maxW = 600;
  const w = Math.min(img.naturalWidth, maxW);
  const hgt = Math.round(img.naturalHeight * (w / img.naturalWidth));
  return new ImageRun({ type: 'png', data, transformation: { width: w, height: hgt } });
}

function decorations(node, stopAt) {
  let underline = false;
  let strike = false;
  let shading = null;
  for (let el = node; el && el !== stopAt.parentElement; el = el.parentElement) {
    const cs = getComputedStyle(el);
    const deco = cs.textDecorationLine || cs.textDecoration || '';
    if (deco.includes('underline')) underline = true;
    if (deco.includes('line-through')) strike = true;
    if (!shading && el.tagName !== 'TD' && el.tagName !== 'TH') shading = toHex(cs.backgroundColor);
    if (el === stopAt) break;
  }
  return { underline, strike, shading };
}

function runsOf(node, block, extra = {}) {
  if (node.nodeType === 3) {
    const pre = getComputedStyle(node.parentElement).whiteSpace.startsWith('pre');
    const text = pre ? node.nodeValue : node.nodeValue.replace(/\s+/g, ' ');
    if (!text) return [];
    const el = node.parentElement;
    const cs = getComputedStyle(el);
    const { underline, strike, shading } = decorations(el, block);
    const color = toHex(cs.color);
    const font = cs.fontFamily.split(',')[0].replace(/["']/g, '').trim();
    return [new TextRun({
      text,
      font: font && font !== 'Georgia' && !/^(serif|sans-serif|monospace|system-ui|-apple-system)$/.test(font) ? font : undefined,
      bold: Number(cs.fontWeight) >= 600 || cs.fontWeight === 'bold',
      italics: cs.fontStyle === 'italic',
      underline: underline ? {} : undefined,
      strike,
      color: color && color !== DEFAULT_COLOR ? color : undefined,
      size: Math.round(parseFloat(cs.fontSize) * 0.75 * 2),
      superScript: cs.verticalAlign === 'super',
      subScript: cs.verticalAlign === 'sub',
      shading: shading && shading !== 'FFFFFF' ? { type: ShadingType.CLEAR, color: 'auto', fill: shading } : undefined,
      ...extra,
    })];
  }
  if (node.nodeType !== 1) return [];
  if (node.tagName === 'BR') return [new TextRun({ text: '', break: 1 })];
  if (node.tagName === 'IMG') {
    const run = imageRun(node);
    return run ? [run] : [];
  }
  const children = [...node.childNodes].flatMap((child) => runsOf(child, block, extra));
  if (node.tagName === 'A' && node.getAttribute('href') && !node.getAttribute('href').startsWith('#')) {
    return [new ExternalHyperlink({ link: node.getAttribute('href'), children })];
  }
  return children;
}

function paragraphFrom(nodes, block, opts) {
  const cs = getComputedStyle(block);
  const align = { center: AlignmentType.CENTER, right: AlignmentType.RIGHT, end: AlignmentType.RIGHT, justify: AlignmentType.JUSTIFIED }[cs.textAlign];
  const marginLeft = parseFloat(cs.marginLeft) || 0;
  const options = {
    children: nodes.flatMap((n) => runsOf(n, block)),
    alignment: align,
    heading: opts.heading,
    spacing: { after: opts.list ? 60 : 120 },
  };
  // Line spacing set in the Format panel (1.25 = single ... 2.5 = double).
  const lh = parseFloat(block.style?.lineHeight);
  if (lh) options.spacing.line = Math.round(240 * (lh / 1.25));
  if (opts.list) {
    if (opts.list.ordered) options.numbering = { reference: 'numbered', level: opts.list.level, instance: opts.list.instance };
    else options.bullet = { level: opts.list.level };
  } else if (opts.quote || marginLeft > 4) {
    options.indent = { left: opts.quote ? 720 : Math.round(marginLeft * 15) };
  }
  return new Paragraph(options);
}

function blocksOf(container, ctx, opts = {}) {
  const out = [];
  let inline = [];
  const flush = () => {
    if (inline.length && !isBlank(inline)) out.push(paragraphFrom(inline, container, opts));
    inline = [];
  };
  for (const node of container.childNodes) {
    if (node.nodeType === 1 && BLOCK.has(node.tagName)) {
      flush();
      out.push(...blockFrom(node, ctx, opts));
    } else {
      inline.push(node);
    }
  }
  flush();
  return out;
}

function blockFrom(el, ctx, opts) {
  const tag = el.tagName;
  if (el.dataset?.pageBreak) return [new Paragraph({ children: [new PageBreak()] })];
  if (tag === 'UL' && el.classList.contains('checklist')) {
    return [...el.children].map((li) => new Paragraph({
      children: [new TextRun({ text: li.dataset.checked ? '☑ ' : '☐ ' }), ...[...li.childNodes].flatMap((n) => runsOf(n, li))],
      spacing: { after: 60 },
    }));
  }
  if (tag === 'UL' || tag === 'OL') {
    const level = opts.list ? Math.min(opts.list.level + 1, 8) : 0;
    const ordered = tag === 'OL';
    const instance = ordered ? (level === 0 ? ++ctx.lists : opts.list?.instance ?? ++ctx.lists) : 0;
    return [...el.children].flatMap((li) => {
      const list = { ordered, level, instance };
      const items = blocksOf(li, ctx, { ...opts, list });
      return items.length ? items : [paragraphFrom([], li, { list })];
    });
  }
  if (tag === 'TABLE') {
    const rows = [...el.querySelectorAll(':scope > tr, :scope > tbody > tr, :scope > thead > tr, :scope > tfoot > tr')];
    if (!rows.length) return [];
    const border = { style: BorderStyle.SINGLE, size: 4, color: 'B9C0C8' };
    return [new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
      rows: rows.map((tr) => new TableRow({
        children: [...tr.children].map((td) => {
          const content = blocksOf(td, ctx, {});
          const fill = toHex(getComputedStyle(td).backgroundColor);
          return new TableCell({
            children: content.length ? content : [new Paragraph('')],
            shading: fill && fill !== 'FFFFFF' ? { type: ShadingType.CLEAR, color: 'auto', fill } : undefined,
            columnSpan: Number(td.getAttribute('colspan')) || undefined,
          });
        }),
      })),
    }), new Paragraph('')];
  }
  if (tag === 'HR') {
    return [new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'B9C0C8', space: 1 } } })];
  }
  const next = { ...opts };
  if (HEADINGS[tag]) next.heading = HEADINGS[tag];
  if (tag === 'BLOCKQUOTE') next.quote = true;
  const hasBlocks = [...el.children].some((c) => BLOCK.has(c.tagName));
  if (hasBlocks) return blocksOf(el, ctx, next);
  return [paragraphFrom([...el.childNodes], el, next)];
}

export async function htmlToDocx(root) {
  const ctx = { lists: 0 };
  const children = blocksOf(root, ctx);
  const doc = new Document({
    creator: 'Plain Office',
    styles: { default: { document: { run: { font: 'Georgia', size: 24 } } } },
    numbering: {
      config: [{
        reference: 'numbered',
        levels: Array.from({ length: 9 }, (_, level) => ({
          level,
          format: [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN][level % 3],
          text: `%${level + 1}.`,
          alignment: AlignmentType.START,
          style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
        })),
      }],
    },
    sections: [{ children: children.length ? children : [new Paragraph('')] }],
  });
  return Packer.toBlob(doc);
}
