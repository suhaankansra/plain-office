// Sheets: a spreadsheet that opens and saves Excel (.xlsx) and CSV files.

import * as XLSX from 'xlsx';
import { h, icon, iconBtn, keepFocus, toast, busy, actionSheet, askText, confirmBox, debounce, escapeHtml } from '../ui.js';
import { exportFile } from '../files.js';
import { topBar, persist } from './shell.js';
import { evaluate, FormulaError, colName, parseRef, refName, shiftFormula, adjustFormula, FUNCTION_NAMES } from './formula.js';
import { formatPanel, group, row, segmented, toggles, stepper, swatches, switchRow, actions, choices, chips, note } from './panel.js';
import { chartSvg, tableToChartData, CHART_TYPES } from './charts.js';

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

// Dates from Excel serial numbers or text like 2025-03-01.
function asDate(value) {
  if (typeof value === 'number' && value > 0 && value < 2958466) {
    return new Date(Math.round((value - 25569) * 86400000) + new Date().getTimezoneOffset() * 60000);
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2}))?/.exec(value.trim());
  const d = m ? new Date(+m[1], m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
const isTruthy = (v) => v === true || (typeof v === 'number' && v !== 0) || (typeof v === 'string' && /^(true|yes|1|x|✓)$/i.test(v.trim()));

// nf: the number format; dp: decimal places (for numbers, money and percent).
function display(value, nf, dp) {
  if (value instanceof FormulaError) return value.code;
  if (nf === 'check') return '';
  if (nf === 'stars') {
    const n = Math.max(0, Math.min(5, Math.round(Number(value) || 0)));
    return '★'.repeat(n) + '☆'.repeat(5 - n);
  }
  if (nf === 'date' || nf === 'time') {
    const d = nf === 'time' && typeof value === 'number' && value < 1 ? new Date(2000, 0, 1, 0, 0, Math.round(value * 86400)) : asDate(value);
    if (d) return nf === 'date' ? d.toLocaleDateString(undefined, { dateStyle: 'medium' }) : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value !== 'number') return value ?? '';
  const fixed = (d) => ({ minimumFractionDigits: d, maximumFractionDigits: d });
  if (nf === 'num' || nf === 'num2' || nf === 'int') return value.toLocaleString(undefined, fixed(dp ?? (nf === 'int' ? 0 : 2)));
  if (nf === 'pct') return `${(value * 100).toLocaleString(undefined, dp == null ? { maximumFractionDigits: 2 } : fixed(dp))}%`;
  if (nf?.startsWith('cur:')) {
    const sym = nf.slice(4);
    const text = Math.abs(value).toLocaleString(undefined, fixed(dp ?? 2));
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

// ---------- Table looks (header row, banded rows...) ----------
const LOOK_COLORS = {
  none: ['#eef0f3', '#f6f7f9', '#1d2125'],
  blue: ['#2b6fdc', '#eaf1fc', '#ffffff'],
  green: ['#1f9d55', '#e7f6ee', '#ffffff'],
  orange: ['#e8711a', '#fdf0e6', '#ffffff'],
  gray: ['#5c6670', '#f0f2f4', '#ffffff'],
  purple: ['#6a4cd6', '#f0ecfc', '#ffffff'],
};
function cellLook(sheet, c, r, bounds) {
  const look = sheet.look;
  if (!look || r > Math.max(bounds.maxR, 0) || c > Math.max(bounds.maxC, 0)) return null;
  const [strong, soft, onStrong] = LOOK_COLORS[look.color] || LOOK_COLORS.none;
  if (look.header && r === 0) return { bg: strong, color: onStrong, bold: true };
  // The soft colours are light, so their text stays dark (also in dark mode).
  if (look.headerCol && c === 0) return { bg: soft, color: '#1d2125', bold: true };
  if (look.banded && r % 2 === (look.header ? 0 : 1)) return { bg: soft, color: '#1d2125' };
  return null;
}

// ---------- Export ----------
function xlsxFormat(cell) {
  const dec = (d) => (d > 0 ? `.${'0'.repeat(d)}` : '');
  const { nf, dp } = cell;
  if (nf === 'num' || nf === 'num2') return `#,##0${dec(dp ?? 2)}`;
  if (nf === 'int') return `#,##0${dec(dp ?? 0)}`;
  if (nf === 'pct') return `0${dec(dp ?? 0)}%`;
  if (nf?.startsWith('cur:')) return `"${nf.slice(4)}"#,##0${dec(dp ?? 2)}`;
  if (nf === 'date') return 'yyyy-mm-dd';
  if (nf === 'time') return 'hh:mm';
  return undefined;
}

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
      if (cell.nf) out.z = xlsxFormat(cell);
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
  const bounds = usedBounds(sheet);
  const { maxR, maxC } = bounds;
  const rows = [];
  for (let r = 0; r <= maxR; r++) {
    const tds = [];
    for (let c = 0; c <= maxC; c++) {
      const cell = sheet.cells[refName(c, r)] || {};
      const value = get(refName(c, r));
      const look = cellLook(sheet, c, r, bounds) || {};
      const deco = [cell.u && 'underline', cell.s && 'line-through'].filter(Boolean).join(' ');
      const style = [
        (cell.b || look.bold) && 'font-weight:700', cell.i && 'font-style:italic', deco && `text-decoration:${deco}`,
        (cell.c || look.color) && `color:${cell.c || look.color}`, (cell.bg || look.bg) && `background:${cell.bg || look.bg}`,
        cell.fs && `font-size:${cell.fs * 0.86}px`,
        `text-align:${cell.al || (typeof value === 'number' ? 'right' : 'left')}`,
      ].filter(Boolean).join(';');
      const text = cell.nf === 'check' ? (isTruthy(value) ? '☑' : '☐') : display(value, cell.nf, cell.dp);
      tds.push(`<td style="${style}">${escapeHtml(text)}</td>`);
    }
    rows.push(`<tr>${tds.join('')}</tr>`);
  }
  const el = h('div', { html: `<table style="border-collapse:collapse;font:12px Arial,sans-serif">${rows.join('')}</table>` });
  el.querySelectorAll('td').forEach((td) => Object.assign(td.style, { border: '1px solid #c8ced6', padding: '3px 6px', whiteSpace: 'nowrap' }));
  return el;
}

// ---------- Editor ----------
export async function open(doc, root, onExit) {
  const readOnly = !!doc.readOnly;
  const data = doc.data;
  let sheet = data.sheets[data.active] || data.sheets[0];
  let getValue = computeSheet(sheet);
  let bounds = usedBounds(sheet);
  let selectedChart = null;
  let sel = { c: 0, r: 0, c2: 0, r2: 0 };
  let rangeMode = false;
  let clipboard = null;
  const undoStack = [];
  const redoStack = [];

  const save = readOnly ? Object.assign(() => {}, { flush() {} }) : debounce(() => persist(doc), 600);

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
    readOnly,
  });
  const fxbar = h('div', { class: 'fxbar' }, refLabel, h('span', { class: 'fx' }, 'fx'), input,
    readOnly ? null : iconBtn('check', 'Done', () => { commit(); input.blur(); }));
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
    if (readOnly) return;
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
    table = h('table', { class: `grid${sheet.look?.freeze ? ' freeze' : ''}${sheet.look?.grid === false ? ' nogrid' : ''}`, style: { width: `${44 + Array.from({ length: nCols }, (_, c) => sheet.cols[c] || DEFAULT_WIDTH).reduce((a, b) => a + b, 0)}px` } }, colgroup, thead, tbody);
    wrap.replaceChildren(table, chartLayer);
    paintAll();
    paintSelection();
    renderCharts();
  }

  function paintCell(c, r) {
    const td = tds[r]?.[c];
    if (!td) return;
    const ref = refName(c, r);
    const cell = sheet.cells[ref];
    const value = cell?.v ? getValue(ref) : '';
    const look = cellLook(sheet, c, r, bounds) || {};
    td.textContent = display(value, cell?.nf, cell?.dp);
    td.className = '';
    if (typeof value === 'number' && cell?.nf !== 'stars') td.classList.add('num');
    if (value instanceof FormulaError) td.classList.add('err');
    if (cell?.nf === 'check') { td.classList.add('check'); if (isTruthy(value)) td.classList.add('on'); }
    if (cell?.nf === 'stars') td.classList.add('stars');
    if (cell?.wrap) td.classList.add('wrap');
    td.style.fontWeight = cell?.b || look.bold ? '700' : '';
    td.style.fontStyle = cell?.i ? 'italic' : '';
    td.style.textDecoration = [cell?.u && 'underline', cell?.s && 'line-through'].filter(Boolean).join(' ');
    td.style.color = cell?.c || look.color || '';
    td.style.backgroundColor = cell?.bg || look.bg || '';
    td.style.textAlign = cell?.al || '';
    td.style.fontSize = cell?.fs ? `${cell.fs}px` : '';
    td.style.boxShadow = { all: 'inset 0 0 0 1px #1d2125', bottom: 'inset 0 -1px 0 #1d2125', thick: 'inset 0 -3px 0 #1d2125' }[cell?.bd] || '';
  }
  function paintAll() {
    bounds = usedBounds(sheet);
    for (let r = 0; r < nRows; r++) for (let c = 0; c < nCols; c++) paintCell(c, r);
  }
  function recompute() {
    getValue = computeSheet(sheet);
    paintAll();
    paintSelection();
    renderCharts();
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
    if (panel?.isOpen) refreshPanelSoon();
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
    if (e.target.closest('.chart-obj')) return; // charts handle their own taps
    if (selectedChart) { selectedChart = null; renderCharts(); if (panel.isOpen) panel.refresh(); }
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
    // Tapping a checkbox ticks it.
    if (!rangeMode && !readOnly && sheet.cells[ref]?.nf === 'check') {
      e.preventDefault();
      select(c, r);
      snapshot();
      sheet.cells[ref].v = isTruthy(getValue(ref)) ? 'FALSE' : 'TRUE';
      recompute();
      return;
    }
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
    // Read only: just move around and copy.
    if (readOnly && !/^Arrow|^(Enter|Tab)$/.test(e.key) && !(ctrl && e.key.toLowerCase() === 'c')) return;
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
    const tsv = grid.map((row, ri) => row.map((cell, ci) => display(getValue(refName(b.c1 + ci, b.r1 + ri)), cell.nf, cell.dp)).join('\t')).join('\n');
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
        onClick: () => (i === data.active ? (readOnly ? null : tabMenu(i)) : switchSheet(i)),
      }, s.name)),
      readOnly ? null : h('button', { class: 'sheet-tab', 'aria-label': 'Add sheet', onClick: addSheet }, '+'),
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

  // ---- Charts (they float over the grid, like in Numbers) ----
  const chartLayer = h('div', { class: 'chart-layer' });
  const parseRange = (range) => {
    const [a, b = a] = String(range).split(':').map(parseRef);
    if (!a || !b) return null;
    return { c1: Math.min(a.c, b.c), r1: Math.min(a.r, b.r), c2: Math.max(a.c, b.c), r2: Math.max(a.r, b.r) };
  };
  function chartData(ch) {
    const box = parseRange(ch.range);
    if (!box) return { labels: [], series: [] };
    const rows = [];
    for (let r = box.r1; r <= Math.min(box.r2, box.r1 + 200); r++) {
      const line = [];
      for (let c = box.c1; c <= Math.min(box.c2, box.c1 + 20); c++) {
        const v = getValue(refName(c, r));
        line.push(v instanceof FormulaError ? '' : v);
      }
      rows.push(line);
    }
    return tableToChartData(rows);
  }
  function renderCharts() {
    chartLayer.replaceChildren(...(sheet.charts || []).map((ch) => {
      const box = h('div', {
        class: `chart-obj${ch.id === selectedChart ? ' sel' : ''}`,
        'data-id': ch.id,
        style: { left: `${ch.x}px`, top: `${ch.y}px`, width: `${ch.w}px`, height: `${ch.h}px` },
        html: chartSvg({ type: ch.type, title: ch.title, data: chartData(ch), showLegend: ch.legend !== false, width: ch.w - 12, height: ch.h - 12 }),
      });
      if (ch.id === selectedChart && !readOnly) box.append(h('div', { class: 'chart-handle', 'data-handle': '1' }));
      return box;
    }));
  }
  const findChart = (id) => (sheet.charts || []).find((c) => c.id === id);

  let chartDrag = null;
  chartLayer.addEventListener('pointerdown', (e) => {
    const box = e.target.closest('.chart-obj');
    if (!box) return;
    e.stopPropagation();
    commit();
    const ch = findChart(box.dataset.id);
    const wasSelected = selectedChart === ch.id;
    if (!wasSelected) { selectedChart = ch.id; renderCharts(); if (panel.isOpen) panel.refresh(); }
    if (readOnly) return;
    const target = chartLayer.querySelector(`[data-id="${ch.id}"]`);
    chartDrag = { ch, target, x: e.clientX, y: e.clientY, ox: ch.x, oy: ch.y, ow: ch.w, oh: ch.h, resize: !!e.target.dataset.handle, moved: false, wasSelected };
    target.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  });
  chartLayer.addEventListener('pointermove', (e) => {
    if (!chartDrag) return;
    const dx = e.clientX - chartDrag.x;
    const dy = e.clientY - chartDrag.y;
    if (!chartDrag.moved && Math.hypot(dx, dy) < 6) return;
    if (!chartDrag.moved) { snapshot(); chartDrag.moved = true; }
    const { ch, target } = chartDrag;
    if (chartDrag.resize) {
      ch.w = Math.max(200, Math.round(chartDrag.ow + dx));
      ch.h = Math.max(140, Math.round(chartDrag.oh + dy));
      Object.assign(target.style, { width: `${ch.w}px`, height: `${ch.h}px` });
    } else {
      ch.x = Math.max(44, Math.round(chartDrag.ox + dx));
      ch.y = Math.max(30, Math.round(chartDrag.oy + dy));
      Object.assign(target.style, { left: `${ch.x}px`, top: `${ch.y}px` });
    }
  });
  chartLayer.addEventListener('pointerup', () => {
    if (!chartDrag) return;
    const { moved, wasSelected } = chartDrag;
    chartDrag = null;
    if (moved) { renderCharts(); save(); return; }
    if (wasSelected) openFormat('chart');
  });

  async function insertChart(type) {
    commit();
    let b = selBox();
    if (b.r1 === b.r2 && b.c1 === b.c2) {
      // One cell selected: chart the whole table of data.
      const used = usedBounds(sheet);
      if (used.maxR < 0) return toast('Type some numbers first, then add a chart');
      b = { c1: 0, r1: 0, c2: used.maxC, r2: used.maxR };
    }
    const anchor = tds[b.r1]?.[Math.min(b.c2 + 1, nCols - 1)];
    const ch = {
      id: `c${Date.now().toString(36)}`,
      type,
      range: `${refName(b.c1, b.r1)}:${refName(b.c2, b.r2)}`,
      title: '',
      x: anchor ? anchor.offsetLeft + 12 : 60,
      y: anchor ? anchor.offsetTop : 40,
      w: Math.min(380, Math.max(260, wrap.clientWidth - 70)),
      h: 240,
    };
    if (anchor && ch.x + ch.w > wrap.scrollLeft + wrap.clientWidth) { ch.x = Math.max(50, wrap.scrollLeft + 20); ch.y = (tds[b.r2]?.[0]?.offsetTop || 0) + 44; }
    snapshot();
    (sheet.charts ||= []).push(ch);
    selectedChart = ch.id;
    renderCharts();
    save();
    chartLayer.querySelector(`[data-id="${ch.id}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    openFormat('chart');
  }
  function updateChart(fn) {
    const ch = findChart(selectedChart);
    if (!ch) return;
    snapshot();
    fn(ch);
    renderCharts();
    save();
  }

  // ---- Format panel ----
  const curCell = () => sheet.cells[refName(sel.c, sel.r)] || {};
  const formatKind = (nf) => (!nf ? 'auto' : nf === 'num2' || nf === 'int' ? 'num' : nf.startsWith('cur:') ? 'cur' : nf);
  function setFormat(kind) {
    const cell = curCell();
    if (kind === 'check') {
      forSelection((c) => { c.nf = 'check'; if (c.v === '' || c.v == null) c.v = 'FALSE'; });
      return;
    }
    const nf = kind === 'auto' ? null : kind === 'cur' ? (cell.nf?.startsWith('cur:') ? cell.nf : 'cur:$') : kind;
    setStyle('nf', nf);
  }
  function setLook(key, value) {
    snapshot();
    sheet.look = { ...(sheet.look || {}), [key]: value };
    if (key === 'freeze' || key === 'grid') buildGrid(); else paintAll();
    paintSelection();
    save();
  }
  const panel = formatPanel({
    title: 'Format',
    onClose: () => { brushBtn.classList.remove('on'); toolbar.hidden = false; },
    tabs: () => {
      const ch = findChart(selectedChart);
      if (ch) {
        return [{ key: 'chart', label: 'Chart', render: () => [
          group('Chart type', actions(CHART_TYPES.map((t) => ({ icon: t.icon, label: (t.value === ch.type ? '● ' : '') + t.label, onClick: () => { updateChart((c) => { c.type = t.value; }); panel.refresh(); } })), 3)),
          group(null,
            row('Title', (() => {
              const input = h('input', { class: 'fp-input', value: ch.title || '', placeholder: 'No title' });
              input.addEventListener('change', () => updateChart((c) => { c.title = input.value.trim(); }));
              return input;
            })()),
            switchRow('Legend', ch.legend !== false, (on) => updateChart((c) => { c.legend = on; }))),
          group('Data', row('Cells', h('strong', {}, ch.range)),
            h('button', { class: 'fp-link', onClick: () => {
              const b = selBox();
              if (b.r1 === b.r2 && b.c1 === b.c2) return toast('First select the cells: tap Select, then the first and last cell');
              updateChart((c) => { c.range = `${refName(b.c1, b.r1)}:${refName(b.c2, b.r2)}`; });
              panel.refresh();
            } }, 'Use the selected cells')),
          note('Drag the chart to move it, or drag its round handle to resize it.'),
          group(null, actions([{ icon: 'trash', label: 'Delete chart', danger: true, onClick: () => {
            snapshot();
            sheet.charts = sheet.charts.filter((c) => c.id !== selectedChart);
            selectedChart = null;
            renderCharts();
            save();
            panel.close();
          } }], 1)),
        ] }];
      }
      const cell = curCell();
      const kind = formatKind(cell.nf);
      return [
        { key: 'cell', label: 'Cell', render: () => [
          group('Format', choices([
            { value: 'auto', label: 'Automatic', hint: '1234.5' },
            { value: 'num', label: 'Number', hint: '1,234.50' },
            { value: 'cur', label: 'Currency', hint: '$1,234.50' },
            { value: 'pct', label: 'Percent', hint: '12%' },
            { value: 'date', label: 'Date', hint: new Date().toLocaleDateString(undefined, { dateStyle: 'medium' }) },
            { value: 'time', label: 'Time', hint: '14:30' },
            { value: 'check', label: 'Checkbox', hint: '☑' },
            { value: 'stars', label: 'Star rating', hint: '★★★☆☆' },
          ], kind, (k) => { setFormat(k); panel.refresh(); })),
          kind === 'cur' && group('Currency', chips(['$', '€', '£', '¥', '₹', '₩', '₽', 'R$', 'CHF '].map((sym) => ({ value: `cur:${sym}`, label: sym.trim() })), cell.nf, (nf) => setStyle('nf', nf))),
          ['num', 'cur', 'pct'].includes(kind) && group(null, row('Decimals', stepper(cell.dp ?? (kind === 'pct' ? 0 : 2), { min: 0, max: 8 }, (d) => setStyle('dp', d)))),
          kind === 'stars' && note('Type a number from 0 to 5 in the cell.'),
        ] },
        { key: 'text', label: 'Text', render: () => [
          group(null, toggles([
            { icon: 'bold', title: 'Bold', on: !!cell.b, onClick: () => toggleStyle('b') },
            { icon: 'italic', title: 'Italic', on: !!cell.i, onClick: () => toggleStyle('i') },
            { icon: 'underline', title: 'Underline', on: !!cell.u, onClick: () => toggleStyle('u') },
            { icon: 'strike', title: 'Strikethrough', on: !!cell.s, onClick: () => toggleStyle('s') },
          ])),
          group(null, row('Size', stepper(cell.fs || 14, { min: 8, max: 48, format: (v) => `${v} pt` }, (v) => setStyle('fs', v === 14 ? null : v)))),
          group('Colour', swatches(cell.c || '#000000', (c) => setStyle('c', c === 'none' ? null : c))),
          group('Alignment', segmented([
            { value: '', label: 'Auto' },
            { value: 'left', icon: 'alignLeft', title: 'Left' },
            { value: 'center', icon: 'alignCenter', title: 'Center' },
            { value: 'right', icon: 'alignRight', title: 'Right' },
          ], cell.al || '', (v) => setStyle('al', v || null), { wide: true })),
          group(null, switchRow('Wrap text', !!cell.wrap, (on) => setStyle('wrap', on || null))),
        ] },
        { key: 'fill', label: 'Fill', render: () => [
          group('Fill colour', swatches(cell.bg, (c) => setStyle('bg', c === 'none' ? null : c), { allowNone: true })),
          group('Border', segmented([
            { value: '', label: 'None' },
            { value: 'all', label: 'Box' },
            { value: 'bottom', label: 'Under' },
            { value: 'thick', label: 'Thick' },
          ], cell.bd || '', (v) => setStyle('bd', v || null), { wide: true })),
        ] },
        { key: 'table', label: 'Table', render: () => {
          const look = sheet.look || {};
          return [
            group('Table style', chips(Object.keys(LOOK_COLORS).map((k) => ({
              value: k, label: k === 'none' ? 'Plain' : k[0].toUpperCase() + k.slice(1),
              style: k === 'none' ? {} : { borderLeft: `14px solid ${LOOK_COLORS[k][0]}` },
            })), look.color || 'none', (k) => setLook('color', k))),
            group(null,
              switchRow('Header row', !!look.header, (on) => setLook('header', on)),
              switchRow('Header column', !!look.headerCol, (on) => setLook('headerCol', on)),
              switchRow('Banded rows', !!look.banded, (on) => setLook('banded', on)),
              switchRow('Freeze header row', !!look.freeze, (on) => setLook('freeze', on)),
              switchRow('Gridlines', look.grid !== false, (on) => setLook('grid', on))),
          ];
        } },
      ];
    },
  });
  const refreshPanelSoon = debounce(() => panel.refresh(), 100);
  function openFormat(tab) {
    if (panel.isOpen && !tab) { panel.close(); return; }
    commit();
    input.blur();
    brushBtn.classList.add('on');
    toolbar.hidden = true;
    panel.show(root, tab);
  }

  async function insertMenu() {
    commit();
    const value = await actionSheet('Insert', [
      { icon: 'chart', label: 'Chart', hint: 'from the selected cells', value: 'chart' },
      { icon: 'function', label: 'Function', value: 'fn' },
      { icon: 'checkbox', label: 'Checkbox', value: 'check' },
      { icon: 'star', label: 'Star rating', value: 'stars' },
      { icon: 'calendar', label: "Today's date", value: 'date' },
      { icon: 'clock', label: 'Current time', value: 'time' },
      { icon: 'rowPlus', label: 'Rows & columns', value: 'rows' },
      { icon: 'plus', label: 'New sheet', value: 'sheet' },
    ]);
    if (value === 'chart') {
      const type = await actionSheet('Chart type', CHART_TYPES.map((t) => ({ icon: t.icon, label: t.label, value: t.value })));
      if (type) insertChart(type);
    } else if (value === 'fn') functionList();
    else if (value === 'check') setFormat('check');
    else if (value === 'stars') forSelection((c) => { c.nf = 'stars'; if (c.v === '' || c.v == null) c.v = '3'; });
    else if (value === 'date' || value === 'time') {
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const v = value === 'date' ? `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` : `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
      snapshot();
      sheet.cells[refName(sel.c, sel.r)] = { ...curCell(), v, nf: value };
      recompute();
    } else if (value === 'rows') rowsColsMenu();
    else if (value === 'sheet') addSheet();
  }

  async function moreMenu() {
    commit();
    const value = await actionSheet(null, [
      { icon: 'share', label: 'Save a copy / share', value: 'export' },
      { icon: 'redo', label: 'Redo', value: 'redo' },
      { icon: 'sort', label: 'Sort', value: 'sort' },
      { icon: 'copy', label: 'Copy, paste & fill', value: 'edit' },
      { icon: 'sigma', label: 'Quick formula', value: 'sum' },
    ]);
    if (value === 'export') exportMenu();
    if (value === 'redo') redo();
    if (value === 'sort') sortMenu();
    if (value === 'edit') editMenu();
    if (value === 'sum') autoSum();
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
    iconBtn('palette', 'Fill colour', () => openFormat('fill')),
    textBtn('123', () => openFormat('cell')),
    sep(),
    iconBtn('chart', 'Insert chart', async () => {
      const type = await actionSheet('Chart type', CHART_TYPES.map((t) => ({ icon: t.icon, label: t.label, value: t.value })));
      if (type) insertChart(type);
    }),
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

  const brushBtn = keepFocus(iconBtn('brush', 'Format', () => openFormat()));
  const bar = topBar(doc, {
    onBack: close,
    buttons: readOnly ? [] : [
      iconBtn('undo', 'Undo', undo),
      brushBtn,
      keepFocus(iconBtn('plus', 'Insert', insertMenu)),
      iconBtn('more', 'More', moreMenu),
    ],
  });

  if (readOnly) root.append(bar, fxbar, wrap, tabs);
  else root.append(bar, fxbar, wrap, tabs, toolbar);
  renderTabs();
  buildGrid();
  return close;
}
