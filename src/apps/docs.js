// Docs: a word processor that opens and saves Word (.docx) files.

import { h, icon, iconBtn, keepFocus, toast, busy, progressBox, actionSheet, askText, pickColor, customDialog, debounce, escapeHtml } from '../ui.js';
import { exportFile, pickFiles } from '../files.js';
import { topBar, persist } from './shell.js';

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
      return [...el.children].map((li, i) => `${'  '.repeat(depth)}${t === 'OL' ? `${i + 1}.` : '-'} ${inline(li).trim()}`).join('\n');
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
  const page = h('div', {
    class: 'doc-page',
    contenteditable: 'true',
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
    document.execCommand('styleWithCSS', false, name === 'hiliteColor' || name === 'foreColor' || name === 'fontSize');
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
  function refreshState() {
    for (const [btn, command] of stateButtons) {
      let on = false;
      try { on = document.queryCommandState(command); } catch { /* unsupported */ }
      btn.classList.toggle('on', on);
    }
  }

  async function styleMenu() {
    const value = await actionSheet('Paragraph style', [
      { label: h('span', { style: { fontSize: '24px', fontWeight: 700 } }, 'Title'), value: 'H1' },
      { label: h('span', { style: { fontSize: '20px', fontWeight: 700 } }, 'Heading'), value: 'H2' },
      { label: h('span', { style: { fontSize: '17px', fontWeight: 700 } }, 'Subheading'), value: 'H3' },
      { label: 'Normal text', value: 'P' },
      { label: h('span', { style: { fontStyle: 'italic' } }, 'Quote'), value: 'BLOCKQUOTE' },
    ]);
    if (value) cmd('formatBlock', value);
  }

  async function sizeMenu() {
    const value = await actionSheet('Text size', [
      { label: h('span', { style: { fontSize: '12px' } }, 'Small'), value: '2' },
      { label: h('span', { style: { fontSize: '16px' } }, 'Normal'), value: '3' },
      { label: h('span', { style: { fontSize: '19px' } }, 'Large'), value: '4' },
      { label: h('span', { style: { fontSize: '24px' } }, 'Larger'), value: '5' },
      { label: h('span', { style: { fontSize: '30px' } }, 'Huge'), value: '6' },
    ]);
    if (value) cmd('fontSize', value);
  }

  async function colorMenu(kind) {
    const color = await pickColor(kind === 'text' ? 'Text color' : 'Highlight', { allowNone: kind !== 'text' });
    if (!color) return restore();
    if (kind === 'text') cmd('foreColor', color);
    else cmd('hiliteColor', color === 'none' ? 'transparent' : color);
  }

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
      { icon: 'image', label: 'Picture', value: 'image' },
      { icon: 'scan', label: 'Text from a photo', value: 'ocr' },
      { icon: 'table', label: 'Table', value: 'table' },
      { icon: 'link', label: 'Link', value: 'link' },
      { icon: 'wordcount', label: 'Divider line', value: 'hr' },
      { icon: 'edit', label: "Today's date", value: 'date' },
    ]);
    if (value === 'image') insertImage();
    else if (value === 'ocr') insertTextFromPhoto();
    else if (value === 'table') insertTable();
    else if (value === 'link') insertLink();
    else if (value === 'hr') cmd('insertHorizontalRule');
    else if (value === 'date') cmd('insertText', new Date().toLocaleDateString(undefined, { dateStyle: 'long' }));
    else restore();
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
      h('div', { class: 'findbar', style: { paddingTop: 0, border: 0 } }, repl,
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
      { icon: 'file', label: 'Pages document', hint: '.pages', value: 'pages' },
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
      { icon: 'search', label: 'Find & replace', value: 'find' },
      { icon: 'share', label: 'Save a copy / share', value: 'export' },
      { icon: 'info', label: 'Word count', value: 'count' },
    ]);
    if (value === 'find') toggleFind();
    if (value === 'export') exportMenu();
    if (value === 'count') {
      const text = page.innerText;
      toast(`${(text.match(/\S+/g) || []).length} words · ${text.replace(/\s/g, '').length} characters`);
    }
  }

  async function close() {
    save.flush();
    document.removeEventListener('selectionchange', onSelection);
    onExit();
  }

  const bar = topBar(doc, {
    onBack: close,
    buttons: [
      keepFocus(iconBtn('undo', 'Undo', () => cmd('undo'))),
      keepFocus(iconBtn('redo', 'Redo', () => cmd('redo'))),
      iconBtn('share', 'Save a copy / share', exportMenu),
      iconBtn('more', 'More', moreMenu),
    ],
  });

  const textBtn = (label, title, onClick, inner) => keepFocus(h('button', { class: 'tb-text', title, 'aria-label': title, onClick }, inner || label));
  const sep = () => h('span', { class: 'sep' });
  const toolbar = h('nav', { class: 'toolbar', 'aria-label': 'Formatting' },
    textBtn('Aa', 'Paragraph style', styleMenu, [h('span', {}, 'Aa'), icon('down')]),
    sep(),
    stateBtn('bold', 'Bold', 'bold'),
    stateBtn('italic', 'Italic', 'italic'),
    stateBtn('underline', 'Underline', 'underline'),
    stateBtn('strike', 'Strikethrough', 'strikeThrough'),
    sep(),
    textBtn('Size', 'Text size', sizeMenu, [h('span', { style: { fontSize: '13px' } }, 'A'), h('span', { style: { fontSize: '18px' } }, 'A')]),
    textBtn('Color', 'Text color', () => colorMenu('text'), h('span', { class: 'tb-stack' }, 'A', h('span', { class: 'color-dot', style: { background: '#d93a3a' } }))),
    keepFocus(iconBtn('highlight', 'Highlight', () => colorMenu('highlight'))),
    sep(),
    stateBtn('alignLeft', 'Align left', 'justifyLeft'),
    stateBtn('alignCenter', 'Center', 'justifyCenter'),
    stateBtn('alignRight', 'Align right', 'justifyRight'),
    stateBtn('alignJustify', 'Justify', 'justifyFull'),
    sep(),
    stateBtn('listBullet', 'Bulleted list', 'insertUnorderedList'),
    stateBtn('listNumber', 'Numbered list', 'insertOrderedList'),
    keepFocus(iconBtn('outdent', 'Decrease indent', () => cmd('outdent'))),
    keepFocus(iconBtn('indent', 'Increase indent', () => cmd('indent'))),
    sep(),
    textBtn('Insert', 'Insert', insertMenu, [icon('plus'), 'Insert']),
    keepFocus(iconBtn('clear', 'Clear formatting', () => cmd('removeFormat'))),
  );

  root.append(bar, scroller, toolbar);
  updateCount();
  if (page.innerText.trim() === '') page.focus();
  return close;
}
