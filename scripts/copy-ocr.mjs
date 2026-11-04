// Copies the OCR engine (Tesseract) and its English language data into
// public/ocr, so they ship inside the app and nothing is downloaded later.
import { mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const out = 'public/ocr';
mkdirSync(out, { recursive: true });
const cores = ['tesseract-core-simd-lstm', 'tesseract-core-lstm'];
const files = [
  ['node_modules/tesseract.js/dist/worker.min.js', 'worker.min.js'],
  ...cores.flatMap((n) => [[`node_modules/tesseract.js-core/${n}.js`, `${n}.js`], [`node_modules/tesseract.js-core/${n}.wasm`, `${n}.wasm`]]),
];
for (const [from, to] of files) copyFileSync(from, `${out}/${to}`);
// The language data ships unpacked: some web servers mark .gz files as
// compressed, the browser then unpacks them on the way in, and the OCR
// engine would fail to unpack them a second time.
writeFileSync(`${out}/eng.traineddata`, gunzipSync(readFileSync('node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz')));
rmSync(`${out}/eng.traineddata.gz`, { force: true });
console.log(`OCR files copied to ${out}`);
