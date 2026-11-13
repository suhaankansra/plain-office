// Docs: a word processor that opens and saves Word (.docx) files.

import { h, icon, iconBtn, keepFocus, toast, busy, progressBox, actionSheet, askText, pickColor, customDialog, debounce, escapeHtml } from '../ui.js';
import { exportFile, pickFiles } from '../files.js';
import { topBar, persist } from './shell.js';
import { canMakePages } from '../platform.js';
import { formatPanel, group, row, segmented, toggles, stepper, swatches, switchRow, actions, choices, chips, FONTS, fontLabel } from './panel.js';

export function create() {
  return '<p><br></p>';
}

// Strip anything that could run code. CSP blocks scripts anyway; this is a
// second line of defence for files from untrusted sources.
export function sanitize(html) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  doc.querySelectorAll('script, style, iframe, object, embed, link, meta, form, input, button, textarea, select, svg, math').forEach((n) => n.remove());
  for (const el of doc.body.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim().toLowerCase();
      if (name.startsWith('on') || ((name === 'href' || name === 'src') && /^(javascript|vbscript|data:text)/.test(value))) {
        el.removeAttribute(attr.name);
      }
    }
  }
  return doc.body.innerHTML;
}

function textToHtml(text) {
  return text.split(/\r?\n/).map((line) => `<p>${escapeHtml(line) || '<br>'}</p>`).join('');
}

export function markdownToHtml(text) {
  const inline = (s) => escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/\*(.+?)\*/g, '<i>$1</i>')
    .replace(/`(.+?)`/g, '<code>$1</code>');
  const out = [];
  let list = null;
  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^(#{1,3})\s+(.*)/);
    const bullet = line.match(/^\s*[-*+]\s+(.*)/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)/);
    const want = bullet ? 'ul' : numbered ? 'ol' : null;
    if (list && list !== want) { out.push(`</${list}>`); list = null; }
    if (want && !list) { out.push(`<${want}>`); list = want; }
    if (heading) out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
    else if (want) out.push(`<li>${inline((bullet || numbered)[1])}</li>`);
    else out.push(`<p>${inline(line) || '<br>'}</p>`);
  }
  if (list) out.push(`</${list}>`);
  return out.join('');
}

// Every format the Docs editor can open. Plain-text-like files fall through to the end.
export async function importFile(bytes, name) {
  const ext = name.split('.').pop().toLowerCase();
  if (['docx', 'docm', 'dotx', 'dotm'].includes(ext)) {
    const mammoth = (await import('mammoth')).default;
    const result = await mammoth.convertToHtml(
      { arrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) },
      { styleMap: ['u => u', 'strike => s'] },
    );
    return sanitize(result.value) || create();
  }
  if (ext === 'doc' || ext === 'dot') return sanitize((await import('./formats/legacy.js')).docToHtml(bytes));
  if (ext === 'pages') return sanitize(await (await import('./formats/iwork.js')).pagesToHtml(bytes));
  if (ext === 'odt' || ext === 'ott') return sanitize(await (await import('./formats/odf.js')).odtToHtml(bytes)) || create();
  if (ext === 'epub') return sanitize(await (await import('./formats/epub.js')).epubToHtml(bytes));
  if (ext === 'rtf') return (await import('./formats/rtf.js')).rtfToHtml(new TextDecoder('latin1').decode(bytes)) || create();
  if (ext === 'eml' || ext === 'mht' || ext === 'mhtml') {
    return sanitize((await import('./formats/mail.js')).mimeToHtml(bytes, { asEmail: ext === 'eml' })) || create();
  }
  if (ext === 'msg') return sanitize(await (await import('./formats/mail.js')).msgToHtml(bytes));
  if (['mobi', 'azw', 'azw3', 'prc', 'pdb'].includes(ext)) return sanitize((await import('./formats/ebook.js')).mobiToHtml(bytes));
  if (ext === 'xps' || ext === 'oxps') return sanitize(await (await import('./formats/misc.js')).xpsToHtml(bytes));
  if (ext === 'zabw') return importFile(new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()), 'file.abw');
  const text = decodeText(bytes);
  if (ext === 'fb2' || (ext === 'xml' && /<FictionBook[\s>]/.test(text.slice(0, 2000)))) return sanitize((await import('./formats/ebook.js')).fb2ToHtml(text));
  if (ext === 'fodt') return sanitize(await (await import('./formats/odf.js')).fodtToHtml(text)) || create();
  if (ext === 'abw') return sanitize((await import('./formats/misc.js')).abwToHtml(text)) || create();
  if (ext === 'ipynb') return sanitize((await import('./formats/misc.js')).ipynbToHtml(text, markdownToHtml));
  if (ext === 'html' || ext === 'htm' || ext === 'xhtml') return sanitize(text);
  if (ext === 'md' || ext === 'markdown') return markdownToHtml(text);
  return textToHtml(text);
}

// UTF-8 when valid (with or without BOM), UTF-16 with a BOM, else Windows-1252.
export function decodeText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

function htmlToMarkdown(root) {
  const inline = (node) => [...node.childNodes].map((n) => {
    if (n.nodeType === 3) return n.nodeValue.replace(/\s+/g, ' ');
    if (n.nodeType !== 1) return '';
    const inner = inline(n);
    const cs = getComputedStyle(n);
    if (n.tagName === 'BR') return '  \n';
    if (n.tagName === 'A') return `[${inner}](${n.getAttribute('href')})`;
    if (n.tagName === 'IMG') return '';
    if (Number(cs.fontWeight) >= 600 && inner.trim()) return `**${inner}**`;
    if (cs.fontStyle === 'italic' && inner.trim()) return `*${inner}*`;
    return inner;
  }).join('');
  const block = (node, depth = 0) => [...node.children].map((el) => {
    const t = el.tagName;
    if (/^H[1-6]$/.test(t)) return `${'#'.repeat(Number(t[1]))} ${el.textContent.trim()}`;
    if (t === 'UL' || t === 'OL') {
      const check = el.classList.contains('checklist');
      return [...el.children].map((li, i) => `${'  '.repeat(depth)}${t === 'OL' ? `${i + 1}.` : '-'} ${check ? (li.dataset.checked ? '[x] ' : '[ ] ') : ''}${inline(li).trim()}`).join('\n');
    }
    if (t === 'BLOCKQUOTE') return `> ${inline(el).trim()}`;
    if (t === 'HR') return '---';
    if (t === 'TABLE') {
      const rows = [...el.querySelectorAll('tr')].map((tr) => `| ${[...tr.children].map((c) => c.textContent.trim()).join(' | ')} |`);
      if (rows.length) rows.splice(1, 0, `|${' --- |'.repeat(el.querySelector('tr').children.length)}`);
      return rows.join('\n');
    }
    return inline(el).trim();
  }).filter((x) => x !== '').join('\n\n');
  return `${block(root)}\n`;
}

async function shrinkImage(file, maxSide = 1400) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}
export { shrinkImage };

export async function open(doc, root, onExit) {
  const readOnly = !!doc.readOnly;
  const page = h('div', {
    class: 'doc-page',
    contenteditable: readOnly ? 'false' : 'true',
    spellcheck: 'true',
    'data-placeholder': 'Start typing…',
    html: doc.data,
  });
  const scroller = h('div', { class: 'doc-scroll' }, page);

  const save = debounce(async () => {
    doc.data = page.innerHTML;
    await persist(doc);
  }, 700);
  page.addEventListener('input', () => { save(); updateCount(); });

  // Paste: keep formatting but strip anything unsafe.
  page.addEventListener('paste', (e) => {
    const html = e.clipboardData?.getData('text/html');
    if (!html) return;
    e.preventDefault();
    document.execCommand('insertHTML', false, sanitize(html));
  });

  // Remember the selection so toolbar popups can restore it.
  let savedRange = null;
  let styleLabel = null;
  document.addEventListener('selectionchange', onSelection);
  function onSelection() {
    const sel = document.getSelection();
    if (sel.rangeCount && page.contains(sel.anchorNode)) savedRange = sel.getRangeAt(0).cloneRange();
    refreshState();
  }
  function restore() {
    page.focus({ preventScroll: true });
    if (savedRange) {
      const sel = document.getSelection();
      sel.removeAllRanges();
      sel.addRange(savedRange);
    }
  }
  function cmd(name, value = null) {
    restore();
    document.execCommand('styleWithCSS', false, ['hiliteColor', 'foreColor', 'fontSize', 'fontName'].includes(name));
    document.execCommand(name, false, value);
    save();
    refreshState();
  }

  const stateButtons = [];
  function stateBtn(iconName, label, command) {
    const btn = keepFocus(iconBtn(iconName, label, () => cmd(command)));
    stateButtons.push([btn, command]);
    return btn;
  }
  const queryState = (command) => { try { return document.queryCommandState(command); } catch { return false; } };
  function refreshState() {
    for (const [btn, command] of stateButtons) btn.classList.toggle('on', queryState(command));
    if (styleLabel) styleLabel.textContent = STYLES.find((s) => s.tag === blockTag())?.label || 'Body';
    if (panel?.isOpen) refreshPanelSoon();
  }

  // ---- Where the cursor is ----
  const BLOCKS = 'p,h1,h2,h3,h4,h5,h6,blockquote,pre,li,div';
  function caretEl() {
    let n = savedRange?.startContainer;
    if (!n || !page.contains(n)) return page.firstElementChild || page;
    if (n.nodeType === 3) n = n.parentElement;
    if (n === page) n = page.children[Math.min(savedRange.startOffset, page.children.length - 1)] || page;
    return n;
  }
  function currentBlock() {
    const el = caretEl().closest(BLOCKS);
    return el && page.contains(el) && el !== page ? el : null;
  }
  function blockTag() {
    let el = caretEl();
    while (el && el !== page && el.parentElement !== page) el = el.parentElement;
    return el && el !== page ? el.tagName : 'P';
  }
  // Every block the selection touches (for line spacing).
  function selectedBlocks() {
    const blocks = [...page.querySelectorAll('p,h1,h2,h3,h4,blockquote,pre,li')].filter((b) => savedRange && savedRange.intersectsNode(b) && !b.querySelector('p,li'));
    const cur = currentBlock();
    return blocks.length ? blocks : cur ? [cur] : [];
  }
  const caretStyle = () => getComputedStyle(caretEl());
  const currentTable = () => caretEl().closest('table');

  // ---- Paragraph styles (like Pages) ----
  const STYLES = [
    { tag: 'H1', label: 'Title', preview: { fontSize: '26px', fontWeight: 700 } },
    { tag: 'H2', label: 'Heading', preview: { fontSize: '21px', fontWeight: 700 } },
    { tag: 'H3', label: 'Subheading', preview: { fontSize: '18px', fontWeight: 700 } },
    { tag: 'H4', label: 'Small heading', preview: { fontSize: '14px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' } },
    { tag: 'P', label: 'Body', preview: { fontSize: '16px', fontFamily: 'Georgia, serif' } },
    { tag: 'BLOCKQUOTE', label: 'Quote', preview: { fontSize: '16px', fontStyle: 'italic', borderLeft: '3px solid #c8ced6', paddingLeft: '10px' } },
    { tag: 'PRE', label: 'Code', preview: { fontSize: '14px', fontFamily: '"Courier New", monospace' } },
  ];

  async function styleMenu() {
    const value = await actionSheet('Paragraph style', STYLES.map((s) => ({ label: h('span', { style: s.preview }, s.label), value: s.tag })));
    if (value) cmd('formatBlock', value);
    else restore();
  }

  // Exact text sizes: mark the selection with size 7, then swap those for real sizes.
  function setFontSize(pt) {
    restore();
    const sel = document.getSelection();
    if (sel.isCollapsed) {
      const block = currentBlock();
      if (!block) return;
      const range = document.createRange();
      range.selectNodeContents(block);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    document.execCommand('styleWithCSS', false, false);
    document.execCommand('fontSize', false, '7');
    const marked = [...page.querySelectorAll('font[size="7"]')];
    const spans = marked.map((font) => {
      const span = document.createElement('span');
      span.style.fontSize = `${Math.round(pt * 4 / 3 * 10) / 10}px`;
      span.append(...font.childNodes);
      span.querySelectorAll('[style]').forEach((n) => n.style.removeProperty('font-size'));
      span.querySelectorAll('font[size]').forEach((n) => n.removeAttribute('size'));
      font.replaceWith(span);
      return span;
    });
    if (spans.length) {
      const range = document.createRange();
      range.setStartBefore(spans[0]);
      range.setEndAfter(spans[spans.length - 1]);
      sel.removeAllRanges();
      sel.addRange(range);
      savedRange = range.cloneRange();
    }
    save();
  }
  const currentPt = () => Math.round(parseFloat(caretStyle().fontSize) * 0.75);

  // Line spacing on every paragraph the selection touches.
  const SPACING = [{ value: 1, lh: '1.25' }, { value: 1.15, lh: '' }, { value: 1.5, lh: '1.95' }, { value: 2, lh: '2.5' }];
  function setSpacing(value) {
    const lh = SPACING.find((s) => s.value === value)?.lh ?? '';
    for (const b of selectedBlocks()) b.style.lineHeight = lh;
    save();
  }
  function currentSpacing() {
    const b = currentBlock();
    const lh = b?.style.lineHeight;
    return SPACING.find((s) => s.lh === (lh || ''))?.value ?? 1.15;
  }

  function currentList() {
    const list = caretEl().closest('ul,ol');
    if (!list || !page.contains(list)) return 'none';
    if (list.classList.contains('checklist')) return 'check';
    return list.tagName === 'OL' ? 'number' : 'bullet';
  }
  function setList(kind) {
    const now = currentList();
    if (kind === now) return;
    restore();
    if (now === 'number') document.execCommand('insertOrderedList');
    if ((now === 'bullet' || now === 'check') && kind !== 'bullet' && kind !== 'check') document.execCommand('insertUnorderedList');
    if (kind === 'number') document.execCommand('insertOrderedList');
    if ((kind === 'bullet' || kind === 'check') && now !== 'bullet' && now !== 'check') document.execCommand('insertUnorderedList');
    const list = caretEl().closest('ul');
    if (list) list.classList.toggle('checklist', kind === 'check');
    save();
    refreshState();
  }

  // ---- Tables ----
  function tableCommand(action) {
    const td = caretEl().closest('td,th');
    const table = currentTable();
    if (!td || !table) return;
    const tr = td.parentElement;
    const col = [...tr.children].indexOf(td);
    const rows = [...table.rows];
    const blank = (tag = 'td') => { const c = document.createElement(tag); c.innerHTML = '<br>'; return c; };
    if (action === 'rowAbove' || action === 'rowBelow') {
      const row = document.createElement('tr');
      for (let i = 0; i < tr.children.length; i++) row.append(blank());
      tr.parentElement.insertBefore(row, action === 'rowAbove' ? tr : tr.nextSibling);
    } else if (action === 'colLeft' || action === 'colRight') {
      for (const r of rows) {
        const ref = r.children[col];
        const cell = blank(ref?.tagName === 'TH' ? 'th' : 'td');
        if (!ref) r.append(cell);
        else r.insertBefore(cell, action === 'colLeft' ? ref : ref.nextSibling);
      }
    } else if (action === 'delRow') {
      if (rows.length === 1) table.remove(); else tr.remove();
    } else if (action === 'delCol') {
      if (tr.children.length === 1) table.remove(); else rows.forEach((r) => r.children[col]?.remove());
    } else if (action === 'delTable') {
      table.remove();
    }
    save();
    refreshPanelSoon();
  }

  // ---- Format panel ----
  const swatchColor = (rgb) => {
    const m = String(rgb).match(/\d+/g);
    if (!m || (m.length > 3 && Number(m[3]) === 0)) return null;
    return `#${m.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
  };
  const panel = formatPanel({
    title: 'Format',
    onClose: () => {
      page.removeAttribute('inputmode');
      toolbar.hidden = false;
      brushBtn.classList.remove('on');
    },
    tabs: () => [
      { key: 'style', label: 'Style', render: () => [
        group(null, choices(STYLES.map((s) => ({ value: s.tag, label: h('span', { style: s.preview }, s.label) })), blockTag(), (tag) => cmd('formatBlock', tag))),
      ] },
      { key: 'text', label: 'Text', render: () => {
        const cs = caretStyle();
        const fontNow = fontLabel(cs.fontFamily) || 'Georgia';
        return [
          group(null, toggles([
            { icon: 'bold', title: 'Bold', on: queryState('bold'), onClick: () => cmd('bold') },
            { icon: 'italic', title: 'Italic', on: queryState('italic'), onClick: () => cmd('italic') },
            { icon: 'underline', title: 'Underline', on: queryState('underline'), onClick: () => cmd('underline') },
            { icon: 'strike', title: 'Strikethrough', on: queryState('strikeThrough'), onClick: () => cmd('strikeThrough') },
          ])),
          group('Font', chips(FONTS.map((f) => ({ value: f.label, label: f.label, style: { fontFamily: f.css } })), fontNow,
            (label) => cmd('fontName', FONTS.find((f) => f.label === label).css))),
          group(null, row('Size', stepper(currentPt(), { min: 6, max: 96, format: (v) => `${v} pt` }, setFontSize))),
          group('Colour', swatches(swatchColor(cs.color), (c) => cmd('foreColor', c === 'none' ? '#1d2125' : c))),
          group('Highlight', swatches(swatchColor(cs.backgroundColor), (c) => cmd('hiliteColor', c === 'none' ? 'transparent' : c), { allowNone: true })),
          group(null,
            toggles([
              { icon: 'superscript', title: 'Superscript', on: queryState('superscript'), onClick: () => cmd('superscript') },
              { icon: 'subscript', title: 'Subscript', on: queryState('subscript'), onClick: () => cmd('subscript') },
              { icon: 'clear', title: 'Clear formatting', on: false, onClick: () => { cmd('removeFormat'); refreshPanelSoon(); } },
            ])),
        ];
      } },
      { key: 'layout', label: 'Layout', render: () => [
        group('Alignment', segmented([
          { value: 'left', icon: 'alignLeft', title: 'Left' },
          { value: 'center', icon: 'alignCenter', title: 'Center' },
          { value: 'right', icon: 'alignRight', title: 'Right' },
          { value: 'justify', icon: 'alignJustify', title: 'Justify' },
        ], ['center', 'right', 'justify'].find((a) => queryState(`justify${a === 'justify' ? 'Full' : a[0].toUpperCase() + a.slice(1)}`)) || 'left',
        (a) => cmd(a === 'justify' ? 'justifyFull' : `justify${a[0].toUpperCase()}${a.slice(1)}`), { wide: true })),
        group('Line spacing', segmented(SPACING.map((s) => ({ value: s.value, label: s.value.toFixed(s.value === 1.15 ? 2 : 1) })), currentSpacing(), setSpacing, { wide: true })),
        group('Lists', segmented([
          { value: 'none', label: 'None' },
          { value: 'bullet', icon: 'listBullet', title: 'Bullets' },
          { value: 'number', icon: 'listNumber', title: 'Numbers' },
          { value: 'check', icon: 'checklist', title: 'Checklist' },
        ], currentList(), setList, { wide: true })),
        group('Indent', actions([
          { icon: 'outdent', label: 'Decrease', onClick: () => cmd('outdent') },
          { icon: 'indent', label: 'Increase', onClick: () => cmd('indent') },
        ], 2)),
      ] },
      currentTable() && { key: 'table', label: 'Table', render: () => {
        const table = currentTable();
        return [
          group(null, actions([
            { icon: 'rowPlus', label: 'Row above', onClick: () => tableCommand('rowAbove') },
            { icon: 'rowPlus', label: 'Row below', onClick: () => tableCommand('rowBelow') },
            { icon: 'trash', label: 'Delete row', danger: true, onClick: () => tableCommand('delRow') },
            { icon: 'colPlus', label: 'Column left', onClick: () => tableCommand('colLeft') },
            { icon: 'colPlus', label: 'Column right', onClick: () => tableCommand('colRight') },
            { icon: 'trash', label: 'Delete column', danger: true, onClick: () => tableCommand('delCol') },
          ], 3)),
          group(null, switchRow('Header row', table.classList.contains('t-header'), (on) => { table.classList.toggle('t-header', on); save(); })),
          group('Table style', segmented([
            { value: 'grid', label: 'Grid' },
            { value: 'striped', label: 'Striped' },
            { value: 'minimal', label: 'Minimal' },
          ], table.dataset.style || 'grid', (v) => { if (v === 'grid') delete table.dataset.style; else table.dataset.style = v; save(); }, { wide: true })),
          group(null, actions([{ icon: 'trash', label: 'Delete table', danger: true, onClick: () => { tableCommand('delTable'); } }], 1)),
        ];
      } },
    ],
  });
  const refreshPanelSoon = debounce(() => panel.refresh(), 120);

  // Open the panel without the keyboard covering it, keeping the selection.
  function openFormat(tab) {
    if (panel.isOpen && !tab) { panel.close(); return; }
    page.setAttribute('inputmode', 'none');
    if (document.activeElement === page) { page.blur(); restore(); }
    toolbar.hidden = true;
    brushBtn.classList.add('on');
    panel.show(root, tab);
  }

  async function colorMenu(kind) {
    const color = await pickColor(kind === 'text' ? 'Text color' : 'Highlight', { allowNone: kind !== 'text' });
    if (!color) return restore();
    if (kind === 'text') cmd('foreColor', color);
    else cmd('hiliteColor', color === 'none' ? 'transparent' : color);
  }

  // Tick boxes in checklists.
  page.addEventListener('click', (e) => {
    const li = e.target.closest('ul.checklist > li');
    if (!li || readOnly) return;
    if (e.clientX - li.getBoundingClientRect().left > 28) return;
    if (li.dataset.checked) delete li.dataset.checked; else li.dataset.checked = '1';
    save();
  });

  async function insertImage() {
    const [file] = await pickFiles('image/*');
    if (!file) return;
    const src = await shrinkImage(file);
    cmd('insertHTML', `<img src="${src}" alt="">`);
  }

  // OCR: type out the text in a photo (a page, a sign, a receipt...).
  async function insertTextFromPhoto() {
    const choice = await actionSheet('Text from a photo', [
      { icon: 'image', label: 'Take a photo', value: 'camera' },
      { icon: 'folder', label: 'Choose a photo', value: 'library' },
    ]);
    if (!choice) return restore();
    const [file] = await pickFiles('image/*', false, choice === 'camera' ? 'environment' : null);
    if (!file) return restore();
    const box = progressBox('Reading text…');
    try {
      const { recognize } = await import('../ocr.js');
      const r = await recognize(await shrinkImage(file, 2400), (v) => box.update(`Reading text… ${Math.round(v * 100)}%`));
      box.close();
      if (!r.paragraphs.length) return toast('No text found in that photo');
      cmd('insertHTML', r.paragraphs.map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join(''));
    } catch (err) {
      box.close();
      toast(`Could not read the text: ${err.message || err}`);
    }
  }

  async function insertTable() {
    const size = await customDialog('Insert table', (box, close) => {
      const rows = h('input', { class: 'field', type: 'number', min: 1, max: 50, value: 3, inputmode: 'numeric' });
      const cols = h('input', { class: 'field', type: 'number', min: 1, max: 10, value: 3, inputmode: 'numeric' });
      box.append(
        h('div', { style: { display: 'flex', gap: '10px' } },
          h('label', { style: { flex: 1 } }, 'Rows', rows),
          h('label', { style: { flex: 1 } }, 'Columns', cols)),
        h('div', { class: 'row' },
          h('button', { class: 'btn', onClick: () => close(null) }, 'Cancel'),
          h('button', { class: 'btn primary', onClick: () => close([+rows.value, +cols.value]) }, 'Insert')));
    });
    if (!size) return restore();
    const [r, c] = size.map((n) => Math.max(1, Math.min(n || 1, 50)));
    const row = `<tr>${'<td><br></td>'.repeat(c)}</tr>`;
    cmd('insertHTML', `<table><tbody>${row.repeat(r)}</tbody></table><p><br></p>`);
  }

  async function insertLink() {
    const url = await askText('Link address', { placeholder: 'https://example.com', ok: 'Add link' });
    if (!url) return restore();
    const href = /^[a-z]+:/i.test(url) ? url : `https://${url}`;
    if (savedRange && !savedRange.collapsed) cmd('createLink', href);
    else cmd('insertHTML', `<a href="${escapeHtml(href)}">${escapeHtml(url)}</a>`);
  }

  async function insertMenu() {
    const value = await actionSheet('Insert', [
      { icon: 'table', label: 'Table', value: 'table' },
      { icon: 'image', label: 'Picture', value: 'image' },
      { icon: 'scan', label: 'Text from a photo', value: 'ocr' },
      { icon: 'checklist', label: 'Checklist', value: 'check' },
      { icon: 'link', label: 'Link', value: 'link' },
      { icon: 'toc', label: 'Table of contents', hint: 'from your headings', value: 'toc' },
      { icon: 'pageBreak', label: 'Page break', value: 'break' },
      { icon: 'wordcount', label: 'Divider line', value: 'hr' },
      { icon: 'calendar', label: "Today's date", value: 'date' },
    ]);
    if (value === 'image') insertImage();
    else if (value === 'ocr') insertTextFromPhoto();
    else if (value === 'table') insertTable();
    else if (value === 'link') insertLink();
    else if (value === 'check') cmd('insertHTML', '<ul class="checklist"><li><br></li></ul>');
    else if (value === 'toc') insertContents();
    else if (value === 'break') cmd('insertHTML', '<p data-page-break="1"><br></p><p><br></p>');
    else if (value === 'hr') cmd('insertHorizontalRule');
    else if (value === 'date') cmd('insertText', new Date().toLocaleDateString(undefined, { dateStyle: 'long' }));
    else restore();
  }

  // A contents list made from the Title / Heading / Subheading paragraphs.
  function insertContents() {
    const heads = [...page.querySelectorAll('h1,h2,h3')].filter((el) => el.textContent.trim() && !el.closest('.toc'));
    if (!heads.length) { restore(); return toast('Add some headings first (Format → Style)'); }
    const items = heads.map((el) => `<li class="toc-${el.tagName[1]}">${escapeHtml(el.textContent.trim())}</li>`).join('');
    cmd('insertHTML', `<h3 class="toc-title">Contents</h3><ul class="toc">${items}</ul><p><br></p>`);
  }

  // ---- Find & replace ----
  let findBar = null;
  function toggleFind() {
    if (findBar) { findBar.remove(); findBar = null; return; }
    const find = h('input', { class: 'field', placeholder: 'Find', enterkeyhint: 'search' });
    const repl = h('input', { class: 'field', placeholder: 'Replace with' });
    const status = h('span', { style: { fontSize: '13px', color: 'var(--muted)', minWidth: '40px' } });
    let index = -1;
    const matches = () => {
      const q = find.value;
      const out = [];
      if (!q) return out;
      const walker = document.createTreeWalker(page, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = n.nodeValue.toLowerCase();
        let at = text.indexOf(q.toLowerCase());
        while (at >= 0) { out.push([n, at]); at = text.indexOf(q.toLowerCase(), at + q.length); }
      }
      return out;
    };
    const select = ([node, at]) => {
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + find.value.length);
      const sel = document.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      node.parentElement.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return range;
    };
    const next = () => {
      const all = matches();
      status.textContent = all.length ? '' : '0 found';
      if (!all.length) return null;
      index = (index + 1) % all.length;
      status.textContent = `${index + 1}/${all.length}`;
      return select(all[index]);
    };
    const replaceOne = () => {
      const all = matches();
      if (!all.length) return;
      index = Math.max(0, Math.min(index, all.length - 1));
      const range = select(all[index]);
      range.deleteContents();
      range.insertNode(document.createTextNode(repl.value));
      index--;
      save();
      next();
    };
    const replaceAll = () => {
      const all = matches();
      for (const [node, at] of all.reverse()) {
        node.nodeValue = node.nodeValue.slice(0, at) + repl.value + node.nodeValue.slice(at + find.value.length);
      }
      save();
      toast(`Replaced ${all.length}`);
      status.textContent = '';
    };
    find.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); next(); } });
    findBar = h('div', { style: { background: 'var(--surface)', borderBottom: '1px solid var(--line)' } },
      h('div', { class: 'findbar' }, find, status, iconBtn('down', 'Next match', next), iconBtn('x', 'Close find', toggleFind)),
      readOnly ? null : h('div', { class: 'findbar', style: { paddingTop: 0, border: 0 } }, repl,
        h('button', { class: 'btn', onClick: replaceOne }, 'Replace'),
        h('button', { class: 'btn', onClick: replaceAll }, 'All')));
    bar.after(findBar);
    find.focus();
  }

  // ---- Export ----
  async function exportMenu() {
    save.flush();
    const value = await actionSheet('Save a copy / share', [
      { badge: 'doc', label: 'Word document', hint: '.docx', value: 'docx' },
      { badge: 'pdf', label: 'PDF', hint: '.pdf', value: 'pdf' },
      canMakePages ? { icon: 'file', label: 'Pages document', hint: '.pages', value: 'pages' } : null,
      { icon: 'file', label: 'Rich text', hint: '.rtf', value: 'rtf' },
      { icon: 'file', label: 'Plain text', hint: '.txt', value: 'txt' },
      { icon: 'file', label: 'Markdown', hint: '.md', value: 'md' },
      { icon: 'file', label: 'Web page', hint: '.html', value: 'html' },
    ]);
    if (!value) return;
    try {
      await busy('Preparing file…', async () => {
        if (value === 'docx') {
          const { htmlToDocx } = await import('./docx-export.js');
          await exportFile(await htmlToDocx(page), `${doc.name}.docx`);
        } else if (value === 'pdf') {
          const { documentToPdf } = await import('./render-pdf.js');
          await exportFile(await documentToPdf(page), `${doc.name}.pdf`);
        } else if (value === 'pages') {
          const { htmlToPagesBlob } = await import('./convert.js');
          await exportFile(await htmlToPagesBlob(page.innerHTML), `${doc.name}.pages`);
        } else if (value === 'rtf') {
          const { htmlToRtf } = await import('./formats/rtf.js');
          await exportFile(new Blob([htmlToRtf(page)], { type: 'application/rtf' }), `${doc.name}.rtf`);
        } else if (value === 'md') {
          await exportFile(new Blob([htmlToMarkdown(page)], { type: 'text/markdown' }), `${doc.name}.md`);
        } else if (value === 'txt') {
          await exportFile(new Blob([page.innerText], { type: 'text/plain' }), `${doc.name}.txt`);
        } else {
          const html = `<!doctype html><meta charset="utf-8"><title>${escapeHtml(doc.name)}</title><body style="font-family:Georgia,serif;max-width:760px;margin:40px auto;line-height:1.55">${page.innerHTML}</body>`;
          await exportFile(new Blob([html], { type: 'text/html' }), `${doc.name}.html`);
        }
      });
    } catch (err) {
      console.error(err);
      toast('Export failed: ' + (err.message || err));
    }
  }

  function updateCount() {
    const words = (page.innerText.match(/\S+/g) || []).length;
    bar.setSubtitle(`${words} word${words === 1 ? '' : 's'}`);
  }

  async function moreMenu() {
    const value = await actionSheet(null, [
      readOnly ? null : { icon: 'share', label: 'Save a copy / share', value: 'export' },
      { icon: 'search', label: readOnly ? 'Find' : 'Find & replace', value: 'find' },
      readOnly ? null : { icon: 'redo', label: 'Redo', value: 'redo' },
      { icon: 'info', label: 'Document info', hint: 'words, reading time', value: 'count' },
    ]);
    if (value === 'find') toggleFind();
    if (value === 'export') exportMenu();
    if (value === 'redo') cmd('redo');
    if (value === 'count') documentInfo();
  }

  function documentInfo() {
    const text = page.innerText;
    const words = (text.match(/\S+/g) || []).length;
    const stat = (label, value) => h('div', { class: 'fp-row' }, h('span', { class: 'fp-label' }, label), h('strong', {}, value));
    actionSheet('Document info', [{ node: h('div', { class: 'fp-card info-card' },
      stat('Words', words.toLocaleString()),
      stat('Characters', text.replace(/\s/g, '').length.toLocaleString()),
      stat('Paragraphs', [...page.querySelectorAll('p,li,h1,h2,h3,h4,blockquote,pre')].filter((p) => p.textContent.trim()).length.toLocaleString()),
      stat('Pages (about)', String(Math.max(1, Math.ceil(words / 500)))),
      stat('Reading time', `${Math.max(1, Math.round(words / 230))} min`)) }]);
  }

  async function close() {
    save.flush();
    document.removeEventListener('selectionchange', onSelection);
    onExit();
  }

  const brushBtn = keepFocus(iconBtn('brush', 'Format', () => openFormat()));
  const bar = topBar(doc, {
    onBack: close,
    buttons: readOnly ? [iconBtn('more', 'More', moreMenu)] : [
      keepFocus(iconBtn('undo', 'Undo', () => cmd('undo'))),
      brushBtn,
      keepFocus(iconBtn('plus', 'Insert', insertMenu)),
      iconBtn('more', 'More', moreMenu),
    ],
  });

  const textBtn = (label, title, onClick, inner) => keepFocus(h('button', { class: 'tb-text', title, 'aria-label': title, onClick }, inner || label));
  const sep = () => h('span', { class: 'sep' });
  // The bar above the keyboard: the everyday things; the rest is in Format.
  styleLabel = h('span', { class: 'style-name' }, 'Body');
  const toolbar = h('nav', { class: 'toolbar', 'aria-label': 'Formatting' },
    keepFocus(h('button', { class: 'tb-text tb-aa', title: 'Text format', 'aria-label': 'Text format', onClick: () => openFormat('text') }, 'Aa')),
    textBtn('Style', 'Paragraph style', styleMenu, [styleLabel, icon('down')]),
    sep(),
    stateBtn('bold', 'Bold', 'bold'),
    stateBtn('italic', 'Italic', 'italic'),
    stateBtn('underline', 'Underline', 'underline'),
    stateBtn('strike', 'Strikethrough', 'strikeThrough'),
    keepFocus(iconBtn('highlight', 'Highlight', () => colorMenu('highlight'))),
    sep(),
    keepFocus(iconBtn('alignLeft', 'Alignment and spacing', () => openFormat('layout'))),
    stateBtn('listBullet', 'Bulleted list', 'insertUnorderedList'),
    stateBtn('listNumber', 'Numbered list', 'insertOrderedList'),
    keepFocus(iconBtn('checklist', 'Checklist', () => setList(currentList() === 'check' ? 'none' : 'check'))),
    keepFocus(iconBtn('outdent', 'Decrease indent', () => cmd('outdent'))),
    keepFocus(iconBtn('indent', 'Increase indent', () => cmd('indent'))),
    sep(),
    keepFocus(iconBtn('table', 'Insert table', insertTable)),
    keepFocus(iconBtn('image', 'Insert picture', insertImage)),
  );

  if (readOnly) root.append(bar, scroller);
  else root.append(bar, scroller, toolbar);
  updateCount();
  if (!readOnly && page.innerText.trim() === '') page.focus();
  return close;
}
