// Grid maths. A row of three should read as a set, so cohesion is scored on
// project, palette and category, and auto-arrange packs the best triples.
// Pure functions; the UI and the server both use them.

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Distance between two palettes: the mean of each colour's nearest neighbour
// in the other palette, normalised to 0..1 across the RGB cube diagonal.
export function paletteDistance(a = [], b = []) {
  const A = a.map(hexToRgb).filter(Boolean), B = b.map(hexToRgb).filter(Boolean);
  if (!A.length || !B.length) return 0.5;
  const near = (p, set) => Math.min(...set.map(q => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])));
  const d = (A.reduce((s, p) => s + near(p, B), 0) / A.length + B.reduce((s, p) => s + near(p, A), 0) / B.length) / 2;
  return Math.min(1, d / 441.67);
}

export function pairAffinity(x, y) {
  if (!x || !y) return 0;
  let s = 1 - paletteDistance(x.palette, y.palette);       // 0..1
  if (x.project && x.project === y.project) s += 0.6;
  if (x.category && x.category === y.category) s += 0.25;
  if (x.aspect && x.aspect === y.aspect) s += 0.1;
  return s;
}

export function rowCohesion(row) {
  const items = row.filter(Boolean);
  if (items.length < 2) return items.length ? 1 : 0;
  let s = 0, n = 0;
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) { s += pairAffinity(items[i], items[j]); n++; }
  return Math.round(Math.min(1, s / n / 1.6) * 100) / 100;
}

// Greedy triple packing: seed each row with the best unplaced item, then add
// the two that fit it best. Rows are then ordered so consecutive rows do not
// share a project where that can be avoided.
export function autoArrange(items, { cols = 3 } = {}) {
  const pool = items.filter(Boolean).slice();
  const rows = [];
  while (pool.length) {
    const seed = pool.shift();
    const row = [seed];
    while (row.length < cols && pool.length) {
      let best = 0, bestScore = -Infinity;
      for (let i = 0; i < pool.length; i++) {
        const sc = row.reduce((s, r) => s + pairAffinity(r, pool[i]), 0);
        if (sc > bestScore) { bestScore = sc; best = i; }
      }
      row.push(pool.splice(best, 1)[0]);
    }
    rows.push(row);
  }
  // Order rows: alternate projects where possible.
  const ordered = [];
  const left = rows.slice();
  while (left.length) {
    const prev = ordered[ordered.length - 1];
    const prevProject = prev && prev[0]?.project;
    let i = left.findIndex(r => r[0]?.project !== prevProject);
    if (i < 0) i = 0;
    ordered.push(left.splice(i, 1)[0]);
  }
  return ordered;
}

export function gridScore(rows) {
  if (!rows.length) return 0;
  return Math.round(rows.reduce((s, r) => s + rowCohesion(r), 0) / rows.length * 100) / 100;
}
