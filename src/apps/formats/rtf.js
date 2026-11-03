// Rich Text Format (.rtf) reader and writer.

import { escapeHtml } from '../../ui.js';

// Groups whose contents are never shown as text.
const SKIP = new Set([
  'fonttbl', 'stylesheet', 'info', 'pict', 'header', 'headerl', 'headerr', 'headerf', 'footer', 'footerl', 'footerr', 'footerf',
  'object', 'fldinst', 'themedata', 'colorschememapping', 'latentstyles', 'datastore', 'xmlnstbl', 'listtable',
  'listoverridetable', 'rsidtbl', 'generator', 'mmathPr', 'pgdsctbl', 'revtbl', 'filetbl', 'bkmkstart', 'bkmkend',
  'footnote', 'annotation', 'atnid', 'atnauthor', 'pntxta', 'pntxtb', 'shppict', 'nonshppict', 'sp', 'xe', 'tc',
]);
const CHARS = { emdash: '—', endash: '–', bullet: '•', lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”', tab: '\t', emspace: '\u2003', enspace: '\u2002', qmspace: '\u2005' };

export function rtfToHtml(rtf) {
  let decoder = new TextDecoder('windows-1252');
  const colors = [];
  const paras = [];
  let runs = [];
  let align = null;
  let st = { b: false, i: false, u: false, s: false, fs: 24, cf: 0, skip: false, uc: 1, colortbl: false };
  const stack = [];
  let pendingSkip = 0;
  let color = [0, 0, 0];
  let destStart = false;

  const emit = (text) => {
    if (st.skip || !text) return;
    if (pendingSkip > 0) {
      const cut = Math.min(pendingSkip, text.length);
      text = text.slice(cut);
      pendingSkip -= cut;
      if (!text) return;
    }
    const last = runs[runs.length - 1];
    const style = { b: st.b, i: st.i, u: st.u, s: st.s, fs: st.fs, cf: st.cf };
    if (last && JSON.stringify(last.style) === JSON.stringify(style)) last.text += text;
    else runs.push({ text, style });
  };
  const endPara = () => { paras.push({ runs, align }); runs = []; };

  let i = 0;
  const n = rtf.length;
  while (i < n) {
    const ch = rtf[i];
    if (ch === '{') { stack.push({ ...st }); destStart = true; i++; continue; }
    if (ch === '}') {
      st = stack.pop() || st;
      destStart = false;
      i++;
      continue;
    }
    if (ch === '\\') {
      const next = rtf[i + 1];
      if (next === '\\' || next === '{' || next === '}') { emit(next); i += 2; destStart = false; continue; }
      if (next === '*') { st.skip = true; i += 2; continue; }
      if (next === "'") {
        const bytes = [];
        while (rtf[i] === '\\' && rtf[i + 1] === "'") { bytes.push(parseInt(rtf.substr(i + 2, 2), 16)); i += 4; }
        emit(decoder.decode(new Uint8Array(bytes)));
        destStart = false;
        continue;
      }
      if (next === '~') { emit('\u00a0'); i += 2; continue; }
      if (next === '_') { emit('\u2011'); i += 2; continue; }
      if (next === '-') { i += 2; continue; }
      if (next === '\n' || next === '\r') { if (!st.skip) endPara(); i += 2; continue; }
      const m = /^([a-zA-Z]{1,32})(-?\d{1,10})? ?/.exec(rtf.slice(i + 1, i + 46));
      if (!m) { i += 2; continue; }
      i += 1 + m[0].length;
      const word = m[1];
      const arg = m[2] !== undefined ? Number(m[2]) : null;
      const first = destStart;
      destStart = false;
      if (first && SKIP.has(word)) { st.skip = true; continue; }
      if (word === 'colortbl') { st.colortbl = true; st.skip = true; color = [0, 0, 0]; continue; }
      if (st.colortbl) {
        if (word === 'red') color[0] = arg;
        if (word === 'green') color[1] = arg;
        if (word === 'blue') color[2] = arg;
        continue;
      }
      switch (word) {
        case 'ansicpg': try { decoder = new TextDecoder(`windows-${arg}`); } catch { /* keep 1252 */ } break;
        case 'u': {
          const code = arg < 0 ? arg + 65536 : arg;
          emit(String.fromCharCode(code));
          pendingSkip = st.uc;
          break;
        }
        case 'uc': st.uc = arg ?? 1; break;
        case 'par': case 'sect': case 'page': case 'row': if (!st.skip) endPara(); break;
        case 'line': emit('\n'); break;
        case 'cell': emit('\t'); break;
        case 'pard': align = null; break;
        case 'plain': Object.assign(st, { b: false, i: false, u: false, s: false, fs: 24, cf: 0 }); break;
        case 'b': st.b = arg !== 0; break;
        case 'i': st.i = arg !== 0; break;
        case 'ul': case 'uld': case 'uldb': case 'ulw': st.u = arg !== 0; break;
        case 'ulnone': st.u = false; break;
        case 'strike': case 'striked': st.s = arg !== 0; break;
        case 'fs': st.fs = arg || 24; break;
        case 'cf': st.cf = arg || 0; break;
        case 'qc': align = 'center'; break;
        case 'qr': align = 'right'; break;
        case 'qj': align = 'justify'; break;
        case 'ql': align = null; break;
        default: if (CHARS[word]) emit(CHARS[word]);
      }
      continue;
    }
    if (ch === '\r' || ch === '\n') { i++; continue; }
    if (st.colortbl) {
      if (ch === ';') { colors.push(`rgb(${color.join(',')})`); color = [0, 0, 0]; }
      i++;
      continue;
    }
    // Plain text run up to the next control character.
    let j = i;
    while (j < n && !'\\{}\r\n'.includes(rtf[j])) j++;
    emit(rtf.slice(i, j));
    destStart = false;
    i = j;
  }
  if (runs.length) endPara();
  while (paras.length && !paras.at(-1).runs.length) paras.pop();

  return paras.map(({ runs: rs, align: a }) => {
    const inner = rs.map(({ text, style }) => {
      let html = escapeHtml(text).replace(/\n/g, '<br>').replace(/\t/g, '&emsp;');
      const css = [];
      if (style.fs && style.fs !== 24) css.push(`font-size:${(style.fs / 2).toFixed(1)}pt`);
      if (style.cf && colors[style.cf]) css.push(`color:${colors[style.cf]}`);
      if (css.length) html = `<span style="${css.join(';')}">${html}</span>`;
      if (style.s) html = `<s>${html}</s>`;
      if (style.u) html = `<u>${html}</u>`;
      if (style.i) html = `<i>${html}</i>`;
      if (style.b) html = `<b>${html}</b>`;
      return html;
    }).join('');
    return `<p${a ? ` style="text-align:${a}"` : ''}>${inner || '<br>'}</p>`;
  }).join('');
}

// ---------- Writer ----------
function rtfEscape(text) {
  let out = '';
  for (const c of text) {
    const code = c.codePointAt(0);
    if (c === '\\' || c === '{' || c === '}') out += `\\${c}`;
    else if (c === '\n') out += '\\line ';
    else if (c === '\t') out += '\\tab ';
    else if (code < 128) out += c;
    else if (code < 0x10000) out += `\\u${code > 32767 ? code - 65536 : code}?`;
    else {
      const hi = Math.floor((code - 0x10000) / 0x400) + 0xd800;
      const lo = ((code - 0x10000) % 0x400) + 0xdc00;
      out += `\\u${hi - 65536}?\\u${lo - 65536}?`;
    }
  }
  return out;
}

// Live DOM of the editor -> RTF, using computed styles like the .docx export.
export function htmlToRtf(root) {
  const colors = ['#000000'];
  const colorIndex = (rgb) => {
    const m = rgb.match(/\d+/g);
    if (!m) return 0;
    const key = m.slice(0, 3).join(',');
    if (key === '29,33,37' || key === '0,0,0') return 0;
    let idx = colors.indexOf(key);
    if (idx < 0) { colors.push(key); idx = colors.length - 1; }
    return idx;
  };
  const BLOCK = /^(P|DIV|H[1-6]|LI|BLOCKQUOTE|TR|PRE)$/;
  const body = [];
  let line = '';
  const flush = (el) => {
    const cs = el ? getComputedStyle(el) : null;
    const q = { center: '\\qc', right: '\\qr', justify: '\\qj' }[cs?.textAlign] || '\\ql';
    const prefix = el?.tagName === 'LI' ? (el.parentElement?.tagName === 'OL' ? `${[...el.parentElement.children].indexOf(el) + 1}.\\tab ` : '\\bullet\\tab ') : '';
    body.push(`\\pard${q}\\sa120 ${prefix}${line}\\par`);
    line = '';
  };
  const walk = (node) => {
    if (node.nodeType === 3) {
      const text = node.nodeValue.replace(/\s+/g, ' ');
      if (!text) return;
      const cs = getComputedStyle(node.parentElement);
      let deco = '';
      for (let el = node.parentElement; el && el !== root.parentElement; el = el.parentElement) deco += getComputedStyle(el).textDecorationLine;
      const fmt = [
        Number(cs.fontWeight) >= 600 ? '\\b' : '\\b0',
        cs.fontStyle === 'italic' ? '\\i' : '\\i0',
        deco.includes('underline') ? '\\ul' : '\\ulnone',
        deco.includes('line-through') ? '\\strike' : '\\strike0',
        `\\fs${Math.round(parseFloat(cs.fontSize) * 0.75 * 2)}`,
        `\\cf${colorIndex(cs.color)}`,
      ].join('');
      line += `{${fmt} ${rtfEscape(text)}}`;
      return;
    }
    if (node.nodeType !== 1) return;
    if (node.tagName === 'BR') { line += '\\line '; return; }
    if (node.tagName === 'TD' || node.tagName === 'TH') { node.childNodes.forEach(walk); line += '\\tab '; return; }
    const block = BLOCK.test(node.tagName) && ![...node.children].some((c) => BLOCK.test(c.tagName) || c.tagName === 'UL' || c.tagName === 'OL');
    node.childNodes.forEach(walk);
    if (block) flush(node);
  };
  root.childNodes.forEach(walk);
  if (line) flush(null);
  const colortbl = `{\\colortbl;${colors.slice(1).map((c) => { const [r, g, b] = c.split(','); return `\\red${r}\\green${g}\\blue${b};`; }).join('')}}`;
  return `{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\froman Georgia;}}${colortbl}\\f0\\fs24\n${body.join('\n')}\n}`;
}
