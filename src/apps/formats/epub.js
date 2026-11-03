// EPUB e-books -> one long HTML document for the Docs editor.

import { escapeHtml } from '../../ui.js';

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' };

const resolve = (base, href) => new URL(href, `http://x/${base}`).pathname.slice(1).split('#')[0];

export async function epubToHtml(bytes) {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(bytes);
  const xml = async (path) => {
    const f = zip.file(decodeURIComponent(path));
    return f ? new DOMParser().parseFromString(await f.async('text'), 'application/xml') : null;
  };
  const container = await xml('META-INF/container.xml');
  const opfPath = container?.getElementsByTagName('rootfile')[0]?.getAttribute('full-path');
  const opf = opfPath && await xml(opfPath);
  if (!opf) throw new Error('This e-book could not be read');

  const manifest = {};
  for (const item of opf.getElementsByTagName('item')) manifest[item.getAttribute('id')] = item.getAttribute('href');
  const spine = [...opf.getElementsByTagName('itemref')].map((r) => manifest[r.getAttribute('idref')]).filter(Boolean);
  const title = opf.getElementsByTagName('dc:title')[0]?.textContent;

  const chapters = [];
  for (const href of spine) {
    const path = resolve(opfPath, href);
    const file = zip.file(decodeURIComponent(path));
    if (!file) continue;
    // Chapters are XHTML: read them as XML first (self-closing <script/> tags
    // would otherwise swallow the page), and fall back to HTML for sloppy files.
    const source = await file.async('text');
    let doc = new DOMParser().parseFromString(source, 'application/xhtml+xml');
    if (doc.querySelector('parsererror') || !doc.body) doc = new DOMParser().parseFromString(source, 'text/html');
    doc.querySelectorAll('script, style, link').forEach((n) => n.remove());
    for (const img of doc.querySelectorAll('img, image')) {
      const src = img.getAttribute('src') || img.getAttribute('xlink:href') || img.getAttribute('href');
      const target = src && zip.file(decodeURIComponent(resolve(path, src)));
      const mime = target && MIME[src.split('.').pop().toLowerCase()];
      if (mime) {
        const out = doc.createElement('img');
        out.src = `data:${mime};base64,${await target.async('base64')}`;
        img.replaceWith(out);
      } else {
        img.remove();
      }
    }
    chapters.push(doc.body?.innerHTML || '');
  }
  if (!chapters.length) throw new Error('This e-book has no readable chapters');
  return (title ? `<h1>${escapeHtml(title)}</h1>` : '') + chapters.join('<hr>');
}
