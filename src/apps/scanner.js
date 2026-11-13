// Document scanner: take photos of paper, straighten them, clean them up,
// and save the pages as a PDF. Everything runs on the phone.

import { h, icon, iconBtn, toast, busy, progressBox, actionSheet, confirmBox } from '../ui.js';
import { pickFiles } from '../files.js';

const MAX_SOURCE = 2400; // longest side we keep from the camera photo
const MAX_OUTPUT = 2200; // longest side of a finished page
const FILTERS = [['original', 'Original'], ['enhance', 'Enhanced'], ['grey', 'Grayscale'], ['bw', 'Black & white']];

// ---------- Image helpers ----------
async function loadPhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const k = Math.min(1, MAX_SOURCE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * k);
    canvas.height = Math.round(img.naturalHeight * k);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function rotate90(canvas) {
  const out = document.createElement('canvas');
  out.width = canvas.height;
  out.height = canvas.width;
  const ctx = out.getContext('2d');
  ctx.translate(out.width, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(canvas, 0, 0);
  return out;
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Find the page: the largest bright region, then its four extreme corners.
export function detectCorners(canvas) {
  const k = 240 / Math.max(canvas.width, canvas.height);
  const w = Math.max(1, Math.round(canvas.width * k));
  const hgt = Math.max(1, Math.round(canvas.height * k));
  const small = document.createElement('canvas');
  small.width = w;
  small.height = hgt;
  const ctx = small.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, w, hgt);
  const px = ctx.getImageData(0, 0, w, hgt).data;
  const grey = new Uint8Array(w * hgt);
  const hist = new Array(256).fill(0);
  for (let i = 0; i < grey.length; i++) {
    const v = (px[i * 4] * 0.299 + px[i * 4 + 1] * 0.587 + px[i * 4 + 2] * 0.114) | 0;
    grey[i] = v;
    hist[v]++;
  }
  // Otsu's threshold.
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = grey.length - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const between = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2;
    if (between > best) { best = between; threshold = t; }
  }
  // Largest connected bright region.
  const label = new Int32Array(w * hgt);
  let bestLabel = 0;
  let bestSize = 0;
  let next = 1;
  const stack = [];
  for (let start = 0; start < grey.length; start++) {
    if (label[start] || grey[start] <= threshold) continue;
    let size = 0;
    stack.push(start);
    label[start] = next;
    while (stack.length) {
      const i = stack.pop();
      size++;
      const x = i % w;
      const neighbours = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w];
      for (const n of neighbours) {
        if (n >= 0 && n < grey.length && !label[n] && grey[n] > threshold) { label[n] = next; stack.push(n); }
      }
    }
    if (size > bestSize) { bestSize = size; bestLabel = next; }
    next++;
  }
  const fallback = () => {
    const m = 0.04;
    return [[canvas.width * m, canvas.height * m], [canvas.width * (1 - m), canvas.height * m],
      [canvas.width * (1 - m), canvas.height * (1 - m)], [canvas.width * m, canvas.height * (1 - m)]];
  };
  const fraction = bestSize / grey.length;
  if (fraction < 0.12 || fraction > 0.97) return fallback();
  let tl, tr, br, bl;
  let [minS, maxS, minD, maxD] = [Infinity, -Infinity, Infinity, -Infinity];
  for (let i = 0; i < label.length; i++) {
    if (label[i] !== bestLabel) continue;
    const x = i % w;
    const y = (i / w) | 0;
    const s = x + y;
    const d = x - y;
    if (s < minS) { minS = s; tl = [x, y]; }
    if (s > maxS) { maxS = s; br = [x, y]; }
    if (d > maxD) { maxD = d; tr = [x, y]; }
    if (d < minD) { minD = d; bl = [x, y]; }
  }
  return [tl, tr, br, bl].map(([x, y]) => [(x + 0.5) / k, (y + 0.5) / k]);
}

// Solve the 8 unknowns of the projective transform from output rect to photo.
function homography(src, w, hgt) {
  const dst = [[0, 0], [w, 0], [w, hgt], [0, hgt]];
  const A = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = dst[i];
    const [x, y] = src[i];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x, x]);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y, y]);
  }
  for (let c = 0; c < 8; c++) {
    let pivot = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[pivot][c])) pivot = r;
    [A[c], A[pivot]] = [A[pivot], A[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
    }
  }
  return A.map((row, i) => row[8] / row[i]);
}

export function warp(source, corners) {
  const [tl, tr, br, bl] = corners;
  let w = Math.max(dist(tl, tr), dist(bl, br));
  let hgt = Math.max(dist(tl, bl), dist(tr, br));
  const k = Math.min(1, MAX_OUTPUT / Math.max(w, hgt));
  w = Math.max(1, Math.round(w * k));
  hgt = Math.max(1, Math.round(hgt * k));
  const [a, b, c, d, e, f, g, hh] = homography(corners, w, hgt);
  const sctx = source.getContext('2d', { willReadFrequently: true });
  const sw = source.width;
  const sh = source.height;
  const src = sctx.getImageData(0, 0, sw, sh).data;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = hgt;
  const octx = out.getContext('2d');
  const img = octx.createImageData(w, hgt);
  const o = img.data;
  for (let v = 0; v < hgt; v++) {
    for (let u = 0; u < w; u++) {
      const den = g * u + hh * v + 1;
      let x = (a * u + b * v + c) / den;
      let y = (d * u + e * v + f) / den;
      x = Math.min(Math.max(x, 0), sw - 1.001);
      y = Math.min(Math.max(y, 0), sh - 1.001);
      const x0 = x | 0;
      const y0 = y | 0;
      const fx = x - x0;
      const fy = y - y0;
      const i00 = (y0 * sw + x0) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + sw * 4;
      const i11 = i01 + 4;
      const oi = (v * w + u) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const top = src[i00 + ch] + (src[i10 + ch] - src[i00 + ch]) * fx;
        const bottom = src[i01 + ch] + (src[i11 + ch] - src[i01 + ch]) * fx;
        o[oi + ch] = top + (bottom - top) * fy;
      }
      o[oi + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

function stretch(values, lowPct = 0.01, highPct = 0.99) {
  const hist = new Array(256).fill(0);
  for (const v of values) hist[v]++;
  const total = values.length;
  let acc = 0;
  let lo = 0;
  let hi = 255;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= total * lowPct) { lo = i; break; } }
  acc = 0;
  for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= total * (1 - highPct)) { hi = i; break; } }
  const range = Math.max(1, hi - lo);
  return (v) => Math.max(0, Math.min(255, ((v - lo) * 255) / range));
}

export function applyFilter(canvas, filter) {
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height;
  const ctx = out.getContext('2d');
  ctx.drawImage(canvas, 0, 0);
  if (filter === 'original') return out;
  const img = ctx.getImageData(0, 0, out.width, out.height);
  const p = img.data;
  const n = out.width * out.height;
  if (filter === 'enhance') {
    // Per-channel auto levels: whitens paper and removes a colour cast.
    for (let ch = 0; ch < 3; ch++) {
      const vals = new Uint8Array(n);
      for (let i = 0; i < n; i++) vals[i] = p[i * 4 + ch];
      const map = stretch(vals, 0.02, 0.92);
      for (let i = 0; i < n; i++) p[i * 4 + ch] = map(vals[i]);
    }
  } else {
    const grey = new Uint8Array(n);
    for (let i = 0; i < n; i++) grey[i] = p[i * 4] * 0.299 + p[i * 4 + 1] * 0.587 + p[i * 4 + 2] * 0.114;
    if (filter === 'grey') {
      const map = stretch(grey, 0.02, 0.92);
      for (let i = 0; i < n; i++) { const v = map(grey[i]); p[i * 4] = p[i * 4 + 1] = p[i * 4 + 2] = v; }
    } else {
      // Adaptive threshold (Bradley): crisp text even with uneven lighting.
      const w = out.width;
      const hgt = out.height;
      const integral = new Float64Array((w + 1) * (hgt + 1));
      for (let y = 0; y < hgt; y++) {
        let row = 0;
        for (let x = 0; x < w; x++) {
          row += grey[y * w + x];
          integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1] + row;
        }
      }
      const half = Math.max(4, Math.round(Math.max(w, hgt) / 32));
      for (let y = 0; y < hgt; y++) {
        const y1 = Math.max(0, y - half);
        const y2 = Math.min(hgt, y + half + 1);
        for (let x = 0; x < w; x++) {
          const x1 = Math.max(0, x - half);
          const x2 = Math.min(w, x + half + 1);
          const area = (x2 - x1) * (y2 - y1);
          const total = integral[y2 * (w + 1) + x2] - integral[y1 * (w + 1) + x2] - integral[y2 * (w + 1) + x1] + integral[y1 * (w + 1) + x1];
          const v = grey[y * w + x] * area < total * 0.86 ? 0 : 255;
          const i = (y * w + x) * 4;
          p[i] = p[i + 1] = p[i + 2] = v;
        }
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

// ---------- Screen ----------
// Resolves with [{ url, words }] (one per page; words when OCR ran), or null if cancelled.
export function scan() {
  return new Promise((resolve) => {
    const pages = [];
    let searchable = true;
    let source = null;
    let corners = null;
    let result = null;
    let filter = 'enhance';

    const title = h('span', {}, 'Scan');
    const sub = h('small', {}, '');
    // The top-right button is always the current step's main action.
    let primaryAction = finish;
    const primary = h('button', { class: 'btn primary', style: { marginRight: '6px' }, onClick: () => primaryAction() }, 'Save PDF');
    const setPrimary = (label, action) => { primary.textContent = label; primaryAction = action; refreshBar(); };
    const bar = h('header', { class: 'topbar', 'data-kind': 'pdf' }, iconBtn('back', 'Cancel scan', cancel), h('div', { class: 'title' }, title, sub), primary);
    const stage = h('div', { class: 'scan-stage' });
    const toolbar = h('nav', { class: 'toolbar scan-tools' });
    const view = h('div', { class: 'scan-view' }, bar, stage, toolbar);
    document.body.append(view);
    view.dismiss = cancel;

    const refreshBar = () => {
      sub.textContent = pages.length ? `${pages.length} page${pages.length === 1 ? '' : 's'}` : '';
      const ready = primaryAction !== finish || pages.length > 0;
      primary.disabled = !ready;
      primary.style.opacity = ready ? '1' : '0.4';
    };
    const textBtn = (iconName, label, onClick) => h('button', { class: 'tb-text', onClick }, icon(iconName), label);

    async function capture(fromLibrary) {
      const files = await pickFiles('image/*', fromLibrary, fromLibrary ? null : 'environment');
      if (!files.length) { if (!pages.length && !source) close(null); return; }
      await busy('Finding the page…', async () => {
        for (const [i, file] of files.entries()) {
          const canvas = await loadPhoto(file);
          if (i < files.length - 1) {
            // Several photos picked at once: auto-crop the extra ones straight away.
            pages.push(applyFilter(warp(canvas, detectCorners(canvas)), filter).toDataURL('image/jpeg', 0.85));
          } else {
            source = canvas;
            corners = detectCorners(canvas);
          }
        }
      });
      refreshBar();
      showCrop();
    }

    async function addPage() {
      const choice = await actionSheet('Add a page', [
        { icon: 'image', label: 'Take a photo', value: 'camera' },
        { icon: 'folder', label: 'Choose from photos', value: 'library' },
      ]);
      if (choice) capture(choice === 'library');
      else if (!pages.length && !source) close(null);
    }

    // Step 1: drag the corners onto the page edges.
    function showCrop() {
      title.textContent = 'Adjust the corners';
      setPrimary('Next', () => busy('Straightening…', async () => { result = warp(source, corners); showFilter(); }));
      const fit = () => {
        const maxW = stage.clientWidth - 32;
        const maxH = stage.clientHeight - 32;
        return Math.min(maxW / source.width, maxH / source.height);
      };
      const k = fit();
      const disp = source;
      disp.className = 'scan-img';
      disp.style.width = `${source.width * k}px`;
      disp.style.height = `${source.height * k}px`;
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'scan-overlay');
      svg.setAttribute('viewBox', `0 0 ${source.width} ${source.height}`);
      const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      poly.setAttribute('class', 'scan-poly');
      svg.append(poly);
      const handles = corners.map((_, i) => {
        const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        c.setAttribute('r', 16 / k);
        c.setAttribute('class', 'scan-handle');
        c.dataset.i = i;
        svg.append(c);
        return c;
      });
      const draw = () => {
        poly.setAttribute('points', corners.map((p) => p.join(',')).join(' '));
        handles.forEach((c, i) => { c.setAttribute('cx', corners[i][0]); c.setAttribute('cy', corners[i][1]); });
      };
      draw();
      let dragging = null;
      svg.addEventListener('pointerdown', (e) => {
        const rect = svg.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * source.width;
        const y = ((e.clientY - rect.top) / rect.height) * source.height;
        // Grab the nearest corner within a generous finger-sized radius.
        let best = -1;
        let bestD = 48 / k;
        corners.forEach((p, i) => { const dd = Math.hypot(p[0] - x, p[1] - y); if (dd < bestD) { bestD = dd; best = i; } });
        if (best < 0) return;
        dragging = best;
        svg.setPointerCapture(e.pointerId);
        e.preventDefault();
      });
      svg.addEventListener('pointermove', (e) => {
        if (dragging === null) return;
        const rect = svg.getBoundingClientRect();
        corners[dragging] = [
          Math.min(Math.max(((e.clientX - rect.left) / rect.width) * source.width, 0), source.width),
          Math.min(Math.max(((e.clientY - rect.top) / rect.height) * source.height, 0), source.height),
        ];
        draw();
      });
      svg.addEventListener('pointerup', () => { dragging = null; });
      stage.replaceChildren(h('div', { class: 'scan-wrap' }, disp, svg));
      toolbar.replaceChildren(
        textBtn('x', 'Retake', () => { source = null; capture(false); }),
        textBtn('rotate', 'Rotate', () => {
          const oldH = source.height;
          source = rotate90(source);
          corners = corners.map(([x, y]) => [oldH - y, x]);
          corners = [corners[3], corners[0], corners[1], corners[2]];
          showCrop();
        }),
        textBtn('square', 'Auto', () => { corners = detectCorners(source); draw(); }),
        textBtn('pages', 'Whole', () => { corners = [[0, 0], [source.width, 0], [source.width, source.height], [0, source.height]]; draw(); }),
      );
    }

    // Step 2: pick a look for the page.
    function showFilter() {
      title.textContent = 'Choose a look';
      const preview = applyFilter(result, filter);
      preview.className = 'scan-img';
      const k = Math.min((stage.clientWidth - 32) / preview.width, (stage.clientHeight - 32) / preview.height);
      preview.style.width = `${preview.width * k}px`;
      preview.style.height = `${preview.height * k}px`;
      stage.replaceChildren(preview);
      toolbar.replaceChildren(
        textBtn('left', 'Corners', showCrop),
        ...FILTERS.map(([key, label]) => h('button', {
          class: `chip${filter === key ? ' on' : ''}`,
          style: { flex: 'none', marginRight: '6px' },
          onClick: () => busy('Applying…', async () => { filter = key; showFilter(); }),
        }, label)),
      );
      setPrimary('Keep', () => {
        pages.push(preview.toDataURL('image/jpeg', 0.85));
        source = null;
        result = null;
        showPages();
      });
    }

    // Step 3: the pages so far.
    function showPages() {
      title.textContent = 'Scanned pages';
      setPrimary('Save PDF', finish);
      const grid = h('div', { class: 'scan-pages' }, pages.map((url, i) => h('div', { class: 'page-card' },
        h('div', { class: 'pv' }, h('img', { src: url, alt: `Page ${i + 1}` })),
        h('div', { class: 'acts' },
          iconBtn('left', 'Move earlier', () => { [pages[i - 1], pages[i]] = [pages[i], pages[i - 1]]; showPages(); }, { disabled: i === 0 }),
          h('span', { class: 'lbl' }, `Page ${i + 1}`),
          iconBtn('trash', 'Delete page', () => { pages.splice(i, 1); refreshBar(); showPages(); })))));
      stage.replaceChildren(pages.length ? grid : h('div', { class: 'empty', style: { color: '#ccc' } }, 'No pages yet.'));
      const ocrToggle = h('button', {
        class: `tb-text${searchable ? ' on' : ''}`,
        'aria-pressed': String(searchable),
        onClick: () => { searchable = !searchable; showPages(); toast(searchable ? 'The PDF will be searchable' : 'Text recognition off'); },
      }, icon(searchable ? 'check' : 'square'), 'Searchable text');
      toolbar.replaceChildren(textBtn('plus', 'Add page', addPage), ocrToggle);
    }

    async function cancel() {
      if ((pages.length || source) && !(await confirmBox('Discard this scan?', 'The pages you scanned will be lost.', { ok: 'Discard', danger: true }))) return;
      close(null);
    }
    async function finish() {
      if (!pages.length) return toast('Scan at least one page first');
      if (!searchable) return close(pages.map((url) => ({ url })));
      // Read the text on each page so the PDF can be searched and copied.
      const box = progressBox('Getting ready to read text…');
      const out = [];
      try {
        const { recognize } = await import('../ocr.js');
        for (let i = 0; i < pages.length; i++) {
          const label = pages.length > 1 ? `Reading page ${i + 1} of ${pages.length}…` : 'Reading text…';
          box.update(label);
          const r = await recognize(pages[i], (v) => box.update(`${label} ${Math.round(v * 100)}%`));
          out.push({ url: pages[i], words: r.words });
        }
      } catch (err) {
        console.error(err);
        toast('Text recognition failed; saving the pages without it');
        box.close();
        return close(pages.map((url) => ({ url })));
      }
      box.close();
      close(out);
    }
    function close(value) {
      view.remove();
      resolve(value);
    }

    refreshBar();
    showPages();
    addPage();
  });
}
