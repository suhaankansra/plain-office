// On-device text recognition (OCR) with Tesseract. The engine and the
// English language data ship inside the app (see scripts/copy-ocr.mjs), so
// pictures never leave the phone.

let workerPromise = null;
let idleTimer = null;
let onProgress = null;

async function worker() {
  clearTimeout(idleTimer);
  workerPromise ??= (async () => {
    const [{ createWorker, OEM }, { simd }] = await Promise.all([import('tesseract.js'), import('wasm-feature-detect')]);
    const base = new URL('ocr/', document.baseURI).href;
    // Newer phones get the faster SIMD build; older ones the plain build.
    const core = (await simd()) ? 'tesseract-core-simd-lstm.js' : 'tesseract-core-lstm.js';
    return createWorker('eng', OEM.LSTM_ONLY, {
      workerPath: `${base}worker.min.js`,
      corePath: `${base}${core}`,
      langPath: base.replace(/\/$/, ''),
      workerBlobURL: false,
      cacheMethod: 'none',
      gzip: true,
      logger: (m) => { if (m.status === 'recognizing text') onProgress?.(m.progress); },
    });
  })();
  workerPromise.catch(() => { workerPromise = null; });
  return workerPromise;
}

// The engine uses a lot of memory, so let it go when it hasn't been used for a bit.
function releaseLater() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    const pending = workerPromise;
    workerPromise = null;
    try { await (await pending)?.terminate(); } catch { /* already gone */ }
  }, 45000);
}

// image: canvas, <img>, Blob or data URL.
// Returns { text, paragraphs: [string], words: [{ text, x0, y0, x1, y1, confidence }] } in image pixels.
export async function recognize(image, progress) {
  const w = await worker();
  onProgress = progress;
  try {
    const { data } = await w.recognize(image, {}, { text: true, blocks: true });
    const paragraphs = [];
    const words = [];
    for (const block of data.blocks || []) {
      for (const para of block.paragraphs || []) {
        paragraphs.push(para.lines.map((l) => l.text.trim()).filter(Boolean).join('\n'));
        for (const line of para.lines) {
          for (const word of line.words) {
            if (word.text.trim() && word.confidence > 30) words.push({ text: word.text.trim(), ...word.bbox, confidence: word.confidence });
          }
        }
      }
    }
    return { text: data.text || '', paragraphs: paragraphs.filter(Boolean), words };
  } finally {
    onProgress = null;
    releaseLater();
  }
}

// Recognised words (image pixels) -> invisible text boxes in PDF points.
// toPdf(x, y) maps an image pixel to page coordinates; rot is the display rotation.
export function wordsToPdf(words, toPdf, scale, rot = 0) {
  return words.map((w) => {
    const [x, y] = toPdf(w.x0, w.y1);
    return { t: w.text, x, y, w: (w.x1 - w.x0) * scale, h: (w.y1 - w.y0) * scale, rot };
  });
}
