// A small spreadsheet formula engine: =A1+B2*2, =SUM(A1:A10), =IF(A1>3,"yes","no") ...

export class FormulaError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const err = (code) => { throw new FormulaError(code); };

export function colName(index) {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}
export function colIndex(name) {
  let n = 0;
  for (const ch of name.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
export function parseRef(ref) {
  const m = /^\$?([A-Z]+)\$?(\d+)$/i.exec(ref);
  return m ? { c: colIndex(m[1]), r: Number(m[2]) - 1 } : null;
}
export const refName = (c, r) => `${colName(c)}${r + 1}`;

// ---------- Tokenizer ----------
const TOKEN = /\s*(?:(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+)|("(?:[^"]|"")*")|(\$?[A-Za-z]+\$?\d+(?::\$?[A-Za-z]+\$?\d+)?)|([A-Za-z_][A-Za-z0-9_.]*)|(<>|<=|>=|[-+*/^&=<>(),%:]))/y;

function tokenize(src) {
  const tokens = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < src.length) {
    if (/^\s*$/.test(src.slice(TOKEN.lastIndex))) break;
    const start = TOKEN.lastIndex;
    const m = TOKEN.exec(src);
    if (!m || TOKEN.lastIndex === start) err('#ERROR!');
    if (m[1]) tokens.push({ t: 'num', v: Number(m[1]) });
    else if (m[2]) tokens.push({ t: 'str', v: m[2].slice(1, -1).replace(/""/g, '"') });
    else if (m[3]) tokens.push({ t: 'ref', v: m[3].toUpperCase().replace(/\$/g, '') });
    else if (m[4]) tokens.push({ t: 'name', v: m[4].toUpperCase() });
    else tokens.push({ t: 'op', v: m[5] });
  }
  return tokens;
}

// ---------- Parser (recursive descent, Excel precedence) ----------
function parse(src) {
  const tokens = tokenize(src);
  let i = 0;
  const peek = () => tokens[i];
  const isOp = (v) => peek()?.t === 'op' && peek().v === v;
  const take = () => tokens[i++];
  const expect = (v) => { if (!isOp(v)) err('#ERROR!'); i++; };

  function comparison() {
    let left = concat();
    while (peek()?.t === 'op' && ['=', '<>', '<', '>', '<=', '>='].includes(peek().v)) {
      const op = take().v;
      left = { k: 'bin', op, a: left, b: concat() };
    }
    return left;
  }
  function concat() {
    let left = additive();
    while (isOp('&')) { take(); left = { k: 'bin', op: '&', a: left, b: additive() }; }
    return left;
  }
  function additive() {
    let left = term();
    while (isOp('+') || isOp('-')) { const op = take().v; left = { k: 'bin', op, a: left, b: term() }; }
    return left;
  }
  function term() {
    let left = power();
    while (isOp('*') || isOp('/')) { const op = take().v; left = { k: 'bin', op, a: left, b: power() }; }
    return left;
  }
  function power() {
    let left = unary();
    while (isOp('^')) { take(); left = { k: 'bin', op: '^', a: left, b: unary() }; }
    return left;
  }
  function unary() {
    if (isOp('-')) { take(); return { k: 'neg', a: unary() }; }
    if (isOp('+')) { take(); return unary(); }
    let node = primary();
    while (isOp('%')) { take(); node = { k: 'bin', op: '/', a: node, b: { k: 'num', v: 100 } }; }
    return node;
  }
  function primary() {
    const tok = take();
    if (!tok) err('#ERROR!');
    if (tok.t === 'num') return { k: 'num', v: tok.v };
    if (tok.t === 'str') return { k: 'str', v: tok.v };
    if (tok.t === 'ref') {
      const [a, b] = tok.v.split(':');
      return b ? { k: 'range', a, b } : { k: 'ref', v: a };
    }
    if (tok.t === 'name') {
      if (tok.v === 'TRUE' || tok.v === 'FALSE') return { k: 'bool', v: tok.v === 'TRUE' };
      if (!isOp('(')) err('#NAME?');
      take();
      const args = [];
      if (!isOp(')')) {
        do { args.push(comparison()); } while (isOp(',') && take());
      }
      expect(')');
      return { k: 'call', name: tok.v, args };
    }
    if (tok.t === 'op' && tok.v === '(') { const e = comparison(); expect(')'); return e; }
    err('#ERROR!');
  }

  const tree = comparison();
  if (i < tokens.length) err('#ERROR!');
  return tree;
}

// ---------- Evaluation ----------
const num = (v) => {
  if (v instanceof FormulaError) throw v;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === '' || v == null) return 0;
  const n = Number(v);
  if (Number.isNaN(n)) err('#VALUE!');
  return n;
};
const str = (v) => (v == null ? '' : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v));
const truthy = (v) => (typeof v === 'string' ? v.toUpperCase() === 'TRUE' || (v !== '' && v !== 'FALSE' && num(v) !== 0) : !!num(v));
const flat = (args) => args.flat(Infinity);
const numbers = (args) => flat(args).filter((v) => typeof v === 'number');

function criteria(test) {
  const m = /^(<>|<=|>=|=|<|>)?(.*)$/.exec(str(test));
  const op = m[1] || '=';
  const target = m[2];
  const asNum = target !== '' && !Number.isNaN(Number(target)) ? Number(target) : null;
  return (v) => {
    if (asNum !== null && typeof v === 'number') {
      return { '=': v === asNum, '<>': v !== asNum, '<': v < asNum, '>': v > asNum, '<=': v <= asNum, '>=': v >= asNum }[op];
    }
    const a = str(v).toLowerCase();
    const b = target.toLowerCase();
    if (op === '=') return new RegExp(`^${b.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`).test(a);
    if (op === '<>') return a !== b;
    return false;
  };
}

const round = (n, d, mode = Math.round) => { const f = 10 ** d; return mode(n * f) / f; };

const FUNCS = {
  SUM: (...a) => numbers(a).reduce((s, n) => s + n, 0),
  AVERAGE: (...a) => { const n = numbers(a); if (!n.length) err('#DIV/0!'); return n.reduce((s, x) => s + x, 0) / n.length; },
  MIN: (...a) => { const n = numbers(a); return n.length ? Math.min(...n) : 0; },
  MAX: (...a) => { const n = numbers(a); return n.length ? Math.max(...n) : 0; },
  COUNT: (...a) => numbers(a).length,
  COUNTA: (...a) => flat(a).filter((v) => v !== '' && v != null).length,
  COUNTBLANK: (...a) => flat(a).filter((v) => v === '' || v == null).length,
  PRODUCT: (...a) => numbers(a).reduce((s, n) => s * n, 1),
  MEDIAN: (...a) => {
    const n = numbers(a).sort((x, y) => x - y);
    if (!n.length) err('#NUM!');
    const mid = Math.floor(n.length / 2);
    return n.length % 2 ? n[mid] : (n[mid - 1] + n[mid]) / 2;
  },
  ROUND: (n, d = 0) => round(num(n), num(d)),
  ROUNDUP: (n, d = 0) => round(num(n), num(d), (x) => Math.sign(x) * Math.ceil(Math.abs(x))),
  ROUNDDOWN: (n, d = 0) => round(num(n), num(d), Math.trunc),
  INT: (n) => Math.floor(num(n)),
  ABS: (n) => Math.abs(num(n)),
  SQRT: (n) => { if (num(n) < 0) err('#NUM!'); return Math.sqrt(num(n)); },
  POWER: (a, b) => num(a) ** num(b),
  MOD: (a, b) => { if (num(b) === 0) err('#DIV/0!'); const r = num(a) % num(b); return r && Math.sign(r) !== Math.sign(num(b)) ? r + num(b) : r; },
  PI: () => Math.PI,
  RAND: () => Math.random(),
  IF: (c, a = true, b = false) => (truthy(c) ? a : b),
  IFERROR: (v, fallback) => v,
  AND: (...a) => flat(a).every(truthy),
  OR: (...a) => flat(a).some(truthy),
  NOT: (v) => !truthy(v),
  LEN: (s) => str(s).length,
  UPPER: (s) => str(s).toUpperCase(),
  LOWER: (s) => str(s).toLowerCase(),
  PROPER: (s) => str(s).toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()),
  TRIM: (s) => str(s).trim().replace(/\s+/g, ' '),
  LEFT: (s, n = 1) => str(s).slice(0, num(n)),
  RIGHT: (s, n = 1) => (num(n) ? str(s).slice(-num(n)) : ''),
  MID: (s, start, n) => str(s).substr(num(start) - 1, num(n)),
  CONCAT: (...a) => flat(a).map(str).join(''),
  CONCATENATE: (...a) => flat(a).map(str).join(''),
  TEXT: (v) => str(v),
  VALUE: (v) => num(v),
  TODAY: () => new Date().toLocaleDateString(),
  NOW: () => new Date().toLocaleString(),
  SUMIF: (range, test, sumRange) => {
    const match = criteria(test);
    const vals = flat([range]);
    const sums = sumRange ? flat([sumRange]) : vals;
    return vals.reduce((s, v, i) => (match(v) ? s + (typeof sums[i] === 'number' ? sums[i] : 0) : s), 0);
  },
  COUNTIF: (range, test) => { const match = criteria(test); return flat([range]).filter(match).length; },
  AVERAGEIF: (range, test, avgRange) => {
    const match = criteria(test);
    const vals = flat([range]);
    const src = avgRange ? flat([avgRange]) : vals;
    const picked = vals.map((v, i) => (match(v) ? src[i] : null)).filter((v) => typeof v === 'number');
    if (!picked.length) err('#DIV/0!');
    return picked.reduce((s, n) => s + n, 0) / picked.length;
  },
  VLOOKUP: (key, table, col, approx = true) => {
    const c = num(col) - 1;
    if (!Array.isArray(table) || c < 0 || c >= (table[0]?.length || 0)) err('#REF!');
    if (!truthy(approx)) {
      const row = table.find((r) => str(r[0]).toLowerCase() === str(key).toLowerCase());
      if (!row) err('#N/A');
      return row[c];
    }
    let found = null;
    for (const r of table) { if (num(r[0]) <= num(key)) found = r; else break; }
    if (!found) err('#N/A');
    return found[c];
  },
};
FUNCS.AVG = FUNCS.AVERAGE;
export const FUNCTION_NAMES = Object.keys(FUNCS).sort();

const cache = new Map();
function compile(src) {
  if (!cache.has(src)) {
    try { cache.set(src, parse(src)); } catch (e) { cache.set(src, e); }
  }
  const tree = cache.get(src);
  if (tree instanceof Error) throw tree;
  return tree;
}

// getValue(ref) returns the computed value of another cell.
export function evaluate(formula, getValue) {
  const evalNode = (n) => {
    switch (n.k) {
      case 'num': case 'str': case 'bool': return n.v;
      case 'ref': {
        if (!parseRef(n.v)) err('#REF!');
        const v = getValue(n.v);
        if (v instanceof FormulaError) throw v;
        return v;
      }
      case 'range': {
        const a = parseRef(n.a);
        const b = parseRef(n.b);
        if (!a || !b) err('#REF!');
        const rows = [];
        for (let r = Math.min(a.r, b.r); r <= Math.max(a.r, b.r); r++) {
          const row = [];
          for (let c = Math.min(a.c, b.c); c <= Math.max(a.c, b.c); c++) {
            const v = getValue(refName(c, r));
            if (v instanceof FormulaError) throw v;
            row.push(v);
          }
          rows.push(row);
        }
        return rows;
      }
      case 'neg': return -num(evalNode(n.a));
      case 'bin': {
        const a = evalNode(n.a);
        const b = evalNode(n.b);
        switch (n.op) {
          case '+': return num(a) + num(b);
          case '-': return num(a) - num(b);
          case '*': return num(a) * num(b);
          case '/': if (num(b) === 0) err('#DIV/0!'); return num(a) / num(b);
          case '^': return num(a) ** num(b);
          case '&': return str(a) + str(b);
          default: {
            const x = typeof a === 'string' ? a.toLowerCase() : a ?? 0;
            const y = typeof b === 'string' ? b.toLowerCase() : b ?? 0;
            return { '=': x === y, '<>': x !== y, '<': x < y, '>': x > y, '<=': x <= y, '>=': x >= y }[n.op];
          }
        }
      }
      case 'call': {
        const fn = FUNCS[n.name];
        if (!fn) err('#NAME?');
        if (n.name === 'IFERROR') {
          try { return evalNode(n.args[0]); } catch (e) { if (e instanceof FormulaError) return n.args[1] ? evalNode(n.args[1]) : ''; throw e; }
        }
        if (n.name === 'IF') {
          return truthy(evalNode(n.args[0])) ? (n.args[1] ? evalNode(n.args[1]) : true) : (n.args[2] ? evalNode(n.args[2]) : false);
        }
        return fn(...n.args.map(evalNode));
      }
      default: return err('#ERROR!');
    }
  };
  const result = evalNode(compile(formula));
  if (Array.isArray(result)) return result[0]?.[0] ?? 0;
  if (typeof result === 'number' && !Number.isFinite(result)) err('#NUM!');
  return result;
}

// Shift relative references when a formula is copied or filled to another cell.
export function shiftFormula(formula, dc, dr) {
  return formula.replace(/("(?:[^"]|"")*")|(\$?)([A-Z]+)(\$?)(\d+)(?![A-Z0-9(])/gi, (m, quoted, cAbs, col, rAbs, row) => {
    if (quoted) return quoted;
    const c = cAbs ? colIndex(col) : colIndex(col) + dc;
    const r = rAbs ? Number(row) - 1 : Number(row) - 1 + dr;
    if (c < 0 || r < 0) return '#REF!';
    return `${cAbs}${colName(c)}${rAbs}${r + 1}`;
  });
}

// Update references when rows/columns are inserted or deleted.
export function adjustFormula(formula, axis, at, delta) {
  return formula.replace(/("(?:[^"]|"")*")|(\$?)([A-Z]+)(\$?)(\d+)(?![A-Z0-9(])/gi, (m, quoted, cAbs, col, rAbs, row) => {
    if (quoted) return quoted;
    let c = colIndex(col);
    let r = Number(row) - 1;
    if (axis === 'row' && r >= at) { if (delta < 0 && r < at - delta) return '#REF!'; r += delta; }
    if (axis === 'col' && c >= at) { if (delta < 0 && c < at - delta) return '#REF!'; c += delta; }
    return `${cAbs}${colName(c)}${rAbs}${r + 1}`;
  });
}
