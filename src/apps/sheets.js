// Sheets: a spreadsheet that opens and saves Excel (.xlsx) and CSV files.

import * as XLSX from 'xlsx';
import { h, icon, iconBtn, toast, busy, actionSheet, askText, pickColor, confirmBox, debounce, escapeHtml } from '../ui.js';
import { exportFile } from '../files.js';
import { topBar, persist } from './shell.js';
import { evaluate, FormulaError, colName, parseRef, refName, shiftFormula, adjustFormula, FUNCTION_NAMES } from './formula.js';

const MIN_ROWS = 100;
const MIN_COLS = 26;
const DEFAULT_WIDTH = 96;

const blankSheet = (name) => ({ name, cells: {}, cols: {} });

export function create() {
  return { sheets: [blankSheet('Sheet1')], active: 0 };
}

// JSON that is a list of records, or an object holding one.
export function jsonRows(value) {
  const list = Array.isArray(value) ? value : Object.values(value || {}).find(Array.isArray);
  if (!Array.isArray(list) || !list.length || !list.every((r) => r && typeof r === 'object' && !Array.isArray(r))) return null;
  return list.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v !== null && typeof v === 'object' ? JSON.stringify(v) : v])));
}

const TEXT_SHEETS = new Set(['csv', 'tsv', 'tab', 'txt', 'prn', 'dif', 'slk', 'sylk', 'eth', 'htm', 'html']);

// SheetJS reads Excel (xlsx, xlsm, xlsb, xls), Numbers, OpenDocument (ods, fods),
// Lotus (wk1-wk4, 123), Quattro Pro, dBASE, SYLK, DIF, CSV/TSV and HTML tables.
export async function importFile(bytes, name = '') {
  const ext = name.split('.').pop().toLowerCase();
  let wb;
  if (['vcf', 'vcard', 'ics', 'ical', 'ifb', 'json', 'xml'].includes(ext)) {
    const { decodeText } = await import('./docs.js');
    const text = decodeText(bytes);
    if (ext === 'json') {
      // A list of records, e.g. [{ "name": "Ana", "score": 42 }, ...]
      wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(jsonRows(JSON.parse(text))), 'Data');
    } else if (ext === 'xml') {
      wb = XLSX.read(text, { type: 'string', cellFormula: true, cellNF: true });
    } else {
      const misc = await import('./formats/misc.js');
      return ext === 'vcf' || ext === 'vcard' ? misc.vcfToSheet(text) : misc.icsToSheet(text);
    }
  } else if (TEXT_SHEETS.has(ext)) {
    const { decodeText } = await import('./docs.js');
    let text = decodeText(bytes);
    if (ext === 'tsv' || ext === 'tab') text = `sep=\t\n${text}`;
    wb = XLSX.read(text, { type: 'string', cellFormula: true, cellNF: true, raw: false });
  } else {
    wb = XLSX.read(bytes, { type: 'array', cellFormula: true, cellNF: true });
  }
  const sheets = wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    const sheet = blankSheet(name);
    if (!ws['!ref']) return sheet;
    const range = XLSX.utils.decode_range(ws['!ref']);
    for (let r = range.s.r; r <= Math.min(range.e.r, 9999); r++) {
      for (let c = range.s.c; c <= Math.min(range.e.c, 255); c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        if (!cell) continue;
        let v;
        if (cell.f) v = `=${cell.f}`;
        else if (cell.t === 'n' && cell.z && XLSX.SSF.is_date(cell.z)) v = cell.w ?? String(cell.v);
        else if (cell.t === 'b') v = cell.v ? 'TRUE' : 'FALSE';
        else if (cell.t === 'e') v = cell.w ?? '#ERROR!';
        else v = cell.v == null ? '' : String(cell.v);
        if (v === '') continue;
        const out = { v };
        if (cell.z && typeof cell.z === 'string') {
          if (/%/.test(cell.z)) out.nf = 'pct';
          else if (/[$€£¥₹]/.test(cell.z)) out.nf = `cur:${cell.z.match(/[$€£¥₹]/)[0]}`;
          else if (/0\.00/.test(cell.z)) out.nf = 'num2';
        }
        sheet.cells[refName(c, r)] = out;
      }
    }
    (ws['!cols'] || []).forEach((col, i) => {
      const px = col?.wpx || (col?.wch ? col.wch * 7 + 5 : 0);
      if (px) sheet.cols[i] = Math.max(40, Math.min(400, Math.round(px)));
    });
    return sheet;
  });
  return { sheets: sheets.length ? sheets : [blankSheet('Sheet1')], active: 0 };
}

// ---------- Values ----------
function literal(raw) {
  if (raw === '' || raw == null) return '';
  const trimmed = raw.trim();
  if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(trimmed)) return Number(trimmed);
  if (/^[-+]?\d+(\.\d+)?%$/.test(trimmed)) return Number(trimmed.slice(0, -1)) / 100;
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toUpperCase() === 'TRUE';
  return raw;
}

function computeSheet(sheet) {
  const values = new Map();
  const visiting = new Set();
  const get = (ref) => {
    if (values.has(ref)) return values.get(ref);
    const raw = sheet.cells[ref]?.v;
    if (!raw || raw[0] !== '=') {
      const v = literal(raw);
      values.set(ref, v);
      return v;
    }
    if (visiting.has(ref)) return new FormulaError('#CIRC!');
    visiting.add(ref);
    let v;
    try { v = evaluate(raw.slice(1), get); } catch (e) { v = e instanceof FormulaError ? e : new FormulaError('#ERROR!'); }
    visiting.delete(ref);
    values.set(ref, v);
    return v;
  };
  return get;
}

function display(value, nf) {
  if (value instanceof FormulaError) return value.code;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value !== 'number') return value ?? '';
  if (nf === 'num2') return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (nf === 'int') return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (nf === 'pct') return `${(value * 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
  if (nf?.startsWith('cur:')) {
    const sym = nf.slice(4);
    const text = Math.abs(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `${value < 0 ? '-' : ''}${sym}${text}`;
  }
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toPrecision(10)));
}

function usedBounds(sheet) {
  let maxR = -1;
  let maxC = -1;
  for (const ref of Object.keys(sheet.cells)) {
    const p = parseRef(ref);
    if (p && sheet.cells[ref].v !== '') { maxR = Math.max(maxR, p.r); maxC = Math.max(maxC, p.c); }
  }
  return { maxR, maxC };
}

// ---------- Export ----------
const XLSX_NF = { num2: '#,##0.00', int: '#,##0', pct: '0%' };

export function toWorkbook(data) {
  const wb = XLSX.utils.book_new();
  for (const sheet of data.sheets) {
    const get = computeSheet(sheet);
    const ws = {};
    const { maxR, maxC } = usedBounds(sheet);
    for (const [ref, cell] of Object.entries(sheet.cells)) {
      if (!cell.v) continue;
      const value = get(ref);
      const out = {};
      if (cell.v[0] === '=') out.f = cell.v.slice(1);
      if (value instanceof FormulaError) { out.t = 's'; out.v = value.code; }
      else if (typeof value === 'number') { out.t = 'n'; out.v = value; }
      else if (typeof value === 'boolean') { out.t = 'b'; out.v = value; }
      else { out.t = 's'; out.v = String(value); }
      if (cell.nf) out.z = cell.nf.startsWith('cur:') ? `"${cell.nf.slice(4)}"#,##0.00` : XLSX_NF[cell.nf];
      ws[ref] = out;
    }
    ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(maxR, 0), c: Math.max(maxC, 0) } });
    ws['!cols'] = Array.from({ length: maxC + 1 }, (_, i) => ({ wpx: sheet.cols[i] || DEFAULT_WIDTH }));
    XLSX.utils.book_append_sheet(wb, ws, sheet.name.slice(0, 31) || 'Sheet');
  }
  return wb;
}

function sheetToHtmlTable(sheet) {
  const get = computeSheet(sheet);
  const { maxR, maxC } = usedBounds(sheet);
  const rows = [];
  for (let r = 0; r <= maxR; r++) {
    const tds = [];
    for (let c = 0; c <= maxC; c++) {
      const cell = sheet.cells[refName(c, r)] || {};
      const value = get(refName(c, r));
      const style = [
        cell.b && 'font-weight:700', cell.i && 'font-style:italic', cell.c && `color:${cell.c}`, cell.bg && `background:${cell.bg}`,
        `text-align:${cell.al || (typeof value === 'number' ? 'right' : 'left')}`,
      ].filter(Boolean).join(';');
      tds.push(`<td style="${style}">${escapeHtml(display(value, cell.nf))}</td>`);
    }
    rows.push(`<tr>${tds.join('')}</tr>`);
  }
  const el = h('div', { html: `<table style="border-collapse:collapse;font:12px Arial,sans-serif">${rows.join('')}</table>` });
  el.querySelectorAll('td').forEach((td) => Object.assign(td.style, { border: '1px solid #c8ced6', padding: '3px 6px', whiteSpace: 'nowrap' }));
  return el;
}

// ---------- Editor ----------
export async function open(doc, root, onExit) {
  const data = doc.data;
  let sheet = data.sheets[data.active] || data.sheets[0];
  let getValue = computeSheet(sheet);
  let sel = { c: 0, r: 0, c2: 0, r2: 0 };
  let rangeMode = false;
  let clipboard = null;
  const undoStack = [];
  const redoStack = [];

  const save = debounce(() => persist(doc), 600);

  function snapshot() {
    undoStack.push(JSON.stringify(data));
    if (undoStack.length > 60) undoStack.shift();
    redoStack.length = 0;
  }
  function restoreSnapshot(json) {
    const restored = JSON.parse(json);
    data.sheets = restored.sheets;
    data.active = Math.min(restored.active, data.sheets.length - 1);
    sheet = data.sheets[data.active];
    buildGrid();
    renderTabs();
    save();
  }
  function undo() {
    if (!undoStack.length) return toast('Nothing to undo');
    redoStack.push(JSON.stringify(data));
    restoreSnapshot(undoStack.pop());
  }
  function redo() {
    if (!redoStack.length) return toast('Nothing to redo');
    undoStack.push(JSON.stringify(data));
    restoreSnapshot(redoStack.pop());
  }

  const selBox = () => ({
    c1: Math.min(sel.c, sel.c2), c2: Math.max(sel.c, sel.c2),
    r1: Math.min(sel.r, sel.r2), r2: Math.max(sel.r, sel.r2),
  });
  function* selectedRefs() {
    const b = selBox();
    for (let r = b.r1; r <= b.r2; r++) for (let c = b.c1; c <= b.c2; c++) yield refName(c, r);
  }

  // ---- Formula bar ----
  const refLabel = h('div', { class: 'ref' }, 'A1');
  const input = h('input', {
    'aria-label': 'Cell contents',
    placeholder: 'Type a value or =formula',
    autocapitalize: 'off',
    autocomplete: 'off',
    autocorrect: 'off',
    spellcheck: false,
    enterkeyhint: 'next',
  });
  const fxbar = h('div', { class: 'fxbar' }, refLabel, h('span', { class: 'fx' }, 'fx'), input,
    iconBtn('check', 'Done', () => { commit(); input.blur(); }));
  let editing = false;
  input.addEventListener('focus', () => { editing = true; });
  input.addEventListener('input', () => { editing = true; });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); move(0, 1); }
    else if (e.key === 'Tab') { e.preventDefault(); commit(); move(1, 0); }
    else if (e.key === 'Escape') { input.value = sheet.cells[refName(sel.c, sel.r)]?.v || ''; editing = false; input.blur(); }
  });
  input.addEventListener('blur', () => setTimeout(() => { if (editing && document.activeElement !== input) commit(); }, 0));

  function commit() {
    if (!editing) return;
    editing = false;
    const ref = refName(sel.c, sel.r);
    let value = input.value;
    if (value.startsWith('=')) value = value.replace(/=\s*$/, '');
    const before = sheet.cells[ref]?.v || '';
    if (value === before) return;
    snapshot();
    setRaw(ref, value);
    recompute();
  }

  function setRaw(ref, value) {
    if (value === '' && sheet.cells[ref]) {
      const { v, ...style } = sheet.cells[ref];
      if (Object.keys(style).length) sheet.cells[ref] = { ...style, v: '' };
      else delete sheet.cells[ref];
    } else if (value !== '') {
      sheet.cells[ref] = { ...(sheet.cells[ref] || {}), v: value };
    }
  }

  // Tapping a cell while typing a formula inserts its reference.
  function wantsReference() {
    if (!editing || !input.value.startsWith('=')) return false;
    const before = input.value.slice(0, input.selectionStart ?? input.value.length);
    return /[=(,+\-*/^&<>:]\s*$/.test(before);
  }
  function insertReference(text) {
    const pos = input.selectionStart ?? input.value.length;
    input.value = input.value.slice(0, pos) + text + input.value.slice(pos);
    input.focus();
    input.setSelectionRange(pos + text.length, pos + text.length);
  }

  // ---- Grid ----
  const wrap = h('div', { class: 'grid-wrap' });
  let table;
  let tds = [];
  let colHeads = [];
  let rowHeads = [];
  let nRows = 0;
  let nCols = 0;

  function buildGrid() {
    getValue = computeSheet(sheet);
    const { maxR, maxC } = usedBounds(sheet);
    nRows = Math.max(MIN_ROWS, maxR + 30, sel.r + 10);
    nCols = Math.max(MIN_COLS, maxC + 5, sel.c + 3);
    const colgroup = h('colgroup', {}, h('col', { style: { width: '44px' } }),
      Array.from({ length: nCols }, (_, c) => h('col', { style: { width: `${sheet.cols[c] || DEFAULT_WIDTH}px` } })));
    colHeads = Array.from({ length: nCols }, (_, c) => h('th', { 'data-c': c }, colName(c)));
    const thead = h('thead', {}, h('tr', {}, h('th', { class: 'corner' }), colHeads));
    tds = [];
    rowHeads = [];
    const tbody = h('tbody');
    const frag = document.createDocumentFragment();
    for (let r = 0; r < nRows; r++) {
      const head = h('th', { 'data-r': r }, r + 1);
      rowHeads.push(head);
      const tr = document.createElement('tr');
      tr.append(head);
      const row = [];
      for (let c = 0; c < nCols; c++) {
        const td = document.createElement('td');
        td.dataset.c = c;
        td.dataset.r = r;
        row.push(td);
        tr.append(td);
      }
      tds.push(row);
      frag.append(tr);
    }
    tbody.append(frag);
    table = h('table', { class: 'grid', style: { width: `${44 + Array.from({ length: nCols }, (_, c) => sheet.cols[c] || DEFAULT_WIDTH).reduce((a, b) => a + b, 0)}px` } }, colgroup, thead, tbody);
    wrap.replaceChildren(table);
    paintAll();
    paintSelection();
  }

  function paintCell(c, r) {
    const td = tds[r]?.[c];
    if (!td) return;
    const ref = refName(c, r);
    const cell = sheet.cells[ref];
    const value = cell?.v ? getValue(ref) : '';
    td.textContent = display(value, cell?.nf);
    td.className = '';
    if (typeof value === 'number') td.classList.add('num');
    if (value instanceof FormulaError) td.classList.add('err');
    td.style.fontWeight = cell?.b ? '700' : '';
    td.style.fontStyle = cell?.i ? 'italic' : '';
    td.style.textDecoration = cell?.u ? 'underline' : '';
    td.style.color = cell?.c || '';
    td.style.backgroundColor = cell?.bg || '';
    td.style.textAlign = cell?.al || '';
  }
  function paintAll() {
    for (let r = 0; r < nRows; r++) for (let c = 0; c < nCols; c++) paintCell(c, r);
  }
  function recompute() {
    getValue = computeSheet(sheet);
    paintAll();
    paintSelection();
    save();
  }

  let painted = [];
  function paintSelection() {
    for (const el of painted) el.classList.remove('sel', 'cur', 'hl');
    painted = [];
    const b = selBox();
    for (let r = b.r1; r <= b.r2; r++) {
      for (let c = b.c1; c <= b.c2; c++) {
        const td = tds[r]?.[c];
        if (td) { td.classList.add('sel'); painted.push(td); }
      }
      if (rowHeads[r]) { rowHeads[r].classList.add('hl'); painted.push(rowHeads[r]); }
    }
    for (let c = b.c1; c <= b.c2; c++) if (colHeads[c]) { colHeads[c].classList.add('hl'); painted.push(colHeads[c]); }
    const cur = tds[sel.r]?.[sel.c];
    if (cur) { cur.classList.add('cur'); cur.classList.remove('sel'); }
    const ref = refName(sel.c, sel.r);
    refLabel.textContent = b.c1 === b.c2 && b.r1 === b.r2 ? ref : `${refName(b.c1, b.r1)}:${refName(b.c2, b.r2)}`;
    if (!editing) input.value = sheet.cells[ref]?.v || '';
    refreshButtons();
  }

  function select(c, r, extend = false) {
    if (extend) { sel.c2 = c; sel.r2 = r; } else sel = { c, r, c2: c, r2: r };
    if (r >= nRows - 5 || c >= nCols - 2) buildGrid();
    paintSelection();
  }

  function move(dc, dr) {
    const c = Math.max(0, sel.c + dc);
    const r = Math.max(0, sel.r + dr);
    select(c, r);
    tds[r]?.[c]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  // Pointer handling: tap selects, tap again edits, mouse drag selects a range.
  let dragging = false;
  let lastTap = { ref: null, time: 0 };
  wrap.addEventListener('pointerdown', (e) => {
    const td = e.target.closest('td');
    const th = e.target.closest('th');
    if (th && !td) {
      commit();
      if (th.dataset.c !== undefined) { sel = { c: +th.dataset.c, r: 0, c2: +th.dataset.c, r2: nRows - 1 }; paintSelection(); }
      else if (th.dataset.r !== undefined) { sel = { c: 0, r: +th.dataset.r, c2: nCols - 1, r2: +th.dataset.r }; paintSelection(); }
      return;
    }
    if (!td) return;
    const c = +td.dataset.c;
    const r = +td.dataset.r;
    if (wantsReference()) {
      e.preventDefault();
      insertReference(refName(c, r));
      return;
    }
    const ref = refName(c, r);
    const again = !rangeMode && ref === refName(sel.c, sel.r) && sel.c === sel.c2 && sel.r === sel.r2;
    commit();
    if (rangeMode) { select(c, r, true); return; }
    select(c, r, e.shiftKey);
    if (e.pointerType === 'mouse') { dragging = true; }
    const now = Date.now();
    if (again || (lastTap.ref === ref && now - lastTap.time < 350)) {
      e.preventDefault();
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
    lastTap = { ref, time: now };
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const td = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('td');
    if (td && wrap.contains(td)) select(+td.dataset.c, +td.dataset.r, true);
  });
  window.addEventListener('pointerup', () => { dragging = false; });

  // Hardware keyboard support (tablets, Chromebooks, desktop browsers).
  function onKey(e) {
    if (document.activeElement === input || document.querySelector('.scrim')) return;
    if (!root.contains(wrap)) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === 'z') { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
    if (ctrl && e.key.toLowerCase() === 'y') { e.preventDefault(); return redo(); }
    if (ctrl && e.key.toLowerCase() === 'c') { e.preventDefault(); return copy(false); }
    if (ctrl && e.key.toLowerCase() === 'x') { e.preventDefault(); return copy(true); }
    if (ctrl && e.key.toLowerCase() === 'v') { e.preventDefault(); return paste(); }
    if (ctrl && e.key.toLowerCase() === 'b') { e.preventDefault(); return toggleStyle('b'); }
    if (ctrl && e.key.toLowerCase() === 'i') { e.preventDefault(); return toggleStyle('i'); }
    const arrows = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0], Enter: [0, 1], Tab: [1, 0] };
    if (arrows[e.key]) {
      e.preventDefault();
      if (e.shiftKey && e.key.startsWith('Arrow')) { select(Math.max(0, sel.c2 + arrows[e.key][0]), Math.max(0, sel.r2 + arrows[e.key][1]), true); return; }
      return move(...arrows[e.key]);
    }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); return clearCells(); }
    if (e.key === 'F2') { e.preventDefault(); input.focus(); return; }
    if (e.key.length === 1 && !ctrl && !e.altKey) {
      input.value = '';
      input.focus();
    }
  }
  document.addEventListener('keydown', onKey);

  // ---- Commands ----
  function forSelection(fn) {
    commit();
    snapshot();
    for (const ref of selectedRefs()) {
      sheet.cells[ref] = sheet.cells[ref] || { v: '' };
      fn(sheet.cells[ref], ref);
    }
    recompute();
  }
  function toggleStyle(key) {
    const first = sheet.cells[refName(sel.c, sel.r)];
    const on = !first?.[key];
    forSelection((cell) => { if (on) cell[key] = true; else delete cell[key]; });
  }
  function setStyle(key, value) {
    forSelection((cell) => { if (value == null) delete cell[key]; else cell[key] = value; });
  }
  function clearCells() {
    forSelection((cell, ref) => { delete sheet.cells[ref]; });
  }

  function copy(cut) {
    commit();
    const b = selBox();
    const grid = [];
    for (let r = b.r1; r <= b.r2; r++) {
      const row = [];
      for (let c = b.c1; c <= b.c2; c++) row.push({ ...(sheet.cells[refName(c, r)] || { v: '' }) });
      grid.push(row);
    }
    clipboard = { grid, c: b.c1, r: b.r1, cut };
    const tsv = grid.map((row, ri) => row.map((cell, ci) => display(getValue(refName(b.c1 + ci, b.r1 + ri)), cell.nf)).join('\t')).join('\n');
    navigator.clipboard?.writeText(tsv).catch(() => {});
    if (cut) {
      snapshot();
      for (const ref of selectedRefs()) delete sheet.cells[ref];
      recompute();
    }
    toast(cut ? 'Cut' : 'Copied');
  }

  async function paste() {
    commit();
    let grid = clipboard?.grid;
    let dc = 0;
    let dr = 0;
    if (clipboard) { dc = sel.c - clipboard.c; dr = sel.r - clipboard.r; }
    if (!grid) {
      try {
        const text = await navigator.clipboard.readText();
        grid = text.replace(/\r/g, '').replace(/\n$/, '').split('\n').map((line) => line.split('\t').map((v) => ({ v })));
      } catch {
        return toast('Copy some cells first');
      }
    }
    snapshot();
    grid.forEach((row, ri) => row.forEach((cell, ci) => {
      const ref = refName(sel.c + ci, sel.r + ri);
      const v = cell.v?.startsWith?.('=') && clipboard ? `=${shiftFormula(cell.v.slice(1), dc, dr)}` : cell.v;
      if (!v && Object.keys(cell).length <= 1) delete sheet.cells[ref];
      else sheet.cells[ref] = { ...cell, v };
    }));
    if (clipboard?.cut) clipboard = null;
    sel.c2 = sel.c + grid[0].length - 1;
    sel.r2 = sel.r + grid.length - 1;
    buildGrid();
    save();
  }

  function fill(direction) {
    const b = selBox();
    if ((direction === 'down' && b.r1 === b.r2) || (direction === 'right' && b.c1 === b.c2)) {
      return toast(`Select a range first (use "Select range"), then fill ${direction}`);
    }
    snapshot();
    for (let r = b.r1; r <= b.r2; r++) {
      for (let c = b.c1; c <= b.c2; c++) {
        const srcC = direction === 'right' ? b.c1 : c;
        const srcR = direction === 'down' ? b.r1 : r;
        if (srcC === c && srcR === r) continue;
        const src = sheet.cells[refName(srcC, srcR)];
        const ref = refName(c, r);
        if (!src) { delete sheet.cells[ref]; continue; }
        const v = src.v.startsWith('=') ? `=${shiftFormula(src.v.slice(1), c - srcC, r - srcR)}` : src.v;
        sheet.cells[ref] = { ...src, v };
      }
    }
    recompute();
  }

  async function autoSum() {
    const fn = await actionSheet('Quick formula', [
      { icon: 'sum', label: 'Sum', value: 'SUM' },
      { label: 'Average', value: 'AVERAGE', icon: 'sum' },
      { label: 'Count numbers', value: 'COUNT', icon: 'sum' },
      { label: 'Largest', value: 'MAX', icon: 'up' },
      { label: 'Smallest', value: 'MIN', icon: 'down' },
      { label: 'All functions…', value: 'LIST', icon: 'info' },
    ]);
    if (!fn) return;
    if (fn === 'LIST') return functionList();
    commit();
    const b = selBox();
    snapshot();
    if (b.r1 !== b.r2 || b.c1 !== b.c2) {
      // Put a total under each selected column.
      for (let c = b.c1; c <= b.c2; c++) {
        sheet.cells[refName(c, b.r2 + 1)] = { ...(sheet.cells[refName(c, b.r2 + 1)] || {}), v: `=${fn}(${refName(c, b.r1)}:${refName(c, b.r2)})` };
      }
      sel = { c: b.c1, r: b.r2 + 1, c2: b.c2, r2: b.r2 + 1 };
    } else {
      // Find the run of numbers above (or to the left of) this cell.
      const isNum = (c, r) => typeof getValue(refName(c, r)) === 'number';
      let top = sel.r;
      while (top > 0 && isNum(sel.c, top - 1)) top--;
      let left = sel.c;
      while (left > 0 && isNum(left - 1, sel.r)) left--;
      let range;
      if (top < sel.r) range = `${refName(sel.c, top)}:${refName(sel.c, sel.r - 1)}`;
      else if (left < sel.c) range = `${refName(left, sel.r)}:${refName(sel.c - 1, sel.r)}`;
      if (range) {
        sheet.cells[refName(sel.c, sel.r)] = { ...(sheet.cells[refName(sel.c, sel.r)] || {}), v: `=${fn}(${range})` };
      } else {
        undoStack.pop();
        input.value = `=${fn}(`;
        editing = true;
        input.focus();
        toast('Now tap the cells to include');
        return;
      }
    }
    recompute();
  }

  async function functionList() {
    const name = await actionSheet('Insert function', FUNCTION_NAMES.map((n) => ({ label: n, value: n })));
    if (!name) return;
    const current = input.value;
    input.value = current.startsWith('=') ? `${current}${name}(` : `=${name}(`;
    editing = true;
    input.focus();
  }

  async function formatMenu() {
    const cur = sheet.cells[refName(sel.c, sel.r)] || {};
    const value = await actionSheet('Number format', [
      { label: 'Automatic', value: 'auto', hint: '1234.5' },
      { label: 'Number', value: 'num2', hint: '1,234.50' },
      { label: 'Whole number', value: 'int', hint: '1,235' },
      { label: 'Percent', value: 'pct', hint: '12%' },
      { label: 'Money ($)', value: 'cur:$', hint: '$1,234.50' },
      { label: 'Money (€)', value: 'cur:€', hint: '€1,234.50' },
      { label: 'Money (£)', value: 'cur:£', hint: '£1,234.50' },
      { label: 'Money (₹)', value: 'cur:₹', hint: '₹1,234.50' },
      { label: 'Money (¥)', value: 'cur:¥', hint: '¥1,234.50' },
    ].map((o) => ({ ...o, label: (cur.nf || 'auto') === o.value ? `✓ ${o.label}` : o.label })));
    if (value) setStyle('nf', value === 'auto' ? null : value);
  }

  async function alignMenu() {
    const value = await actionSheet('Align', [
      { icon: 'alignLeft', label: 'Left', value: 'left' },
      { icon: 'alignCenter', label: 'Center', value: 'center' },
      { icon: 'alignRight', label: 'Right', value: 'right' },
    ]);
    if (value) setStyle('al', value);
  }

  async function colorMenu(key) {
    const color = await pickColor(key === 'bg' ? 'Fill color' : 'Text color', { allowNone: true });
    if (color) setStyle(key, color === 'none' ? null : color);
  }

  function shiftCells(axis, at, delta) {
    const moved = {};
    for (const [ref, cell] of Object.entries(sheet.cells)) {
      const p = parseRef(ref);
      const pos = axis === 'row' ? p.r : p.c;
      if (delta < 0 && pos >= at && pos < at - delta) continue;
      const shifted = pos >= at ? pos + delta : pos;
      const next = axis === 'row' ? refName(p.c, shifted) : refName(shifted, p.r);
      moved[next] = cell;
    }
    for (const cell of Object.values(moved)) {
      if (cell.v?.startsWith('=')) cell.v = `=${adjustFormula(cell.v.slice(1), axis, at, delta)}`;
    }
    if (axis === 'col') {
      const cols = {};
      for (const [c, w] of Object.entries(sheet.cols)) {
        const n = Number(c);
        if (delta < 0 && n >= at && n < at - delta) continue;
        cols[n >= at ? n + delta : n] = w;
      }
      sheet.cols = cols;
    }
    sheet.cells = moved;
  }

  async function rowsColsMenu() {
    commit();
    const b = selBox();
    const value = await actionSheet('Rows & columns', [
      { icon: 'rowPlus', label: 'Insert row above', value: 'rowAbove' },
      { icon: 'rowPlus', label: 'Insert row below', value: 'rowBelow' },
      { icon: 'colPlus', label: 'Insert column left', value: 'colLeft' },
      { icon: 'colPlus', label: 'Insert column right', value: 'colRight' },
      { icon: 'trash', label: `Delete row ${b.r1 + 1}${b.r2 > b.r1 ? `–${b.r2 + 1}` : ''}`, value: 'delRow', danger: true },
      { icon: 'trash', label: `Delete column ${colName(b.c1)}${b.c2 > b.c1 ? `–${colName(b.c2)}` : ''}`, value: 'delCol', danger: true },
      { section: 'Column width' },
      { label: 'Narrow', value: 'w60' },
      { label: 'Normal', value: 'w96' },
      { label: 'Wide', value: 'w160' },
      { label: 'Extra wide', value: 'w260' },
    ]);
    if (!value) return;
    snapshot();
    if (value === 'rowAbove') shiftCells('row', b.r1, 1);
    else if (value === 'rowBelow') shiftCells('row', b.r2 + 1, 1);
    else if (value === 'colLeft') shiftCells('col', b.c1, 1);
    else if (value === 'colRight') shiftCells('col', b.c2 + 1, 1);
    else if (value === 'delRow') shiftCells('row', b.r1, -(b.r2 - b.r1 + 1));
    else if (value === 'delCol') shiftCells('col', b.c1, -(b.c2 - b.c1 + 1));
    else if (value.startsWith('w')) for (let c = b.c1; c <= b.c2; c++) sheet.cols[c] = Number(value.slice(1));
    buildGrid();
    save();
  }

  async function sortMenu() {
    commit();
    const value = await actionSheet(`Sort by column ${colName(sel.c)}`, [
      { icon: 'sort', label: 'A → Z, smallest first', value: 'asc', hint: 'keeps row 1' },
      { icon: 'sort', label: 'Z → A, largest first', value: 'desc', hint: 'keeps row 1' },
    ]);
    if (!value) return;
    const b = selBox();
    const { maxR, maxC } = usedBounds(sheet);
    const multiRow = b.r2 > b.r1;
    const r1 = multiRow ? b.r1 : 1;
    const r2 = multiRow ? b.r2 : maxR;
    const c1 = multiRow ? b.c1 : 0;
    const c2 = multiRow ? b.c2 : maxC;
    if (r2 <= r1) return toast('Nothing to sort');
    snapshot();
    const rows = [];
    for (let r = r1; r <= r2; r++) {
      const cells = [];
      for (let c = c1; c <= c2; c++) cells.push(sheet.cells[refName(c, r)]);
      rows.push({ key: getValue(refName(sel.c, r)), cells });
    }
    const dir = value === 'asc' ? 1 : -1;
    rows.sort((a, b2) => {
      const x = a.key;
      const y = b2.key;
      if (x === '' || x == null) return 1;
      if (y === '' || y == null) return -1;
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
      return String(x).localeCompare(String(y), undefined, { numeric: true }) * dir;
    });
    rows.forEach((row, i) => row.cells.forEach((cell, j) => {
      const ref = refName(c1 + j, r1 + i);
      if (cell) sheet.cells[ref] = cell; else delete sheet.cells[ref];
    }));
    recompute();
  }

  async function editMenu() {
    const value = await actionSheet('Edit', [
      { icon: 'copy', label: 'Copy', value: 'copy' },
      { icon: 'cut', label: 'Cut', value: 'cut' },
      { icon: 'paste', label: 'Paste', value: 'paste' },
      { icon: 'down', label: 'Fill down', value: 'fillDown', hint: 'copy top row down' },
      { icon: 'right', label: 'Fill right', value: 'fillRight' },
      { icon: 'eraser', label: 'Clear contents', value: 'clear', danger: true },
    ]);
    if (value === 'copy') copy(false);
    if (value === 'cut') copy(true);
    if (value === 'paste') paste();
    if (value === 'fillDown') fill('down');
    if (value === 'fillRight') fill('right');
    if (value === 'clear') clearCells();
  }

  // ---- Sheet tabs ----
  const tabs = h('div', { class: 'sheet-tabs' });
  function renderTabs() {
    tabs.replaceChildren(
      ...data.sheets.map((s, i) => h('button', {
        class: `sheet-tab${i === data.active ? ' on' : ''}`,
        onClick: () => (i === data.active ? tabMenu(i) : switchSheet(i)),
      }, s.name)),
      h('button', { class: 'sheet-tab', 'aria-label': 'Add sheet', onClick: addSheet }, '+'),
    );
  }
  function switchSheet(i) {
    commit();
    data.active = i;
    sheet = data.sheets[i];
    sel = { c: 0, r: 0, c2: 0, r2: 0 };
    renderTabs();
    buildGrid();
    save();
  }
  function addSheet() {
    snapshot();
    let n = data.sheets.length + 1;
    while (data.sheets.some((s) => s.name === `Sheet${n}`)) n++;
    data.sheets.push(blankSheet(`Sheet${n}`));
    switchSheet(data.sheets.length - 1);
  }
  async function tabMenu(i) {
    const value = await actionSheet(data.sheets[i].name, [
      { icon: 'edit', label: 'Rename sheet', value: 'rename' },
      { icon: 'copy', label: 'Duplicate sheet', value: 'dup' },
      data.sheets.length > 1 ? { icon: 'trash', label: 'Delete sheet', value: 'delete', danger: true } : null,
    ]);
    if (value === 'rename') {
      const name = await askText('Sheet name', { value: data.sheets[i].name });
      if (name?.trim()) { snapshot(); data.sheets[i].name = name.trim(); renderTabs(); save(); }
    } else if (value === 'dup') {
      snapshot();
      data.sheets.splice(i + 1, 0, { ...JSON.parse(JSON.stringify(data.sheets[i])), name: `${data.sheets[i].name} copy` });
      switchSheet(i + 1);
    } else if (value === 'delete' && await confirmBox(`Delete “${data.sheets[i].name}”?`, null, { ok: 'Delete', danger: true })) {
      snapshot();
      data.sheets.splice(i, 1);
      switchSheet(Math.max(0, i - 1));
    }
  }

  // ---- Export ----
  async function exportMenu() {
    commit();
    save.flush();
    const value = await actionSheet('Save a copy / share', [
      { badge: 'sheet', label: 'Excel workbook', hint: '.xlsx', value: 'xlsx' },
      { icon: 'file', label: 'OpenDocument spreadsheet', hint: '.ods', value: 'ods' },
      { icon: 'file', label: 'Excel 97-2003 (values only)', hint: '.xls', value: 'xls' },
      { icon: 'file', label: 'CSV (this sheet)', hint: '.csv', value: 'csv' },
      { badge: 'pdf', label: 'PDF (this sheet)', hint: '.pdf', value: 'pdf' },
    ]);
    if (!value) return;
    try {
      await busy('Preparing file…', async () => {
        if (value === 'xlsx') {
          const out = XLSX.write(toWorkbook(data), { type: 'array', bookType: 'xlsx' });
          await exportFile(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${doc.name}.xlsx`);
        } else if (value === 'ods' || value === 'xls') {
          const out = XLSX.write(toWorkbook(data), { type: 'array', bookType: value === 'xls' ? 'biff8' : 'ods' });
          const mime = value === 'xls' ? 'application/vnd.ms-excel' : 'application/vnd.oasis.opendocument.spreadsheet';
          await exportFile(new Blob([out], { type: mime }), `${doc.name}.${value}`);
        } else if (value === 'csv') {
          const wb = toWorkbook({ sheets: [sheet] });
          const csv = XLSX.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]]);
          await exportFile(new Blob(['\ufeff' + csv], { type: 'text/csv' }), `${doc.name}.csv`);
        } else {
          const { documentToPdf } = await import('./render-pdf.js');
          const table = sheetToHtmlTable(sheet);
          document.body.append(table);
          try { await exportFile(await documentToPdf(table, { contentWidth: Math.max(680, table.scrollWidth) }), `${doc.name}.pdf`); } finally { table.remove(); }
        }
      });
    } catch (err) {
      console.error(err);
      toast('Export failed: ' + (err.message || err));
    }
  }

  // ---- Toolbar ----
  const styleButtons = {};
  const rangeBtn = h('button', { class: 'tb-text', onClick: () => { rangeMode = !rangeMode; rangeBtn.classList.toggle('on', rangeMode); toast(rangeMode ? 'Tap another cell to select a range' : 'Range selection off'); } }, icon('square'), 'Select');
  function refreshButtons() {
    const cell = sheet.cells[refName(sel.c, sel.r)] || {};
    for (const [key, btn] of Object.entries(styleButtons)) btn.classList.toggle('on', !!cell[key]);
  }
  const styleBtn = (iconName, label, key) => (styleButtons[key] = iconBtn(iconName, label, () => toggleStyle(key)));
  const textBtn = (label, onClick, iconName) => h('button', { class: 'tb-text', onClick }, iconName ? icon(iconName) : null, label);
  const sep = () => h('span', { class: 'sep' });

  const toolbar = h('nav', { class: 'toolbar', 'aria-label': 'Sheet tools' },
    rangeBtn,
    textBtn('Σ', autoSum),
    sep(),
    styleBtn('bold', 'Bold', 'b'),
    styleBtn('italic', 'Italic', 'i'),
    iconBtn('alignLeft', 'Align', alignMenu),
    h('button', { class: 'tb-text', 'aria-label': 'Text color', onClick: () => colorMenu('c') },
      h('span', { class: 'tb-stack' }, 'A', h('span', { class: 'color-dot', style: { background: '#d93a3a' } }))),
    iconBtn('palette', 'Fill color', () => colorMenu('bg')),
    textBtn('123', formatMenu),
    sep(),
    iconBtn('rowPlus', 'Rows & columns', rowsColsMenu),
    iconBtn('sort', 'Sort', sortMenu),
    textBtn('Edit', editMenu, 'copy'),
  );

  async function close() {
    commit();
    save.flush();
    document.removeEventListener('keydown', onKey);
    onExit();
  }

  const bar = topBar(doc, {
    onBack: close,
    buttons: [
      iconBtn('undo', 'Undo', undo),
      iconBtn('redo', 'Redo', redo),
      iconBtn('share', 'Save a copy / share', exportMenu),
    ],
  });

  root.append(bar, fxbar, wrap, tabs, toolbar);
  renderTabs();
  buildGrid();
  return close;
}
