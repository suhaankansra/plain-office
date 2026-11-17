// Document scanner: take photos of paper, find and straighten the page,
// clean it up, and save the pages as a PDF. Everything runs on the phone.
// The image work (finding edges, perspective, shadows) is in scan-core.js.

import { h, icon, iconBtn, toast, busy, progressBox, confirmBox } from '../ui.js';
import { pickFiles } from '../files.js';
import { findPage, warp, applyFilter, rotate90, isConvex, FILTERS } from './scan-core.js';

const MAX_SOURCE = 3000; // longest side kept from a photo: enough for small print

// ---------- Image helpers ----------
async function loadPhoto(blob) {
  const url = URL.createObjectURL(blob);
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


// Black & white pages are sharper and smaller as PNG; everything else as JPEG.
const pageUrl = (canvas, filter) => (filter === 'bw' ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.88));

// The finished page for a photo, its corners, look and quarter turns.
function render(source, corners, filter, turns) {
  return rotate90(applyFilter(warp(source, corners), filter), turns);
}

// ---------- Screen ----------
// Resolves with [{ url, words }] (one per page; words when OCR ran), or null if cancelled.
export function scan() {
  return new Promise((resolve) => {
    // Each page keeps its photo so it can be cropped again or given another look later.
    // { url, photo: Blob, corners, filter, turns }
    const pages = [];
    const queue = []; // photos picked together, waiting for their turn
    let searchable = true;
    let lastFilter = 'auto';
    let fromLibrary = false;
    // The page being worked on.
    let cur = null; // { source: canvas, photo: Blob, corners, filter, turns, index (when editing) }

    const title = h('span', {}, 'Scan');
    const sub = h('small', {}, '');
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
      sub.textContent = [
        pages.length ? `${pages.length} page${pages.length === 1 ? '' : 's'}` : '',
        queue.length ? `${queue.length} more to check` : '',
      ].filter(Boolean).join(' · ');
      const ready = primaryAction !== finish || pages.length > 0;
      primary.disabled = !ready;
      primary.style.opacity = ready ? '1' : '0.4';
    };
    const textBtn = (iconName, label, onClick) => h('button', { class: 'tb-text', onClick }, icon(iconName), label);

    // ---- Getting photos ----
    async function capture(library = fromLibrary) {
      fromLibrary = library;
      const files = await pickFiles('image/*', library, library ? null : 'environment');
      if (!files.length) return; // stay on the current screen; the pages screen offers both ways in
      queue.push(...files);
      nextFromQueue();
    }

    async function nextFromQueue() {
      const file = queue.shift();
      if (!file) { showPages(); return; }
      let found = true;
      await busy('Finding the page…', async () => {
        const source = await loadPhoto(file);
        const r = findPage(source);
        found = r.found;
        cur = { source, photo: file, corners: r.corners, filter: lastFilter, turns: 0 };
      });
      showCrop();
      if (!found) toast('Could not find the page edges. Drag the corners onto them.');
    }

    // Open a kept page again: back to its corners, with its look and turns.
    async function editPage(i) {
      const p = pages[i];
      await busy('Opening…', async () => {
        cur = { source: await loadPhoto(p.photo), photo: p.photo, corners: p.corners.map((c) => c.slice()), filter: p.filter, turns: p.turns, index: i };
      });
      showCrop();
    }

    // ---- Step 1: the corners ----
    function showCrop() {
      const { source } = cur;
      title.textContent = 'Adjust the corners';
      setPrimary('Next', next);
      const k = Math.min((stage.clientWidth - 32) / source.width, (stage.clientHeight - 32) / source.height);
      source.className = 'scan-img';
      source.style.width = `${source.width * k}px`;
      source.style.height = `${source.height * k}px`;
      const NS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('class', 'scan-overlay');
      svg.setAttribute('viewBox', `0 0 ${source.width} ${source.height}`);
      // Darken everything outside the page so the chosen area stands out.
      const shade = document.createElementNS(NS, 'path');
      shade.setAttribute('class', 'scan-shade');
      shade.setAttribute('fill-rule', 'evenodd');
      const poly = document.createElementNS(NS, 'polygon');
      poly.setAttribute('class', 'scan-poly');
      svg.append(shade, poly);
      const handles = cur.corners.map(() => {
        const c = document.createElementNS(NS, 'circle');
        c.setAttribute('r', 14 / k);
        c.setAttribute('class', 'scan-handle');
        svg.append(c);
        return c;
      });
      // Magnifier: shows what is under your finger, with a cross on the corner.
      const LOUPE = 120;
      const loupe = h('canvas', { class: 'scan-loupe', width: LOUPE * 2, height: LOUPE * 2 });
      const lctx = loupe.getContext('2d');
      const draw = () => {
        const pts = cur.corners.map((p) => p.join(',')).join(' ');
        poly.setAttribute('points', pts);
        shade.setAttribute('d', `M0 0H${source.width}V${source.height}H0Z M${cur.corners.map((p) => p.join(' ')).join(' L')}Z`);
        poly.classList.toggle('bad', !isConvex(cur.corners));
        handles.forEach((c, i) => { c.setAttribute('cx', cur.corners[i][0]); c.setAttribute('cy', cur.corners[i][1]); });
      };
      const showLoupe = (i) => {
        const [x, y] = cur.corners[i];
        const span = 70 / k / 2.5; // about 2.5x the size it is shown at
        lctx.fillStyle = '#000';
        lctx.fillRect(0, 0, loupe.width, loupe.height);
        lctx.drawImage(source, x - span, y - span, span * 2, span * 2, 0, 0, loupe.width, loupe.height);
        lctx.strokeStyle = '#4d8dff';
        lctx.lineWidth = 3;
        lctx.beginPath();
        lctx.moveTo(LOUPE, LOUPE - 26); lctx.lineTo(LOUPE, LOUPE + 26);
        lctx.moveTo(LOUPE - 26, LOUPE); lctx.lineTo(LOUPE + 26, LOUPE);
        lctx.stroke();
        // Keep it out from under the finger: on the opposite side of the photo.
        loupe.classList.toggle('right', x < source.width / 2);
        loupe.hidden = false;
      };
      draw();
      loupe.hidden = true;
      let dragging = null;
      const toImage = (e) => {
        const rect = svg.getBoundingClientRect();
        return [((e.clientX - rect.left) / rect.width) * source.width, ((e.clientY - rect.top) / rect.height) * source.height];
      };
      let grab = [0, 0];
      svg.addEventListener('pointerdown', (e) => {
        const [x, y] = toImage(e);
        let best = -1;
        let bestD = 56 / k; // a generous, finger-sized reach
        cur.corners.forEach((p, i) => { const d = Math.hypot(p[0] - x, p[1] - y); if (d < bestD) { bestD = d; best = i; } });
        if (best < 0) return;
        dragging = best;
        // Move relative to where the finger landed, so the corner does not jump under it.
        grab = [cur.corners[best][0] - x, cur.corners[best][1] - y];
        svg.setPointerCapture(e.pointerId);
        showLoupe(best);
        e.preventDefault();
      });
      svg.addEventListener('pointermove', (e) => {
        if (dragging === null) return;
        const [x, y] = toImage(e);
        cur.corners[dragging] = [Math.min(Math.max(x + grab[0], 0), source.width), Math.min(Math.max(y + grab[1], 0), source.height)];
        draw();
        showLoupe(dragging);
      });
      const end = () => { dragging = null; loupe.hidden = true; };
      svg.addEventListener('pointerup', end);
      svg.addEventListener('pointercancel', end);
      stage.replaceChildren(h('div', { class: 'scan-wrap' }, source, svg, loupe));
      toolbar.replaceChildren(
        cur.index === undefined
          ? textBtn('x', 'Retake', () => { cur = null; capture(); })
          : textBtn('left', 'Pages', () => { cur = null; showPages(); }),
        textBtn('rotate', 'Rotate', () => {
          const oldH = source.height;
          cur.source = rotate90(source);
          const turned = cur.corners.map(([x, y]) => [oldH - y, x]);
          cur.corners = [turned[3], turned[0], turned[1], turned[2]];
          showCrop();
        }),
        textBtn('square', 'Auto', () => {
          const r = findPage(source);
          cur.corners = r.corners;
          draw();
          if (!r.found) toast('Could not find the page edges');
        }),
        textBtn('pages', 'Whole photo', () => { cur.corners = [[0, 0], [source.width, 0], [source.width, source.height], [0, source.height]]; draw(); }),
      );
      async function next() {
        if (!isConvex(cur.corners)) return toast('The corners cross over. Move them onto the page’s corners.');
        showLook();
      }
    }

    // ---- Step 2: the look ----
    async function showLook() {
      title.textContent = 'Choose a look';
      let preview;
      await busy('Cleaning up the page…', async () => { preview = render(cur.source, cur.corners, cur.filter, cur.turns); });
      preview.className = 'scan-img';
      const k = Math.min((stage.clientWidth - 32) / preview.width, (stage.clientHeight - 32) / preview.height);
      preview.style.width = `${preview.width * k}px`;
      preview.style.height = `${preview.height * k}px`;
      stage.replaceChildren(preview);
      const chips = h('div', { class: 'scan-chips' }, FILTERS.map(([key, label]) => h('button', {
        class: `chip${cur.filter === key ? ' on' : ''}`,
        onClick: () => { cur.filter = key; showLook(); },
      }, label)));
      const editing = cur.index !== undefined;
      toolbar.replaceChildren(h('div', { class: 'scan-look-tools' },
        chips,
        h('div', { class: 'scan-row' },
          textBtn('left', 'Corners', showCrop),
          textBtn('rotate', 'Turn', () => { cur.turns = (cur.turns + 1) % 4; showLook(); }),
          editing ? null : textBtn('scan', 'Next page', () => keep(preview, true)))));
      setPrimary(editing ? 'Done' : 'Keep', () => keep(preview, false));
    }

    function keep(canvas, another) {
      const page = { url: pageUrl(canvas, cur.filter), photo: cur.photo, corners: cur.corners, filter: cur.filter, turns: cur.turns };
      lastFilter = cur.filter;
      if (cur.index !== undefined) pages[cur.index] = page; else pages.push(page);
      cur = null;
      if (queue.length) nextFromQueue();
      else if (another) capture();
      else showPages();
    }

    // ---- Step 3: the pages so far ----
    function showPages() {
      title.textContent = 'Scanned pages';
      setPrimary('Save PDF', finish);
      const grid = h('div', { class: 'scan-pages' }, pages.map((p, i) => h('div', { class: 'page-card' },
        h('button', { class: 'pv', 'aria-label': `Edit page ${i + 1}`, onClick: () => editPage(i) }, h('img', { src: p.url, alt: `Page ${i + 1}` })),
        h('div', { class: 'acts' },
          iconBtn('left', 'Move earlier', () => { [pages[i - 1], pages[i]] = [pages[i], pages[i - 1]]; showPages(); }, { disabled: i === 0 }),
          h('span', { class: 'lbl' }, `Page ${i + 1}`),
          iconBtn('trash', 'Delete page', () => { pages.splice(i, 1); refreshBar(); showPages(); })))));
      stage.replaceChildren(pages.length
        ? h('div', { style: { width: '100%', alignSelf: 'flex-start' } }, grid, h('p', { class: 'scan-hint' }, 'Tap a page to fix its corners or change its look.'))
        : h('div', { class: 'scan-start' },
          h('p', {}, 'Take a photo of a page, or choose photos you already have.'),
          h('button', { class: 'btn primary', onClick: () => capture(false) }, icon('scan'), 'Take a photo'),
          h('button', { class: 'btn', onClick: () => capture(true) }, icon('image'), 'Choose photos')));
      const ocrToggle = h('button', {
        class: `tb-text${searchable ? ' on' : ''}`,
        'aria-pressed': String(searchable),
        onClick: () => { searchable = !searchable; showPages(); toast(searchable ? 'The PDF will be searchable' : 'Text recognition off'); },
      }, icon(searchable ? 'check' : 'square'), 'Searchable text');
      toolbar.replaceChildren(textBtn('scan', 'Camera', () => capture(false)), textBtn('image', 'Photos', () => capture(true)), ocrToggle);
    }

    async function cancel() {
      if ((pages.length || cur) && !(await confirmBox('Discard this scan?', 'The pages you scanned will be lost.', { ok: 'Discard', danger: true }))) return;
      close(null);
    }
    async function finish() {
      if (!pages.length) return toast('Scan at least one page first');
      const urls = pages.map((p) => p.url);
      if (!searchable) return close(urls.map((url) => ({ url })));
      // Read the text on each page so the PDF can be searched and copied.
      const box = progressBox('Getting ready to read text…');
      const out = [];
      try {
        const { recognize } = await import('../ocr.js');
        for (let i = 0; i < urls.length; i++) {
          const label = urls.length > 1 ? `Reading page ${i + 1} of ${urls.length}…` : 'Reading text…';
          box.update(label);
          const r = await recognize(urls[i], (v) => box.update(`${label} ${Math.round(v * 100)}%`));
          out.push({ url: urls[i], words: r.words });
        }
      } catch (err) {
        console.error(err);
        toast('Text recognition failed; saving the pages without it');
        box.close();
        return close(urls.map((url) => ({ url })));
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
    capture(false);
  });
}
