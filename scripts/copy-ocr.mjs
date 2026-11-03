// Copies the OCR engine (Tesseract) and its English language data into
// public/ocr, so they ship inside the app and nothing is downloaded later.
import { mkdirSync, copyFileSync } from 'node:fs';

const out = 'public/ocr';
mkdirSync(out, { recursive: true });
const cores = ['tesseract-core-simd-lstm', 'tesseract-core-lstm'];
const files = [
  ['node_modules/tesseract.js/dist/worker.min.js', 'worker.min.js'],
  ...cores.flatMap((n) => [[`node_modules/tesseract.js-core/${n}.js`, `${n}.js`], [`node_modules/tesseract.js-core/${n}.wasm`, `${n}.wasm`]]),
  ['node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', 'eng.traineddata.gz'],
];
for (const [from, to] of files) copyFileSync(from, `${out}/${to}`);
console.log(`OCR files copied to ${out}`);
