// PDF -> editable document (HTML for the Docs editor). Used by "PDF to Word",
// "PDF to Pages" and "Edit as document".
//
// A PDF only knows where each piece of text is drawn, so we rebuild the
// structure: pieces on the same baseline become lines, nearby lines become
// paragraphs, bigger text becomes headings, bullets become lists. Pictures
// are kept in reading order, and scanned pages are read with OCR.

import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { escapeHtml } from '../../ui.js';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const BULLET = /^[•▪◦●○■□➢►▸‣⁃]\s*|^[–\-*]\s+/;
// A first piece on its own that is just a bullet or a number is a list marker, even with no space after it.
const MARKER = /^([•▪◦●○■□➢►▸‣⁃–\-*]|\d{1,3}[.)]?|[a-z][.)])$/;
const NUMBERED = /^(\d{1,3}|[a-zA-Z]|[ivxIVX]{1,4})[.)]\s+/;
const median = (values) => {
  const v = [...values].sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : 12;
};

function fontStyle(page, fontName) {
  let name = '';
  try { name = page.commonObjs.has(fontName) ? page.commonObjs.get(fontName)?.name || '' : ''; } catch { /* not loaded */ }
  return { bold: /bold|black|heavy|semibold|demi/i.test(name), italic: /italic|oblique/i.test(name) };
}

// ---------- Text -> lines -> paragraphs ----------
function buildLines(page, items, vp) {
  const pieces = [];
  for (const it of items) {
    if (!it.str) continue;
    const [x, y] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
    const size = Math.hypot(it.transform[2], it.transform[3]) || 10;
    pieces.push({ text: it.str, x, y, size, width: it.width, ...fontStyle(page, it.fontName) });
  }
  pieces.sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const p of pieces) {
    const line = lines.find((l) => Math.abs(l.y - p.y) < Math.min(l.size, p.size) * 0.45);
    if (line) { line.pieces.push(p); line.size = Math.max(line.size, p.size); } else lines.push({ y: p.y, size: p.size, pieces: [p] });
  }
  for (const line of lines) {
    line.pieces.sort((a, b) => a.x - b.x);
    line.x = line.pieces[0].x;
    const last = line.pieces.at(-1);
    line.right = last.x + last.width;
    // Join pieces, adding a space where there's a visible gap.
    line.runs = [];
    let prevEnd = null;
    for (const p of line.pieces) {
      let text = p.text;
      if (prevEnd !== null && p.x - prevEnd > p.size * 0.2 && !/\s$/.test(line.runs.at(-1)?.text || '') && !/^\s/.test(text)) text = ` ${text}`;
      const run = line.runs.at(-1);
      if (run && run.bold === p.bold && run.italic === p.italic) run.text += text;
      else line.runs.push({ text, bold: p.bold, italic: p.italic });
      prevEnd = p.x + p.width;
    }
    line.text = line.runs.map((r) => r.text).join('');
    const first = line.pieces[0].text.trim();
    if (line.pieces.length > 1 && MARKER.test(first)) line.marker = /^\d/.test(first) || /^[a-z][.)]$/.test(first) ? 'ol' : 'ul';
  }
  return lines.filter((l) => l.text.trim()).sort((a, b) => a.y - b.y);
}

function buildParagraphs(lines, vp) {
  const paras = [];
  const typicalWidth = Math.max(...lines.map((l) => l.right - l.x), 1);
  for (const line of lines) {
    const prev = paras.at(-1);
    const last = prev?.lines.at(-1);
    const text = line.text.trim();
    const startsItem = line.marker || BULLET.test(text) || NUMBERED.test(text);
    const breakHere = !prev
      || startsItem
      || Math.abs(line.size - last.size) > last.size * 0.15
      || line.y - last.y > Math.max(line.size, last.size) * 1.75
      || line.x > prev.left + line.size * 1.5
      || (last.right - last.x < typicalWidth * 0.66 && !/[,;:\-–]$/.test(last.text.trim()));
    if (breakHere) paras.push({ lines: [line], left: line.x, top: line.y - line.size, size: line.size });
    else prev.lines.push(line);
  }
  for (const p of paras) {
    p.right = Math.max(...p.lines.map((l) => l.right));
    p.bottom = p.lines.at(-1).y;
    const center = vp.width / 2;
    p.centered = p.lines.every((l) => Math.abs((l.x + l.right) / 2 - center) < vp.width * 0.04 && l.right - l.x < vp.width * 0.8)
      && p.left > vp.width * 0.15;
    p.bold = p.lines.every((l) => l.runs.every((r) => r.bold || !r.text.trim()));
    p.chars = p.lines.reduce((n, l) => n + l.text.length, 0);
  }
  return paras;
}

function paragraphHtml(p) {
  const runs = [];
  p.lines.forEach((line, i) => {
    line.runs.forEach((r, j) => {
      let text = r.text;
      if (j === 0 && i > 0) {
        const prevText = runs.at(-1)?.text || '';
        if (/[a-zà-ÿ]-$/.test(prevText) && /^[a-zà-ÿ]/.test(text)) runs.at(-1).text = prevText.slice(0, -1); // re-join hyphenated words
        else if (!/\s$/.test(prevText)) text = ` ${text}`;
      }
      const prev = runs.at(-1);
      if (prev && prev.bold === r.bold && prev.italic === r.italic) prev.text += text;
      else runs.push({ ...r, text });
    });
  });
  return runs.map((r) => {
    let html = escapeHtml(r.text);
    if (r.italic) html = `<i>${html}</i>`;
    if (r.bold) html = `<b>${html}</b>`;
    return html;
  }).join('').trim();
}

// ---------- Pictures ----------
const OPS = pdfjs.OPS;
const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];

function getObj(page, id) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 3000);
    try {
      page.objs.get(id, (obj) => { clearTimeout(timer); resolve(obj); });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

function imageToDataUrl(img) {
  if (!img?.width || !img?.height) return null;
  const canvas = document.createElement('canvas');
  const k = Math.min(1, 1600 / Math.max(img.width, img.height));
  canvas.width = Math.round(img.width * k);
  canvas.height = Math.round(img.height * k);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (img.bitmap) {
    ctx.drawImage(img.bitmap, 0, 0, canvas.width, canvas.height);
  } else if (img.data) {
    const full = document.createElement('canvas');
    full.width = img.width;
    full.height = img.height;
    const fctx = full.getContext('2d');
    const out = fctx.createImageData(img.width, img.height);
    const src = img.data;
    const n = img.width * img.height;
    const channels = src.length / n;
    if (channels !== 3 && channels !== 4) return null;
    for (let i = 0; i < n; i++) {
      out.data[i * 4] = src[i * channels];
      out.data[i * 4 + 1] = src[i * channels + 1];
      out.data[i * 4 + 2] = src[i * channels + 2];
      out.data[i * 4 + 3] = channels === 4 ? src[i * 4 + 3] : 255;
    }
    fctx.putImageData(out, 0, 0);
    ctx.drawImage(full, 0, 0, canvas.width, canvas.height);
  } else {
    return null;
  }
  return canvas.toDataURL('image/jpeg', 0.85);
}

async function pageImages(page, opList, vp) {
  const images = [];
  const stack = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    const args = opList.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || ctm;
    else if (fn === OPS.transform) ctm = mul(ctm, args);
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
      const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => vp.convertToViewportPoint(ctm[0] * u + ctm[2] * v + ctm[4], ctm[1] * u + ctm[3] * v + ctm[5]));
      const top = Math.min(...corners.map((c) => c[1]));
      const width = Math.max(...corners.map((c) => c[0])) - Math.min(...corners.map((c) => c[0]));
      const height = Math.max(...corners.map((c) => c[1])) - top;
      if (width < 40 || height < 40) continue; // icons, rules and other decoration
      const img = fn === OPS.paintImageXObject ? await getObj(page, args[0]) : args[0];
      const src = imageToDataUrl(img);
      if (src) images.push({ top, width, height, src });
    }
  }
  return images;
}

// ---------- OCR for scanned pages ----------
async function ocrPage(page, onProgress) {
  const { recognize } = await import('../../ocr.js');
  const vp = page.getViewport({ scale: 2000 / Math.max(page.view[2] - page.view[0], page.view[3] - page.view[1]) });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport: vp }).promise;
  const r = await recognize(canvas, onProgress);
  return r.paragraphs.map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
}

// ---------- Whole document ----------
export async function pdfToHtml(bytes, { onProgress = () => {}, password } = {}) {
  // fontExtraProperties keeps font names, which tell us what is bold or italic.
  const pdf = await pdfjs.getDocument({ data: bytes.slice(), password, isEvalSupported: false, fontExtraProperties: true }).promise;
  try {
    const pages = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      onProgress(`Reading page ${n} of ${pdf.numPages}…`);
      const page = await pdf.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const opList = await page.getOperatorList(); // also loads the fonts we check for bold/italic
      const content = await page.getTextContent();
      const lines = buildLines(page, content.items, vp)
        // Drop bare page numbers at the very top or bottom.
        .filter((l) => !(/^(page\s*)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?$/i.test(l.text.trim()) && (l.y < vp.height * 0.08 || l.y > vp.height * 0.92)));
      const chars = lines.reduce((s, l) => s + l.text.trim().length, 0);
      let images = await pageImages(page, opList, vp);
      if (chars < 15) {
        // A scan: read the text from the picture instead of keeping the picture.
        const ocrHtml = await ocrPage(page, (v) => onProgress(`Reading text on page ${n} of ${pdf.numPages}… ${Math.round(v * 100)}%`));
        pages.push({ ocrHtml, paras: [], images: ocrHtml ? [] : images, vp });
        continue;
      }
      // A full-page picture under real text is a scan with a text layer: keep just the text.
      images = images.filter((img) => img.width * img.height < vp.width * vp.height * 0.8);
      pages.push({ paras: buildParagraphs(lines, vp), images, vp });
      page.cleanup();
    }

    // Body text size = the size most of the text uses; headings are bigger.
    const sizes = pages.flatMap((p) => p.paras.flatMap((para) => Array(Math.min(para.chars, 400)).fill(Math.round(para.size * 2) / 2)));
    const body = median(sizes);
    const out = [];
    let listTag = null;
    let listCount = 0;
    let carry = 0; // a numbered list that continues onto the next page keeps counting
    const closeList = () => { if (listTag) { out.push(`</${listTag}>`); listTag = null; } };
    pages.forEach((pg, i) => {
      if (i > 0) {
        carry = listTag === 'ol' ? listCount : 0;
        closeList();
        out.push('<p data-page-break="true"><br></p>');
      }
      if (pg.ocrHtml !== undefined) { out.push(pg.ocrHtml); return; }
      const blocks = [...pg.paras.map((p) => ({ top: p.top, para: p })), ...pg.images.map((img) => ({ top: img.top, img }))].sort((a, b) => a.top - b.top);
      for (const block of blocks) {
        if (block.img) {
          closeList();
          out.push(`<p><img src="${block.img.src}" alt="" style="width:${Math.round(Math.min(block.img.width * 1.33, 620))}px"></p>`);
          continue;
        }
        const p = block.para;
        let html = paragraphHtml(p);
        if (!html) continue;
        const plain = p.lines.map((l) => l.text).join(' ').trim();
        const marker = p.lines[0].marker;
        const item = marker || (BULLET.test(plain) ? 'ul' : NUMBERED.test(plain) ? 'ol' : null);
        if (item) {
          const markerText = marker ? p.lines[0].pieces[0].text.trim() : null;
          html = markerText
            ? html.replace(new RegExp(`^((?:<[bi]>)*)${markerText.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}\\s*`), '$1')
            : html.replace(item === 'ul' ? /^(<[bi]>)*([•▪◦●○■□➢►▸‣⁃]\s*|[–\-*]\s+)/ : /^(<[bi]>)*(\d{1,3}|[a-zA-Z]|[ivxIVX]{1,4})[.)]\s+/, '$1');
          if (listTag !== item) {
            closeList();
            listCount = item === 'ol' ? carry : 0;
            out.push(item === 'ol' && carry ? `<ol start="${carry + 1}">` : `<${item}>`);
            listTag = item;
          }
          carry = 0;
          listCount++;
          out.push(`<li>${html}</li>`);
          continue;
        }
        carry = 0;
        closeList();
        const short = p.chars < 160 && p.lines.length <= 3;
        let tag = 'p';
        if (short && p.size >= body * 1.8) tag = 'h1';
        else if (short && p.size >= body * 1.35) tag = 'h2';
        else if (short && (p.size >= body * 1.15 || (p.bold && p.chars < 80 && p.lines.length === 1 && !/[.,;:]$/.test(plain)))) tag = 'h3';
        if (tag !== 'p') html = html.replace(/<\/?b>/g, '');
        out.push(`<${tag}${p.centered ? ' style="text-align:center"' : ''}>${html}</${tag}>`);
      }
    });
    closeList();
    return out.join('');
  } finally {
    pdf.loadingTask.destroy();
  }
}
