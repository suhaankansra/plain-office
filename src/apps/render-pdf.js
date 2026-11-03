// Turns on-screen content into a PDF by drawing it as a picture. This works
// for any language or font, which a text-based export can't promise.

import html2canvas from 'html2canvas';
import { jsPDF } from 'jspdf';

const A4 = { w: 595.28, h: 841.89 }; // points

function isBlankRow(ctx, y, width) {
  const row = ctx.getImageData(0, y, width, 1).data;
  for (let i = 0; i < row.length; i += 16) {
    if (row[i] < 245 || row[i + 1] < 245 || row[i + 2] < 245) return false;
  }
  return true;
}

// Long document -> A4 pages. Page breaks are nudged up to a blank row so a
// line of text is not cut in half.
export async function documentToPdf(element, { contentWidth = 680, margin = 48 } = {}) {
  const host = document.createElement('div');
  Object.assign(host.style, { position: 'fixed', left: '-10000px', top: '0', width: `${contentWidth}px`, background: '#fff' });
  const clone = element.cloneNode(true);
  clone.removeAttribute('contenteditable');
  Object.assign(clone.style, { margin: '0', padding: '0', minHeight: '0', boxShadow: 'none', maxWidth: 'none', width: `${contentWidth}px` });
  host.append(clone);
  document.body.append(host);
  try {
    const scale = 2;
    const canvas = await html2canvas(clone, { scale, backgroundColor: '#ffffff', logging: false });
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
    const usableW = A4.w - margin * 2;
    const ptPerPx = usableW / canvas.width;
    const pageHeightPx = Math.floor((A4.h - margin * 2) / ptPerPx);
    let top = 0;
    let first = true;
    while (top < canvas.height) {
      let bottom = Math.min(top + pageHeightPx, canvas.height);
      if (bottom < canvas.height) {
        for (let y = bottom; y > bottom - pageHeightPx * 0.2; y -= 2) {
          if (isBlankRow(ctx, y, canvas.width)) { bottom = y; break; }
        }
      }
      const slice = document.createElement('canvas');
      slice.width = canvas.width;
      slice.height = bottom - top;
      slice.getContext('2d').drawImage(canvas, 0, top, canvas.width, slice.height, 0, 0, canvas.width, slice.height);
      if (!first) pdf.addPage();
      first = false;
      pdf.addImage(slice.toDataURL('image/jpeg', 0.92), 'JPEG', margin, margin, usableW, slice.height * ptPerPx);
      top = bottom;
    }
    return pdf.output('blob');
  } finally {
    host.remove();
  }
}

// One element per page, e.g. presentation slides (16:9 landscape pages).
export async function elementsToPdf(elements, width = 960, height = 540) {
  const pdf = new jsPDF({ unit: 'pt', format: [width * 0.75, height * 0.75], orientation: 'landscape' });
  for (let i = 0; i < elements.length; i++) {
    const canvas = await html2canvas(elements[i], { scale: 2, backgroundColor: null, logging: false, width, height });
    if (i > 0) pdf.addPage([width * 0.75, height * 0.75], 'landscape');
    pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, width * 0.75, height * 0.75);
  }
  return pdf.output('blob');
}
