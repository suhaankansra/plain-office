// Charts for Sheets and Slides, drawn as SVG (no libraries, works offline).
// data: { labels: [string], series: [{ name, values: [number] }] }

export const CHART_TYPES = [
  { value: 'column', label: 'Column', icon: 'chart' },
  { value: 'bar', label: 'Bar', icon: 'barH' },
  { value: 'line', label: 'Line', icon: 'lineChart' },
  { value: 'area', label: 'Area', icon: 'area' },
  { value: 'pie', label: 'Pie', icon: 'pie' },
  { value: 'doughnut', label: 'Doughnut', icon: 'pie' },
];

export const PALETTE = ['#2b6fdc', '#e8711a', '#1f9d55', '#d93a3a', '#6a4cd6', '#14a3a3', '#c2409b', '#f2c200', '#8a939d', '#0b3d91'];

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (n) => {
  const a = Math.abs(n);
  if (a >= 1e9) return `${+(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${+(n / 1e3).toFixed(1)}K`;
  return String(+n.toFixed(2));
};

// Round axis steps to 1, 2, 2.5 or 5 x 10^n.
function niceScale(min, max, ticks = 5) {
  if (min === max) { max = min + 1; if (min > 0) min = 0; }
  const raw = (max - min) / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  return { min: Math.floor(min / step) * step, max: Math.ceil(max / step) * step, step };
}

export function chartSvg({ type = 'column', title = '', data, width = 480, height = 300, showLegend = true }) {
  const labels = data?.labels || [];
  const series = (data?.series || []).filter((s) => s.values?.length);
  const W = width;
  const H = height;
  const parts = [];
  const top = title ? 38 : 14;
  const pieLike = type === 'pie' || type === 'doughnut';
  const legendItems = pieLike ? labels : series.map((s) => s.name);
  const legend = showLegend && (pieLike || series.length > 1) && legendItems.length;
  const bottomLegend = legend ? 26 : 0;

  if (title) parts.push(`<text x="${W / 2}" y="24" text-anchor="middle" font-size="17" font-weight="700" fill="currentColor">${esc(title)}</text>`);
  if (!series.length) {
    parts.push(`<text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-size="14" fill="currentColor" opacity="0.6">Select some numbers for this chart</text>`);
    return wrap(parts, W, H);
  }

  if (pieLike) {
    const values = series[0].values.map((v) => Math.max(0, Number(v) || 0));
    const total = values.reduce((a, b) => a + b, 0) || 1;
    const cx = W / 2;
    const cy = top + (H - top - bottomLegend) / 2;
    const r = Math.min(W / 2 - 20, (H - top - bottomLegend) / 2 - 8);
    const inner = type === 'doughnut' ? r * 0.56 : 0;
    let angle = -Math.PI / 2;
    values.forEach((v, i) => {
      if (!v) return;
      const a = (v / total) * Math.PI * 2;
      const end = angle + a;
      const large = a > Math.PI ? 1 : 0;
      const p = (rad, rr) => `${cx + Math.cos(rad) * rr},${cy + Math.sin(rad) * rr}`;
      const color = PALETTE[i % PALETTE.length];
      if (a >= Math.PI * 2 - 1e-6) {
        parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}"/>`);
        if (inner) parts.push(`<circle cx="${cx}" cy="${cy}" r="${inner}" fill="var(--chart-bg, #fff)"/>`);
      } else if (inner) {
        parts.push(`<path d="M${p(angle, r)} A${r},${r} 0 ${large} 1 ${p(end, r)} L${p(end, inner)} A${inner},${inner} 0 ${large} 0 ${p(angle, inner)}Z" fill="${color}" stroke="var(--chart-bg, #fff)" stroke-width="2"/>`);
      } else {
        parts.push(`<path d="M${cx},${cy} L${p(angle, r)} A${r},${r} 0 ${large} 1 ${p(end, r)}Z" fill="${color}" stroke="var(--chart-bg, #fff)" stroke-width="2"/>`);
      }
      if (v / total > 0.06) {
        const mid = angle + a / 2;
        const lr = inner ? (r + inner) / 2 : r * 0.64;
        parts.push(`<text x="${cx + Math.cos(mid) * lr}" y="${cy + Math.sin(mid) * lr + 5}" text-anchor="middle" font-size="13" font-weight="700" fill="#fff">${Math.round((v / total) * 100)}%</text>`);
      }
      angle = end;
    });
  } else {
    const all = series.flatMap((s) => s.values.map((v) => Number(v) || 0));
    const { min, max, step } = niceScale(Math.min(0, ...all), Math.max(0, ...all));
    const horizontal = type === 'bar';
    const left = horizontal ? Math.min(110, 12 + Math.max(...labels.map((l) => String(l).length), 1) * 7) : 46;
    const right = 14;
    const bottom = 26 + bottomLegend;
    const plotW = W - left - right;
    const plotH = H - top - bottom;
    const n = Math.max(labels.length, ...series.map((s) => s.values.length));
    const val = (v) => (horizontal ? left + ((v - min) / (max - min)) * plotW : top + plotH - ((v - min) / (max - min)) * plotH);
    // Grid lines and value labels.
    for (let t = min; t <= max + step / 2; t += step) {
      const pos = val(t);
      if (horizontal) {
        parts.push(`<line x1="${pos}" y1="${top}" x2="${pos}" y2="${top + plotH}" stroke="currentColor" stroke-opacity="0.12"/>`);
        parts.push(`<text x="${pos}" y="${top + plotH + 17}" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.7">${fmt(t)}</text>`);
      } else {
        parts.push(`<line x1="${left}" y1="${pos}" x2="${left + plotW}" y2="${pos}" stroke="currentColor" stroke-opacity="0.12"/>`);
        parts.push(`<text x="${left - 6}" y="${pos + 4}" text-anchor="end" font-size="11" fill="currentColor" opacity="0.7">${fmt(t)}</text>`);
      }
    }
    const band = (horizontal ? plotH : plotW) / n;
    const showEvery = Math.ceil(n / (horizontal ? 14 : Math.max(1, Math.floor(plotW / 46))));
    labels.forEach((l, i) => {
      if (i % showEvery) return;
      const c = (horizontal ? top : left) + band * (i + 0.5);
      const text = esc(String(l).length > 12 ? `${String(l).slice(0, 11)}…` : l);
      parts.push(horizontal
        ? `<text x="${left - 6}" y="${c + 4}" text-anchor="end" font-size="11" fill="currentColor" opacity="0.8">${text}</text>`
        : `<text x="${c}" y="${top + plotH + 17}" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.8">${text}</text>`);
    });
    const zero = val(0);
    if (type === 'column' || type === 'bar') {
      const gw = band * 0.76;
      const bw = gw / series.length;
      series.forEach((s, si) => {
        const color = PALETTE[si % PALETTE.length];
        s.values.forEach((v, i) => {
          const pos = val(Number(v) || 0);
          const off = (horizontal ? top : left) + band * i + (band - gw) / 2 + bw * si;
          if (horizontal) parts.push(`<rect x="${Math.min(zero, pos)}" y="${off}" width="${Math.abs(pos - zero)}" height="${Math.max(1, bw - 2)}" rx="2" fill="${color}"/>`);
          else parts.push(`<rect x="${off}" y="${Math.min(zero, pos)}" width="${Math.max(1, bw - 2)}" height="${Math.abs(pos - zero)}" rx="2" fill="${color}"/>`);
        });
      });
    } else {
      series.forEach((s, si) => {
        const color = PALETTE[si % PALETTE.length];
        const pts = s.values.map((v, i) => [left + band * (i + 0.5), val(Number(v) || 0)]);
        const line = pts.map((p) => p.join(',')).join(' ');
        if (type === 'area') parts.push(`<polygon points="${pts[0][0]},${zero} ${line} ${pts[pts.length - 1][0]},${zero}" fill="${color}" fill-opacity="0.28"/>`);
        parts.push(`<polyline points="${line}" fill="none" stroke="${color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`);
        if (pts.length <= 24) pts.forEach(([x, y]) => parts.push(`<circle cx="${x}" cy="${y}" r="3.5" fill="${color}"/>`));
      });
    }
    parts.push(horizontal
      ? `<line x1="${zero}" y1="${top}" x2="${zero}" y2="${top + plotH}" stroke="currentColor" stroke-opacity="0.45"/>`
      : `<line x1="${left}" y1="${zero}" x2="${left + plotW}" y2="${zero}" stroke="currentColor" stroke-opacity="0.45"/>`);
  }

  if (legend) {
    const items = legendItems.slice(0, 8).map((name, i) => ({ name: String(name).slice(0, 16), color: PALETTE[i % PALETTE.length] }));
    const widths = items.map((it) => 22 + it.name.length * 6.6);
    let x = Math.max(8, (W - widths.reduce((a, b) => a + b, 0)) / 2);
    const y = H - 10;
    items.forEach((it, i) => {
      parts.push(`<rect x="${x}" y="${y - 9}" width="11" height="11" rx="3" fill="${it.color}"/><text x="${x + 15}" y="${y}" font-size="11.5" fill="currentColor">${esc(it.name)}</text>`);
      x += widths[i];
    });
  }
  return wrap(parts, W, H);
}

function wrap(parts, W, H) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" font-family="-apple-system, system-ui, Roboto, Arial, sans-serif">${parts.join('')}</svg>`;
}

// Turn a block of cell values (rows of values) into chart data: a text first
// row becomes series names, a text first column becomes labels.
export function tableToChartData(rows) {
  rows = rows.filter((r) => r.some((v) => v !== '' && v != null));
  if (!rows.length) return { labels: [], series: [] };
  const isNum = (v) => typeof v === 'number' || (v !== '' && v != null && !Number.isNaN(Number(v)));
  const header = rows.length > 1 && rows[0].slice(1).some((v) => v !== '' && !isNum(v));
  const body = header ? rows.slice(1) : rows;
  const labelCol = body.some((r) => r[0] !== '' && r[0] != null && !isNum(r[0])) || (header && !isNum(rows[0][0]) && rows[0].length > 1);
  const first = labelCol ? 1 : 0;
  const width = Math.max(...rows.map((r) => r.length));
  const series = [];
  for (let c = first; c < width; c++) {
    const values = body.map((r) => (isNum(r[c]) ? Number(r[c]) : 0));
    if (!body.some((r) => isNum(r[c]))) continue;
    series.push({ name: header ? String(rows[0][c] ?? `Series ${series.length + 1}`) : `Series ${series.length + 1}`, values });
  }
  const labels = body.map((r, i) => (labelCol ? String(r[0] ?? '') : String(i + 1)));
  return { labels, series };
}

// Simple text form for editing chart data by hand (Slides): one row per line.
export function dataToText(data) {
  const head = ['', ...data.series.map((s) => s.name)].join(', ');
  const lines = data.labels.map((l, i) => [l, ...data.series.map((s) => s.values[i] ?? '')].join(', '));
  return [head, ...lines].join('\n');
}
export function textToData(text) {
  const rows = text.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.split(/\t|,/).map((v) => v.trim()));
  return tableToChartData(rows.map((r) => r.map((v) => (v !== '' && !Number.isNaN(Number(v)) ? Number(v) : v))));
}
