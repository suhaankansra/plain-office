// Draw a PDF page into a canvas with a solid white background.
//
// pdf.js may reset the canvas it is given and leave the parts it does not
// paint transparent. On screen that is hidden by the page's white CSS
// background, but saved as JPEG (redaction, smaller files, pictures) or read
// by OCR, transparent comes out black. So we render into a scratch canvas and
// lay it over white.
export async function renderOnWhite(page, viewport) {
  const width = Math.max(1, Math.floor(viewport.width));
  const height = Math.max(1, Math.floor(viewport.height));
  const scratch = document.createElement('canvas');
  scratch.width = width;
  scratch.height = height;
  await page.render({ canvas: scratch, canvasContext: scratch.getContext('2d'), viewport }).promise;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(scratch, 0, 0);
  scratch.width = scratch.height = 0;
  return canvas;
}
