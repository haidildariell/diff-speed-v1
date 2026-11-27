// diff-speed v1 — a fast drop-in for makefun-diff 1.0.0.
//
// Same answers, byte for byte, on every input { old, new }: the same line
// split (after every "\n" only), the same common prefix then suffix trim,
// the same Myers greedy search (furthest point per diagonal, deletion wins
// a tie, no edge-diagonal pruning, full snake after every step), and the
// same patch layout (3 context lines, runs at most 6 kept lines apart share
// a hunk, deletions before insertions, "%" after a line with no newline).
//
// Speed comes from doing the expensive comparisons once: every distinct
// line is hashed to a small integer up front, so the Myers inner loop and
// the snakes compare integers instead of strings; the search itself runs
// on flat Int32Arrays with one snapshot per depth, and the patch is built
// from a flat op array and joined once, with no per-line string
// concatenation in the hot paths.

const FORMAT = 'makefun-diff/1';
const CONTEXT = 3;

// Op codes in the flat op array, in patch order.
const KEEP = 0;
const DELETE = 1;
const INSERT = 2;

/** Cut a text into lines after every "\n"; a last line without one stays so. */
function splitLines(text) {
  const lines = [];
  let start = 0;
  for (;;) {
    const nl = text.indexOf('\n', start);
    if (nl === -1) {
      if (start < text.length) lines.push(text.slice(start));
      return lines;
    }
    lines.push(text.slice(start, nl + 1));
    start = nl + 1;
  }
}

/**
 * The edit script of the middle slices as a flat op array (KEEP/DELETE/
 * INSERT per line, in order). a and b hold integer line ids; the slices
 * start at aOff/bOff and are N/M lines long. The script is the one Myers's
 * greedy search finds first: depths increasing, diagonals from -d to d,
 * deletion preferred on a tie, and the first path to reach both ends wins.
 */
function myersOps(a, b, aOff, bOff, N, M) {
  if (N === 0) return new Uint8Array(M).fill(INSERT);
  if (M === 0) return new Uint8Array(N).fill(DELETE);

  const maxD = N + M;
  // One snapshot per depth: trace[d] lists, for k = -d..d step 2 (index
  // j = (k + d) / 2, so d + 1 entries), the furthest old-lines-consumed
  // count reached at that depth, -1 when no path runs on that diagonal.
  // The previous row alone supplies both candidates for the next depth:
  // diagonal k - 1 sits at index j - 1, diagonal k + 1 at index j.
  const trace = [];

  // Depth 0: the opening snake from (0, 0).
  let x = 0;
  while (x < N && x < M && a[aOff + x] === b[bOff + x]) x++;
  let prev = Int32Array.of(x);
  trace.push(prev);
  let D = -1;
  let kEnd = 0;
  if (x >= N && x >= M) {
    D = 0;
  } else {
    outer: for (let d = 1; d <= maxD; d++) {
      const row = new Int32Array(d + 1);
      for (let j = 0; j <= d; j++) {
        const k = -d + 2 * j;
        const xDel = j > 0 ? prev[j - 1] : -1;
        const xIns = j < d ? prev[j] : -1;
        // A deletion is possible when the k-1 path has an old line left to
        // delete; an insertion when the k+1 path has a new line left.
        const canDel = xDel >= 0 && xDel < N;
        const yIns = xIns - (k + 1);
        const canIns = xIns >= 0 && yIns < M;
        if (!canDel && !canIns) {
          row[j] = -1;
          continue;
        }
        // Further into the old text wins; on a tie the deletion does.
        const byDel = canDel ? xDel + 1 : -2;
        const byIns = canIns ? xIns : -2;
        let xx = byDel >= byIns ? byDel : byIns;
        let y = xx - k;
        while (xx < N && y < M && a[aOff + xx] === b[bOff + y]) {
          xx++;
          y++;
        }
        row[j] = xx;
        if (xx >= N && y >= M) {
          D = d;
          kEnd = k;
          trace.push(row);
          break outer;
        }
      }
      trace.push(row);
      prev = row;
    }
  }
  if (D < 0) throw new Error('diff-speed: the search ended without reaching both ends');

  // Walk the winning path back from (N, M), emitting ops in reverse. At
  // each depth the pre-snake point is the edit's landing (byDel/byIns, the
  // same choice the forward pass made), and the keeps are the snake's
  // length from there to the stored furthest point — never found by
  // comparing lines back, which would eat past the edit when the lines
  // just before it happen to match across the diagonal.
  const ops = new Uint8Array(N + M);
  let w = N + M;
  x = N;
  let k = kEnd;
  for (let d = D; d > 0; d--) {
    const prev = trace[d - 1];
    // Which edit led here: recompute the same choice the forward pass made.
    const kd = (k - 1 + (d - 1)) / 2;
    const ki = (k + 1 + (d - 1)) / 2;
    const xDel = kd >= 0 && kd < prev.length ? prev[kd] : -1;
    const xIns = ki >= 0 && ki < prev.length ? prev[ki] : -1;
    const canDel = xDel >= 0 && xDel < N;
    const yIns = xIns - (k + 1);
    const canIns = xIns >= 0 && yIns < M;
    const byDel = canDel ? xDel + 1 : -2;
    const byIns = canIns ? xIns : -2;
    const x0 = byDel >= byIns ? byDel : byIns;
    for (let i = x - x0; i > 0; i--) ops[--w] = KEEP;
    if (byDel >= byIns) {
      ops[--w] = DELETE;
      x = xDel;
      k = k - 1;
    } else {
      ops[--w] = INSERT;
      x = xIns;
      k = k + 1;
    }
  }
  // Depth 0: what is left is the opening snake, x keeps from (0, 0).
  for (let i = x; i > 0; i--) ops[--w] = KEEP;
  return ops.subarray(w);
}

/** Render the patch for the full texts from the middle slices' op array. */
function renderPatch(aLines, bLines, ops, prefix, suffix) {
  const n = aLines.length;
  const m = bLines.length;
  // Change runs: maximal stretches of deletions/insertions between kept
  // lines, at old line o and new line p.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  // The prefix and suffix are kept lines; the middle ops sit between them.
  const totalOps = prefix + ops.length + suffix;
  for (let t = 0; t < totalOps; t++) {
    const op = t < prefix ? KEEP : t < prefix + ops.length ? ops[t - prefix] : KEEP;
    if (op === KEEP) {
      o++;
      p++;
      continue;
    }
    let c = changes[changes.length - 1];
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (op === DELETE) {
      c.dels++;
      o++;
      deleted++;
    } else {
      c.ins++;
      p++;
      inserted++;
    }
  }

  // Hunks: change runs at most 2 * CONTEXT kept lines apart share one.
  const hunks = [];
  for (const c of changes) {
    const h = hunks[hunks.length - 1];
    const prev = h !== undefined ? h[h.length - 1] : undefined;
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 2 * CONTEXT) h.push(c);
    else hunks.push([c]);
  }

  const aNoNL = n > 0 && !aLines[n - 1].endsWith('\n');
  const bNoNL = m > 0 && !bLines[m - 1].endsWith('\n');
  const out = [`${FORMAT} old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - CONTEXT);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(CONTEXT, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) {
        if (at === n - 1 && aNoNL) out.push('=', aLines[at], '\n%\n');
        else out.push('=', aLines[at]);
      }
      for (let i = 0; i < c.dels; i++) {
        const idx = c.o + i;
        if (idx === n - 1 && aNoNL) out.push('-', aLines[idx], '\n%\n');
        else out.push('-', aLines[idx]);
      }
      for (let i = 0; i < c.ins; i++) {
        const idx = c.p + i;
        if (idx === m - 1 && bNoNL) out.push('+', bLines[idx], '\n%\n');
        else out.push('+', bLines[idx]);
      }
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) {
      if (at === n - 1 && aNoNL) out.push('=', aLines[at], '\n%\n');
      else out.push('=', aLines[at]);
    }
  }
  return out.join('');
}

/** make.fun's own patch of input.old into input.new, as one string. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('diff-speed: the input is { old, new }, two strings');
  }
  const oldText = input.old;
  const newText = input.new;

  // Identical texts are the header alone.
  if (oldText === newText) {
    let n = 0;
    for (let i = oldText.indexOf('\n'); i !== -1; i = oldText.indexOf('\n', i + 1)) n++;
    if (oldText.length > 0 && !oldText.endsWith('\n')) n++;
    return `${FORMAT} old=${n} new=${n} hunks=0 deleted=0 inserted=0\n`;
  }

  const aLines = splitLines(oldText);
  const bLines = splitLines(newText);

  // One shared id per distinct line, so every later comparison is on ints.
  const ids = new Map();
  const a = new Int32Array(aLines.length);
  for (let i = 0; i < aLines.length; i++) {
    let id = ids.get(aLines[i]);
    if (id === undefined) {
      id = ids.size;
      ids.set(aLines[i], id);
    }
    a[i] = id;
  }
  const b = new Int32Array(bLines.length);
  for (let i = 0; i < bLines.length; i++) {
    let id = ids.get(bLines[i]);
    if (id === undefined) {
      id = ids.size;
      ids.set(bLines[i], id);
    }
    b[i] = id;
  }

  // The common prefix, then the common suffix of what is left.
  const n = a.length;
  const m = b.length;
  let prefix = 0;
  while (prefix < n && prefix < m && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && a[n - 1 - suffix] === b[m - 1 - suffix]) suffix++;

  const ops = myersOps(a, b, prefix, prefix, n - prefix - suffix, m - prefix - suffix);
  return renderPatch(aLines, bLines, ops, prefix, suffix);
}
