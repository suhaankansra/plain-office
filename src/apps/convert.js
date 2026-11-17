// Conversions between formats: PDF -> Word / Pages / Keynote / an editable
// document, PowerPoint -> Keynote, and editor HTML -> Pages.

import { h, progressBox, askText } from '../ui.js';
import { exportFile } from '../files.js';
import { saveDoc, newId } from '../store.js';

async function pagesTemplate() {
  const res = await fetch(new URL('templates/blank.pages', document.baseURI));
  if (!res.ok) throw new Error('The Pages template is missing from the app');
  return new Uint8Array(await res.arrayBuffer());
}

export async function htmlToPagesBlob(html) {
  const { paragraphsToPages, htmlToParagraphs } = await import('./formats/pages-writer.js');
  const bytes = await paragraphsToPages(htmlToParagraphs(html), await pagesTemplate());
  return new Blob([bytes], { type: 'application/vnd.apple.pages' });
}

// The Word export reads the live, styled page, so lay the content out off screen first.
export async function htmlToDocxBlob(html) {
  const page = h('div', { class: 'doc-page', html });
  const host = h('div', { style: { position: 'fixed', left: '-10000px', top: '0', width: '816px' } }, page);
  document.body.append(host);
  try {
    await Promise.all([...page.querySelectorAll('img')].map((img) => img.decode().catch(() => {})));
    const { htmlToDocx } = await import('./docx-export.js');
    return await htmlToDocx(page);
  } finally {
    host.remove();
  }
}

// Keynote: every page (or slide) becomes a picture on its own slide.
export async function pdfToKeynoteBlob(bytes, onProgress) {
  const { pdfToSlidePictures } = await import('./formats/pdf-convert.js');
  const { picturesToKeynote } = await import('./formats/keynote-writer.js');
  let password;
  let pictures;
  for (;;) {
    try {
      pictures = await pdfToSlidePictures(bytes, { password, onProgress });
      break;
    } catch (err) {
      if (err?.name !== 'PasswordException') throw err;
      password = await askText(password ? 'Wrong password. Try again' : 'This PDF is locked. Enter its password', { ok: 'Open' });
      if (password == null) throw new Error('This PDF needs a password');
    }
  }
  onProgress?.('Writing the presentation…');
  const res = await fetch(new URL('templates/picture.key', document.baseURI));
  if (!res.ok) throw new Error('The Keynote template is missing from the app');
  const bytesOut = await picturesToKeynote(pictures, new Uint8Array(await res.arrayBuffer()));
  return new Blob([bytesOut], { type: 'application/vnd.apple.keynote' });
}

// PowerPoint (or any presentation Plain Office opens) -> Keynote.
export async function convertSlidesToKeynote(bytes, name, fileName) {
  const box = progressBox('Opening the presentation…');
  try {
    const { importFile, deckToPdf } = await import('./slides.js');
    const deck = await importFile(bytes, fileName);
    if (!deck?.slides?.length) throw new Error('No slides were found in this file');
    box.update(deck.slides.length > 1 ? `Drawing ${deck.slides.length} slides…` : 'Drawing the slide…');
    const pdf = new Uint8Array(await (await deckToPdf(deck)).arrayBuffer());
    const blob = await pdfToKeynoteBlob(pdf, (m) => box.update(m.replace('page', 'slide')));
    box.close();
    await exportFile(blob, `${name}.key`);
  } finally {
    box.close();
  }
}

async function readPdf(bytes, onProgress) {
  const { pdfToHtml } = await import('./formats/pdf-convert.js');
  let password;
  for (;;) {
    try {
      return await pdfToHtml(bytes, { onProgress, password });
    } catch (err) {
      if (err?.name !== 'PasswordException') throw err;
      password = await askText(password ? 'Wrong password. Try again' : 'This PDF is locked. Enter its password', { ok: 'Open' });
      if (password == null) throw new Error('This PDF needs a password');
    }
  }
}

// target: 'docx', 'pages' or 'key' saves/shares a file; 'doc' creates an
// editable document in the app and returns its id.
export async function convertPdf(bytes, name, target) {
  const box = progressBox('Opening the PDF…');
  try {
    if (target === 'key') {
      const blob = await pdfToKeynoteBlob(bytes, (m) => box.update(m));
      box.close();
      await exportFile(blob, `${name}.key`);
      return null;
    }
    const { sanitize } = await import('./docs.js');
    const html = sanitize(await readPdf(bytes, (message) => box.update(message)));
    if (!html.replace(/<[^>]+>/g, '').trim() && !/<img/.test(html)) throw new Error('No text or pictures were found in this PDF');
    box.update('Writing the file…');
    if (target === 'doc') {
      const doc = await saveDoc({ id: newId(), name, kind: 'doc', data: html, size: html.length });
      return doc.id;
    }
    const blob = target === 'pages' ? await htmlToPagesBlob(html) : await htmlToDocxBlob(html);
    box.close();
    await exportFile(blob, `${name}.${target}`);
    return null;
  } finally {
    box.close();
  }
}
