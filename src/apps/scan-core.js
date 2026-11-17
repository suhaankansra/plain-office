// The image side of the document scanner: find the page in a photo,
// straighten it to its real shape, and clean it up (flat white paper, dark
// text, no shadows). Plain canvas code with no imports, so it runs anywhere.

export const MAX_OUTPUT = 2400; // longest side of a finished page

// ---------- Small helpers ----------
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// A downscaled copy of a canvas as RGB and grey arrays.
function sample(canvas, longest) {
  const k = Math.min(1, longest / Math.max(canvas.width, canvas.height));
  const w = Math.max(1, Math.round(canvas.width * k));
  const h = Math.max(1, Math.round(canvas.height * k));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const n = w * h;
  const r = new Float32Array(n);
  const g = new Float32Array(n);
  const b = new Float32Array(n);
  const grey = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    r[i] = px[i * 4];
    g[i] = px[i * 4 + 1];
    b[i] = px[i * 4 + 2];
    grey[i] = r[i] * 0.299 + g[i] * 0.587 + b[i] * 0.114;
  }
  return { w, h, k, r, g, b, grey };
}

// Box blur, done twice (close to a Gaussian). Separable, O(n) per pass.
function blur(src, w, h, radius) {
  if (radius < 1) return src;
  let a = Float32Array.from(src);
  const tmp = new Float32Array(w * h);
  const pass = (from, to, len, count, stride, step) => {
    for (let line = 0; line < count; line++) {
      const base = line * stride;
      let acc = 0;
      for (let i = -radius; i <= radius; i++) acc += from[base + clamp(i, 0, len - 1) * step];
      for (let i = 0; i < len; i++) {
        to[base + i * step] = acc / (2 * radius + 1);
        acc += from[base + clamp(i + radius + 1, 0, len - 1) * step] - from[base + clamp(i - radius, 0, len - 1) * step];
      }
    }
  };
  for (let t = 0; t < 2; t++) {
    pass(a, tmp, w, h, w, 1);
    pass(tmp, a, h, w, 1, w);
  }
  return a;
}

function otsu(values, lo = 0, hi = 255) {
  const bins = 256;
  const hist = new Float64Array(bins);
  const scale = (bins - 1) / Math.max(1e-6, hi - lo);
  for (const v of values) hist[clamp(Math.round((v - lo) * scale), 0, bins - 1)]++;
  let sum = 0;
  for (let i = 0; i < bins; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = -1;
  let t = 128;
  for (let i = 0; i < bins; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = values.length - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const between = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2;
    if (between > best) { best = between; t = i; }
  }
  return lo + t / scale;
}

function percentile(values, p) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < values.length; i++) hist[clamp(values[i] | 0, 0, 255)]++;
  const target = values.length * p;
  let acc = 0;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= target) return i; }
  return 255;
}

// Grow or shrink a mask by `r` pixels (square neighbourhood), via a running count.
function morph(mask, w, h, r, grow) {
  const count = (src) => {
    const rows = new Int32Array(w * h);
    for (let y = 0; y < h; y++) {
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += src[y * w + clamp(x, 0, w - 1)];
      for (let x = 0; x < w; x++) {
        rows[y * w + x] = acc;
        acc += src[y * w + clamp(x + r + 1, 0, w - 1)] - src[y * w + clamp(x - r, 0, w - 1)];
      }
    }
    const out = new Uint8Array(w * h);
    const full = (2 * r + 1) * (2 * r + 1);
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += rows[clamp(y, 0, h - 1) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = grow ? (acc > 0 ? 1 : 0) : (acc === full ? 1 : 0);
        acc += rows[clamp(y + r + 1, 0, h - 1) * w + x] - rows[clamp(y - r, 0, h - 1) * w + x];
      }
    }
    return out;
  };
  return count(mask);
}

// The connected region that is biggest, preferring regions that cover the
// middle of the photo (that is where people point the camera).
function mainRegion(mask, w, h) {
  const label = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  let best = null;
  let next = 1;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || label[start]) continue;
    let top = 0;
    stack[top++] = start;
    label[start] = next;
    let size = 0;
    let cx = 0;
    let cy = 0;
    let touches = 0;
    while (top) {
      const i = stack[--top];
      size++;
      const x = i % w;
      const y = (i / w) | 0;
      cx += x;
      cy += y;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touches++;
      if (x > 0 && mask[i - 1] && !label[i - 1]) { label[i - 1] = next; stack[top++] = i - 1; }
      if (x < w - 1 && mask[i + 1] && !label[i + 1]) { label[i + 1] = next; stack[top++] = i + 1; }
      if (y > 0 && mask[i - w] && !label[i - w]) { label[i - w] = next; stack[top++] = i - w; }
      if (y < h - 1 && mask[i + w] && !label[i + w]) { label[i + w] = next; stack[top++] = i + w; }
    }
    const off = Math.hypot(cx / size / w - 0.5, cy / size / h - 0.5);
    const score = size * (1 - off) * (1 - Math.min(0.5, touches / (2 * (w + h))));
    if (!best || score > best.score) best = { id: next, size, score };
    next++;
  }
  if (!best) return null;
  const pts = [];
  // Only the leftmost and rightmost pixel of each row matter for the hull.
  for (let y = 0; y < h; y++) {
    let lo = -1;
    let hi = -1;
    for (let x = 0; x < w; x++) if (label[y * w + x] === best.id) { if (lo < 0) lo = x; hi = x; }
    if (lo >= 0) { pts.push([lo, y]); if (hi !== lo) pts.push([hi + 1, y]); }
  }
  return { pts, size: best.size };
}

function convexHull(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const pt of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) lower.pop(); lower.push(pt); }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) { const pt = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0) upper.pop(); upper.push(pt); }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

const polyArea = (pts) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const [x1, y1] = pts[i]; const [x2, y2] = pts[(i + 1) % pts.length]; a += x1 * y2 - x2 * y1; }
  return Math.abs(a) / 2;
};

// Reduce a convex hull to the 4-sided shape that keeps the most area.
function hullToQuad(hull) {
  const pts = hull.slice();
  while (pts.length > 4) {
    let bestI = 0;
    let bestLoss = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i - 1 + pts.length) % pts.length];
      const b = pts[i];
      const c = pts[(i + 1) % pts.length];
      const loss = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
      if (loss < bestLoss) { bestLoss = loss; bestI = i; }
    }
    pts.splice(bestI, 1);
  }
  return pts.length === 4 ? pts : null;
}

// Put four corners in the order top-left, top-right, bottom-right, bottom-left.
export function orderCorners(pts) {
  const cx = pts.reduce((s, p) => s + p[0], 0) / 4;
  const cy = pts.reduce((s, p) => s + p[1], 0) / 4;
  const sorted = pts.slice().sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  // Clockwise on screen from the angle -pi; start at the corner nearest the top-left.
  let start = 0;
  let bestS = Infinity;
  sorted.forEach((p, i) => { const s = p[0] + p[1]; if (s < bestS) { bestS = s; start = i; } });
  return [0, 1, 2, 3].map((i) => sorted[(start + i) % 4]);
}

export function isConvex(q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [a, b, c] = [q[i], q[(i + 1) % 4], q[(i + 2) % 4]];
    const z = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(z) < 1e-9) return false;
    if (!sign) sign = Math.sign(z); else if (Math.sign(z) !== sign) return false;
  }
  return true;
}

const at = (img, w, h, x, y) => {
  const xi = clamp(Math.round(x), 0, w - 1);
  const yi = clamp(Math.round(y), 0, h - 1);
  return img[yi * w + xi];
};

// Move each side of the shape onto the strongest nearby edge, then
// intersect neighbouring sides for exact corners.
function refineQuad(quad, grad, w, h, reach) {
  const lines = [];
  for (let s = 0; s < 4; s++) {
    const a = quad[s];
    const b = quad[(s + 1) % 4];
    const len = dist(a, b);
    if (len < 4) return quad;
    const nx = -(b[1] - a[1]) / len;
    const ny = (b[0] - a[0]) / len;
    const samples = [];
    const steps = Math.max(8, Math.round(len / 2));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      if (t < 0.08 || t > 0.92) continue; // corners are often rounded, folded or shadowed
      const px = a[0] + (b[0] - a[0]) * t;
      const py = a[1] + (b[1] - a[1]) * t;
      let best = 0;
      let bestD = 0;
      for (let d = -reach; d <= reach; d += 0.5) {
        const v = at(grad, w, h, px + nx * d, py + ny * d);
        if (v > best) { best = v; bestD = d; }
      }
      if (best > 0) samples.push([px + nx * bestD, py + ny * bestD, best]);
    }
    if (samples.length < 4) return quad;
    // Fit a line, then drop the worst fifth of the points and fit again.
    let line = fitLine(samples);
    for (let round = 0; round < 2 && line; round++) {
      const res = samples.map((p) => Math.abs(line.nx * p[0] + line.ny * p[1] - line.c));
      const cut = res.slice().sort((x, y) => x - y)[Math.floor(res.length * 0.8)];
      const kept = samples.filter((_, i) => res[i] <= cut + 1e-6);
      if (kept.length >= 4) line = fitLine(kept);
    }
    if (!line) return quad;
    lines.push(line);
  }
  const out = [];
  for (let s = 0; s < 4; s++) {
    const l1 = lines[(s + 3) % 4];
    const l2 = lines[s];
    const det = l1.nx * l2.ny - l1.ny * l2.nx;
    if (Math.abs(det) < 1e-6) return quad;
    out.push([(l1.c * l2.ny - l1.ny * l2.c) / det, (l1.nx * l2.c - l1.c * l2.nx) / det]);
  }
  // Refinement must not jump far from where it started.
  const limit = reach * 2.5;
  if (out.some((p, i) => dist(p, quad[i]) > limit) || !isConvex(out)) return quad;
  return out;
}

// Weighted total-least-squares line: nx*x + ny*y = c.
function fitLine(pts) {
  let sw = 0;
  let sx = 0;
  let sy = 0;
  for (const [x, y, wt] of pts) { sw += wt; sx += x * wt; sy += y * wt; }
  if (!sw) return null;
  const mx = sx / sw;
  const my = sy / sw;
  let xx = 0;
  let xy = 0;
  let yy = 0;
  for (const [x, y, wt] of pts) { const dx = x - mx; const dy = y - my; xx += dx * dx * wt; xy += dx * dy * wt; yy += dy * dy * wt; }
  const angle = 0.5 * Math.atan2(2 * xy, xx - yy); // direction of the line
  const nx = -Math.sin(angle);
  const ny = Math.cos(angle);
  return { nx, ny, c: nx * mx + ny * my };
}

// Edge pixels with their direction: Sobel, then keep only the ridge of each
// edge (non-maximum suppression) so every edge is one pixel wide.
function edgeMap(grey, w, h) {
  const n = w * h;
  const gx = new Float32Array(n);
  const gy = new Float32Array(n);
  const mag = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const ax = grey[i - w + 1] + 2 * grey[i + 1] + grey[i + w + 1] - grey[i - w - 1] - 2 * grey[i - 1] - grey[i + w - 1];
      const ay = grey[i + w - 1] + 2 * grey[i + w] + grey[i + w + 1] - grey[i - w - 1] - 2 * grey[i - w] - grey[i - w + 1];
      gx[i] = ax;
      gy[i] = ay;
      mag[i] = Math.hypot(ax, ay);
    }
  }
  const thin = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const m = mag[i];
      if (m < 1) continue;
      const ax = Math.abs(gx[i]);
      const ay = Math.abs(gy[i]);
      let a;
      let b;
      if (ax > 2.414 * ay) { a = mag[i - 1]; b = mag[i + 1]; }
      else if (ay > 2.414 * ax) { a = mag[i - w]; b = mag[i + w]; }
      else if (gx[i] * gy[i] > 0) { a = mag[i - w - 1]; b = mag[i + w + 1]; }
      else { a = mag[i - w + 1]; b = mag[i + w - 1]; }
      if (m >= a && m >= b) thin[i] = m;
    }
  }
  return { gx, gy, mag, thin };
}

// Long straight edges (Hough transform): returns lines nx*x + ny*y = c.
function findLines(E, w, h, minMag) {
  const T = 180;
  const diag = Math.ceil(Math.hypot(w, h));
  const R = 2 * diag + 1;
  const acc = new Float32Array(T * R);
  const cos = new Float32Array(T);
  const sin = new Float32Array(T);
  for (let t = 0; t < T; t++) { cos[t] = Math.cos((t * Math.PI) / T); sin[t] = Math.sin((t * Math.PI) / T); }
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (E.thin[i] < minMag) continue;
      // Vote only for lines running across the edge's own direction.
      let t0 = Math.round((Math.atan2(E.gy[i], E.gx[i]) * T) / Math.PI);
      t0 = ((t0 % T) + T) % T;
      for (let d = -3; d <= 3; d++) {
        const t = (t0 + d + T) % T;
        const r = Math.round(x * cos[t] + y * sin[t]) + diag;
        acc[t * R + r] += 1;
      }
    }
  }
  const minVotes = Math.min(w, h) * 0.12;
  const peaks = [];
  for (let t = 0; t < T; t++) {
    for (let r = 1; r < R - 1; r++) {
      const v = acc[t * R + r];
      if (v < minVotes) continue;
      let isMax = true;
      for (let dt = -3; dt <= 3 && isMax; dt++) {
        const tt = t + dt;
        // Angles wrap around: theta + 180 is the same line with rho negated.
        for (let dr = -5; dr <= 5; dr++) {
          if (!dt && !dr) continue;
          let ti = tt;
          let ri = r + dr;
          if (ti < 0) { ti += T; ri = 2 * diag - ri; } else if (ti >= T) { ti -= T; ri = 2 * diag - ri; }
          if (ri < 0 || ri >= R) continue;
          const o = acc[ti * R + ri];
          if (o > v || (o === v && (ti * R + ri) < t * R + r)) { isMax = false; break; }
        }
      }
      if (isMax) peaks.push({ v, nx: cos[t], ny: sin[t], c: r - diag });
    }
  }
  peaks.sort((a, b) => b.v - a.v);
  return peaks.slice(0, 30);
}

const intersect = (l1, l2) => {
  const det = l1.nx * l2.ny - l1.ny * l2.nx;
  if (Math.abs(det) < 1e-6) return null;
  return [(l1.c * l2.ny - l1.ny * l2.c) / det, (l1.nx * l2.c - l1.c * l2.nx) / det];
};

// How much of each side of a shape lies on a real edge running the same way.
// Sides on the photo's border cannot be seen, so they count as half-seen.
function coverage(quad, E, w, h, minMag) {
  const sides = [];
  for (let s = 0; s < 4; s++) {
    const a = quad[s];
    const b = quad[(s + 1) % 4];
    const len = dist(a, b);
    const nx = -(b[1] - a[1]) / len;
    const ny = (b[0] - a[0]) / len;
    const onBorder = (p) => p[0] < 3 || p[1] < 3 || p[0] > w - 4 || p[1] > h - 4;
    if (onBorder(a) && onBorder(b)) { sides.push(0.5); continue; }
    const steps = Math.max(10, Math.round(len));
    let hit = 0;
    let seen = 0;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const px = a[0] + (b[0] - a[0]) * t;
      const py = a[1] + (b[1] - a[1]) * t;
      if (px < 1 || py < 1 || px > w - 2 || py > h - 2) continue;
      seen++;
      for (let d = -1.5; d <= 1.5; d += 0.75) {
        const xi = Math.round(px + nx * d);
        const yi = Math.round(py + ny * d);
        const j = yi * w + xi;
        const m = E.mag[j];
        if (m < minMag) continue;
        // The edge must run along the side: its gradient points across it.
        if (Math.abs(E.gx[j] * nx + E.gy[j] * ny) / m > 0.9) { hit++; break; }
      }
    }
    sides.push(seen ? hit / seen : 0);
  }
  const mean = sides.reduce((x, y) => x + y, 0) / 4;
  return 0.6 * mean + 0.4 * Math.min(...sides);
}

// ---------- Finding the page ----------
// Returns four corners (top-left, top-right, bottom-right, bottom-left) in the
// canvas's own pixels. `found` is false when it fell back to a margin.
export function findPage(canvas) {
  const S = sample(canvas, 400);
  const { w, h } = S;
  const n = w * h;
  const smooth = blur(S.grey, w, h, 1);
  const E = edgeMap(smooth, w, h);
  // "Strong enough to be an edge", relative to this photo's own contrast.
  const mags = [];
  for (let i = 0; i < n; i += 3) if (E.thin[i] > 0) mags.push(E.thin[i]);
  mags.sort((p, q) => p - q);
  const minMag = Math.max(14, (mags[Math.floor(mags.length * 0.5)] || 0) * 0.6);
  const candidates = [];
  const consider = (q, bonus = 1) => {
    if (!q || q.some((p) => !p || p[0] < -0.02 * w || p[1] < -0.02 * h || p[0] > 1.02 * w || p[1] > 1.02 * h)) return;
    q = orderCorners(q);
    if (!isConvex(q)) return;
    const area = polyArea(q) / n;
    if (area < 0.1 || area > 0.995) return;
    if (Math.min(...q.map((p, i) => dist(p, q[(i + 1) % 4]))) < Math.min(w, h) * 0.15) return;
    // Pages are close to rectangles even in perspective: no very sharp or very flat corners.
    for (let i = 0; i < 4; i++) {
      const [p0, p1, p2] = [q[(i + 3) % 4], q[i], q[(i + 1) % 4]];
      const v1 = [p0[0] - p1[0], p0[1] - p1[1]];
      const v2 = [p2[0] - p1[0], p2[1] - p1[1]];
      const cosA = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2));
      if (Math.abs(cosA) > 0.7) return; // outside 45-135 degrees
    }
    candidates.push({ q, score: coverage(q, E, w, h, minMag) * Math.pow(area, 0.2) * bonus });
  };

  // 1. Four long straight edges that make a page shape.
  const lines = findLines(E, w, h, minMag);
  const across = lines.filter((l) => Math.abs(l.ny) >= Math.abs(l.nx)).slice(0, 10); // top and bottom
  const down = lines.filter((l) => Math.abs(l.ny) < Math.abs(l.nx)).slice(0, 10); // left and right
  for (let i = 0; i < across.length; i++) for (let j = i + 1; j < across.length; j++) {
    for (let k = 0; k < down.length; k++) for (let m = k + 1; m < down.length; m++) {
      const [h1, h2, v1, v2] = [across[i], across[j], down[k], down[m]];
      consider([intersect(h1, v1), intersect(h1, v2), intersect(h2, v2), intersect(h2, v1)]);
    }
  }

  // 2. Regions that look like paper (for pages with soft or partly hidden edges).
  const r = blur(S.r, w, h, 1);
  const g = blur(S.g, w, h, 1);
  const b = blur(S.b, w, h, 1);
  const border = [];
  const band = Math.max(2, Math.round(Math.min(w, h) * 0.03));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (x < band || y < band || x >= w - band || y >= h - band) border.push(y * w + x);
  }
  const med = (arr) => { const v = border.map((i) => arr[i]).sort((p, q) => p - q); return v[v.length >> 1]; };
  const bg = [med(r), med(g), med(b)];
  const paper = new Float32Array(n); // bright and colourless
  const away = new Float32Array(n); // different from the background colour
  for (let i = 0; i < n; i++) {
    const mx = Math.max(r[i], g[i], b[i]);
    const mn = Math.min(r[i], g[i], b[i]);
    paper[i] = smooth[i] - 1.2 * (mx - mn);
    away[i] = Math.hypot(r[i] - bg[0], g[i] - bg[1], b[i] - bg[2]);
  }
  const closeR = Math.max(2, Math.round(Math.min(w, h) / 80));
  for (const map of [smooth, paper, away]) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < n; i++) { if (map[i] < lo) lo = map[i]; if (map[i] > hi) hi = map[i]; }
    if (hi - lo < 12) continue;
    const t = otsu(map, lo, hi);
    let mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) mask[i] = map[i] > t ? 1 : 0;
    // Close the gaps text makes, then trim thin bits that join the page to other things.
    mask = morph(morph(mask, w, h, closeR, true), w, h, closeR, false);
    mask = morph(morph(mask, w, h, 1, false), w, h, 1, true);
    const region = mainRegion(mask, w, h);
    if (!region || region.size < n * 0.08) continue;
    const quad = hullToQuad(convexHull(region.pts));
    if (!quad) continue;
    const fill = region.size / Math.max(1, polyArea(quad));
    if (fill < 0.8) continue;
    consider(refineQuad(orderCorners(quad), E.mag, w, h, Math.max(3, Math.round(Math.min(w, h) / 60))), 0.97);
  }

  const margin = (m) => [[canvas.width * m, canvas.height * m], [canvas.width * (1 - m), canvas.height * m],
    [canvas.width * (1 - m), canvas.height * (1 - m)], [canvas.width * m, canvas.height * (1 - m)]];
  candidates.sort((p, q) => q.score - p.score);
  if (!candidates.length || candidates[0].score < 0.3) return { corners: margin(0.04), found: false };
  let best = refineQuad(candidates[0].q, E.mag, w, h, 2);
  let corners = best.map(([x, y]) => [x / S.k, y / S.k]);
  // Second, finer pass on a bigger copy for corners within a pixel or two.
  const F = sample(canvas, 1200);
  if (F.k > S.k * 1.5) {
    const fg = edgeMap(blur(F.grey, F.w, F.h, 1), F.w, F.h).mag;
    const fq = refineQuad(corners.map(([x, y]) => [x * F.k, y * F.k]), fg, F.w, F.h, Math.max(3, Math.round((F.k / S.k) * 1.5)));
    corners = fq.map(([x, y]) => [x / F.k, y / F.k]);
  }
  // Pull the corners in a hair (0.4%), so a blurry edge never leaves a sliver of desk on the page.
  const cx = corners.reduce((t, p) => t + p[0], 0) / 4;
  const cy = corners.reduce((t, p) => t + p[1], 0) / 4;
  corners = corners.map(([x, y]) => [clamp(x + (cx - x) * 0.008, 0, canvas.width), clamp(y + (cy - y) * 0.008, 0, canvas.height)]);
  return { corners, found: true, score: candidates[0].score };
}

// ---------- The page's real shape ----------
// The width/height ratio of the rectangle seen in perspective as `corners`,
// using the camera model of Zhang & He ("Whiteboard scanning", 2007).
export function pageRatio(corners, imgW, imgH) {
  const [tl, tr, br, bl] = corners;
  const u0 = imgW / 2;
  const v0 = imgH / 2;
  const m1 = [tl[0] - u0, tl[1] - v0, 1];
  const m2 = [tr[0] - u0, tr[1] - v0, 1];
  const m3 = [bl[0] - u0, bl[1] - v0, 1];
  const m4 = [br[0] - u0, br[1] - v0, 1];
  const cross = (a, c) => [a[1] * c[2] - a[2] * c[1], a[2] * c[0] - a[0] * c[2], a[0] * c[1] - a[1] * c[0]];
  const dot = (a, c) => a[0] * c[0] + a[1] * c[1] + a[2] * c[2];
  const k2 = dot(cross(m1, m4), m3) / dot(cross(m2, m4), m3);
  const k3 = dot(cross(m1, m4), m2) / dot(cross(m3, m4), m2);
  const n2 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 * m2[2] - m1[2]];
  const n3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 * m3[2] - m1[2]];
  const plain = () => {
    const wTop = dist(tl, tr) + dist(bl, br);
    const hSide = dist(tl, bl) + dist(tr, br);
    return wTop / hSide;
  };
  if (!Number.isFinite(k2) || !Number.isFinite(k3)) return plain();
  // The camera's focal length, measured from the photo when the perspective
  // allows it. When two sides are parallel in the photo (camera tilted
  // straight up or down, or held square on) it cannot be measured, so use a
  // phone's main camera instead (about 26 mm equivalent: 0.6 x the diagonal).
  const diag = Math.hypot(imgW, imgH);
  // Where each pair of opposite sides meets. If either pair is close to
  // parallel, the measurement is too sensitive to a pixel of error to trust.
  const meet = (p1, p2, p3, p4) => {
    const d = (p1[0] - p2[0]) * (p3[1] - p4[1]) - (p1[1] - p2[1]) * (p3[0] - p4[0]);
    if (Math.abs(d) < 1e-9) return Infinity;
    const t = ((p1[0] - p3[0]) * (p3[1] - p4[1]) - (p1[1] - p3[1]) * (p3[0] - p4[0])) / d;
    return Math.hypot(p1[0] + t * (p2[0] - p1[0]) - u0, p1[1] + t * (p2[1] - p1[1]) - v0);
  };
  const measurable = meet(tl, tr, bl, br) < 4 * diag && meet(tl, bl, tr, br) < 4 * diag;
  let f2 = measurable ? -(n2[0] * n3[0] + n2[1] * n3[1]) / (n2[2] * n3[2]) : NaN;
  if (!Number.isFinite(f2) || f2 <= 0 || Math.sqrt(f2) < 0.3 * diag || Math.sqrt(f2) > 3 * diag) f2 = (0.6 * diag) ** 2;
  let ratio = Math.sqrt((n2[0] ** 2 + n2[1] ** 2 + f2 * n2[2] ** 2) / (n3[0] ** 2 + n3[1] ** 2 + f2 * n3[2] ** 2));
  if (!Number.isFinite(ratio) || ratio <= 0) return plain();
  // A wildly different answer from the plain sides means the camera model broke down.
  const p = plain();
  if (ratio / p > 1.6 || p / ratio > 1.6) return p;
  return ratio;
}

// Snap to a common paper size when the measured shape is close to one.
const PAPER = [Math.SQRT2, 11 / 8.5, 14 / 8.5, 1]; // A sizes, US Letter, US Legal, square
export function snapRatio(ratio) {
  const tall = ratio < 1;
  const r = tall ? 1 / ratio : ratio;
  for (const p of PAPER) if (Math.abs(r - p) / p < 0.035) return tall ? 1 / p : p;
  return ratio;
}

// Solve the projective transform taking the output rectangle to the photo.
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

// Straighten the page to its real proportions.
export function warp(source, corners, maxOutput = MAX_OUTPUT) {
  const [tl, tr, br, bl] = corners;
  const ratio = snapRatio(pageRatio(corners, source.width, source.height));
  // Keep about as many pixels as the photo had across the page.
  const seenW = Math.max(dist(tl, tr), dist(bl, br));
  const seenH = Math.max(dist(tl, bl), dist(tr, br));
  let w = Math.max(seenW, seenH * ratio);
  let hgt = w / ratio;
  const k = Math.min(1, maxOutput / Math.max(w, hgt));
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
      x = clamp(x, 0, sw - 1.001);
      y = clamp(y, 0, sh - 1.001);
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

export function rotate90(canvas, times = 1) {
  let cur = canvas;
  for (let t = 0; t < ((times % 4) + 4) % 4; t++) {
    const out = document.createElement('canvas');
    out.width = cur.height;
    out.height = cur.width;
    const ctx = out.getContext('2d');
    ctx.translate(out.width, 0);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(cur, 0, 0);
    cur = out;
  }
  return cur;
}

// ---------- Cleaning up the page ----------
// The paper's own brightness everywhere on the page (shadows included),
// found by blurring away the text: small copy, keep the brightest nearby
// pixel, then smooth.
function maxFilter(ch, w, h, r) {
  const rows = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = 0;
    for (let d = -r; d <= r; d++) { const v = ch[y * w + clamp(x + d, 0, w - 1)]; if (v > m) m = v; }
    rows[y * w + x] = m;
  }
  const out = new Float32Array(w * h);
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
    let m = 0;
    for (let d = -r; d <= r; d++) { const v = rows[clamp(y + d, 0, h - 1) * w + x]; if (v > m) m = v; }
    out[y * w + x] = m;
  }
  return out;
}

function paperLight(canvas) {
  const S = sample(canvas, 260);
  const { w, h } = S;
  const n = w * h;
  const r = Math.max(2, Math.round(Math.max(w, h) / 45));
  const far = Math.max(r * 3, Math.round(Math.max(w, h) / 7));
  // Brightest pixel nearby: lines of text vanish, the paper (and its shadows) stays.
  const near = [S.r, S.g, S.b].map((ch) => maxFilter(ch, w, h, r));
  // Which pixels are plain paper? Not ink (darker than the paper next to it),
  // not a coloured block, not a dark picture. Logos and photos are left out
  // and the paper's light behind them is filled in from around them.
  const nearLum = maxFilter(S.grey, w, h, r);
  const farLum = maxFilter(S.grey, w, h, far);
  const mask = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const mx = Math.max(S.r[i], S.g[i], S.b[i]);
    const mn = Math.min(S.r[i], S.g[i], S.b[i]);
    const sat = mx > 0 ? (mx - mn) / mx : 0;
    mask[i] = S.grey[i] > 0.86 * nearLum[i] && sat < 0.22 && S.grey[i] > 0.3 * farLum[i] ? 1 : 0;
  }
  const den = blur(mask, w, h, far);
  const out = [];
  for (const ch of near) {
    const kept = new Float32Array(n);
    for (let i = 0; i < n; i++) kept[i] = ch[i] * mask[i];
    const num = blur(kept, w, h, far);
    const filled = new Float32Array(n);
    for (let i = 0; i < n; i++) filled[i] = mask[i] ? ch[i] : den[i] > 0.02 ? num[i] / den[i] : ch[i];
    out.push(blur(filled, w, h, r));
  }
  // Scale it up to full size with the browser's smooth resampling.
  const small = document.createElement('canvas');
  small.width = w;
  small.height = h;
  const sctx = small.getContext('2d');
  const id = sctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    id.data[i * 4] = out[0][i];
    id.data[i * 4 + 1] = out[1][i];
    id.data[i * 4 + 2] = out[2][i];
    id.data[i * 4 + 3] = 255;
  }
  sctx.putImageData(id, 0, 0);
  const big = document.createElement('canvas');
  big.width = canvas.width;
  big.height = canvas.height;
  const bctx = big.getContext('2d', { willReadFrequently: true });
  bctx.imageSmoothingEnabled = true;
  bctx.imageSmoothingQuality = 'high';
  bctx.drawImage(small, 0, 0, big.width, big.height);
  return bctx.getImageData(0, 0, big.width, big.height).data;
}

export const FILTERS = [
  ['auto', 'Auto'],
  ['colour', 'Colour'],
  ['grey', 'Grayscale'],
  ['bw', 'Black & white'],
  ['original', 'Original'],
];

// auto:   flat white paper, dark text, colours kept but cleaned (like "Magic colour")
// colour: shadows lifted, otherwise close to the photo
// grey:   flat white paper in shades of grey
// bw:     crisp black text on white
export function applyFilter(canvas, filter) {
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height;
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0);
  if (filter === 'original') return out;
  const img = ctx.getImageData(0, 0, out.width, out.height);
  const p = img.data;
  const n = out.width * out.height;
  const light = paperLight(canvas);

  // Divide by the paper's light: paper becomes white everywhere, shadows go.
  const flat = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    for (let ch = 0; ch < 3; ch++) {
      const bgv = Math.max(24, light[i * 4 + ch]);
      flat[i * 3 + ch] = Math.min(1.2, p[i * 4 + ch] / bgv);
    }
  }
  if (filter === 'colour') {
    // Even light and white paper, colours as they are, only a little extra contrast.
    const lums = new Uint8Array(n);
    for (let i = 0; i < n; i++) lums[i] = clamp((flat[i * 3] * 0.299 + flat[i * 3 + 1] * 0.587 + flat[i * 3 + 2] * 0.114) * 255, 0, 255);
    const black = Math.min(60, percentile(lums, 0.005) * 0.6);
    for (let i = 0; i < n; i++) {
      for (let ch = 0; ch < 3; ch++) p[i * 4 + ch] = clamp(((flat[i * 3 + ch] * 255) / 0.97 - black) * (255 / (255 - black)), 0, 255);
    }
  } else if (filter === 'auto') {
    // Paper to white, ink a little darker, colour a little stronger.
    const lums = new Uint8Array(n);
    for (let i = 0; i < n; i++) lums[i] = clamp((flat[i * 3] * 0.299 + flat[i * 3 + 1] * 0.587 + flat[i * 3 + 2] * 0.114) * 255, 0, 255);
    const black = Math.min(110, percentile(lums, 0.01));
    const white = 236;
    for (let i = 0; i < n; i++) {
      const vals = [0, 1, 2].map((ch) => (flat[i * 3 + ch] * 255 - black) / (white - black));
      const mean = (vals[0] + vals[1] + vals[2]) / 3;
      for (let ch = 0; ch < 3; ch++) {
        let v = mean + (vals[ch] - mean) * 1.25; // a touch more colour
        v = clamp(v, 0, 1);
        v = v < 1 ? Math.pow(v, 1.35) : 1; // darker ink, paper stays white
        p[i * 4 + ch] = v * 255;
      }
    }
  } else {
    const grey = new Float32Array(n);
    for (let i = 0; i < n; i++) grey[i] = clamp((flat[i * 3] * 0.299 + flat[i * 3 + 1] * 0.587 + flat[i * 3 + 2] * 0.114) * 255, 0, 255);
    if (filter === 'grey') {
      const black = Math.min(110, percentile(grey, 0.01));
      for (let i = 0; i < n; i++) {
        let v = clamp((grey[i] - black) / (236 - black), 0, 1);
        v = v < 1 ? Math.pow(v, 1.3) : 1;
        p[i * 4] = p[i * 4 + 1] = p[i * 4 + 2] = v * 255;
      }
    } else {
      // Black & white: the paper is already flat, so a threshold works almost
      // everywhere; a local check keeps faint pencil and thin strokes.
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
      const half = Math.max(6, Math.round(Math.max(w, hgt) / 40));
      for (let y = 0; y < hgt; y++) {
        const y1 = Math.max(0, y - half);
        const y2 = Math.min(hgt, y + half + 1);
        for (let x = 0; x < w; x++) {
          const x1 = Math.max(0, x - half);
          const x2 = Math.min(w, x + half + 1);
          const area = (x2 - x1) * (y2 - y1);
          const mean = (integral[y2 * (w + 1) + x2] - integral[y1 * (w + 1) + x2] - integral[y2 * (w + 1) + x1] + integral[y1 * (w + 1) + x1]) / area;
          const v = grey[y * w + x];
          const ink = v < 150 || (v < mean - 18 && v < 215);
          const i = (y * w + x) * 4;
          p[i] = p[i + 1] = p[i + 2] = ink ? 0 : 255;
        }
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return out;
}
