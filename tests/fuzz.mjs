// tests/fuzz.mjs — differential fuzzer for solve.js against csv-reader 1.0.0's readCsv.
//
// Generates random inputs biased at the tricky corners (BOM, CRLF, lone CR, stray CRs, "" escapes,
// unclosed quotes, quote+junk, long/short rows, header true/false, empty text, CR-only lines,
// astral characters), and asserts run(input) equals the reference's readCsv(input) for every case.
// The reference is imported from the kit by absolute file URL; it is a test and is never imported
// by solve.js or main.ts at grade time.
//
// Usage: node tests/fuzz.mjs [seed] [cases]   (defaults: 20261121, 1200)

import { run } from '../solve.js';
import { readCsv } from 'file:///home/administrator/.hermes/cache/scratch/bounty20261121/kit-csv/csv-reader-speed-01-run-20261121-kit/baselines/csv-reader/vendor/csv-reader/index.js';

const seed = Number(process.argv[2] ?? 20261121);
const count = Number(process.argv[3] ?? 1200);

// mulberry32: a small, fast, seedable PRNG.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(seed);
const rint = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const pick = (arr) => arr[Math.floor(rng() * arr.length)];
const chance = (p) => rng() < p;

const PLAIN = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india',
  'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra',
  'Zürich', 'São Paulo', 'Kraków', 'Malmö', 'Ōsaka', 'naïve', 'café', 'façade', 'smörgås',
  '東京', '數據', 'Δέλτα', 'Москва', '😀🚀', 'a\ud83D\ude00b', "O'Brien", 'well-known', 'n/a',
  'TBD', '#42', '50%', '(none)', 'x_1', 'A&B', '0', '007', '-123', '12.34', '2026-11-21', 'ZZ-99'];
const WITH_SPACE = ['a b c', 'x y', 'harbor town', 'one two', ' ', '  padded  ', 'a  b'];
const JUNK = ['x', ' kg', ' cm', '!', '?', ' (est.)', 'x"y', ' ', ' a', 'ab', '\rz', '\r\ra', '\uFEFFt', '"end'];

// One field drawn for a record of the file's line break `eol`. `plain` keeps it free of quotes.
function field(rng, eol, plain) {
  const r = rng();
  if (plain) {
    if (r < 0.25) return '';
    if (r < 0.45) return pick(WITH_SPACE);
    return pick(PLAIN);
  }
  if (r < 0.22) return pick(PLAIN); // plain word
  if (r < 0.34) return pick(WITH_SPACE);
  if (r < 0.40) return ''; // empty field
  if (r < 0.48) return pick(PLAIN) === '' ? 'x' : `\"${pick(PLAIN)}\"`; // needless quote
  if (r < 0.54) return '""'; // empty quoted: a record all on its own
  if (r < 0.62) return `\"${pick(PLAIN)}, ${pick(PLAIN)}\"`; // comma inside quotes
  if (r < 0.70) return `\"a\"\"b\"\"\"\"${pick(PLAIN)}\"`; // doubled quotes inside
  if (r < 0.80) {
    const inner = pick([`a${eol}b`, 'a\rb', `x${eol}y${eol}z`, `q\ry`, '']);
    return `\"${inner}\"`; // line breaks inside quotes (the file's own, a lone CR now and then)
  }
  if (r < 0.88) return `${pick(PLAIN)}\r${pick(PLAIN)}`; // stray CR inside an unquoted field
  if (r < 0.94) return `\"${pick(PLAIN)}\"${pick(JUNK)}`; // characters after a closing quote
  return pick(PLAIN).includes('') ? 'z' : `\"${pick(PLAIN).replaceAll('"', '""')}\"${chance(0.5) ? pick(JUNK) : ''}`;
}

// One whole file: {text, header}, drawn to about `target` characters (0 allowed).
function generate(target) {
  const header = chance(0.5);
  const width = rint(1, 10);
  const bom = chance(0.15) ? (chance(0.1) ? '\uFEFF\uFEFF' : '\uFEFF') : '';
  const eol = chance(0.5) ? '\r\n' : '\n';
  const out = [];
  const recs = target === 0 ? 0 : rint(1, Math.ceil(target / 40) + 1);
  if (header) out.push(chance(0.1) ? 'h_1' : Array.from({ length: width }, (_, i) => `h_${i + 1}`).join(','));
  let unterminatedAt = -1;
  if (recs > 0 && chance(0.12)) unterminatedAt = rint(0, recs - 1); // one quote near the end never closes
  for (let r = 0; r < recs; r++) {
    if (chance(0.05)) out.push(''); // a blank line before it
    const bare = r >= unterminatedAt; // from the unterminated quote on, records hold no quote
    let n = width;
    const x = rng();
    if (!bare && x < 0.06 && width > 1) n = Math.max(1, width - rint(1, Math.min(3, width - 1))); // short row
    else if (!bare && x < 0.12) n = width + rint(1, 3); // long row
    const parts = [];
    for (let i = 0; i < n; i++) parts.push(field(rng, eol, bare));
    let line = parts.join(',');
    if (r === unterminatedAt) line = `\"${line}`; // the quote that never closes
    out.push(line);
  }
  // Sometimes a CR-only line (no record, stray_cr errors stay) and sometimes a lone final CR.
  if (chance(0.2)) out.splice(out.length, 0, '\r\r');
  let text = bom + out.join(eol) + (chance(0.7) ? eol : '');
  if (chance(0.15)) text = text + '\r';
  if (chance(0.05)) text = text + '\uFEFFtail';
  return { text, header: header ? (chance(0.9) ? true : pick([1, 'true', null, 0, false])) : (chance(0.9) ? false : pick([0, 'true', null, 1])) };
}

// Deep-equal as JSON values, the way the scorer compares (objects: same keys, any order).
function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

let mismatches = 0;
const shown = [];
for (let i = 0; i < count; i++) {
  // Mostly small files at the corners; a few large ones to hold the fast path honest.
  let input;
  if (i % 150 === 0) input = generate(150_000); // a big one every 150
  else if (i % 30 === 0) input = generate(15_000);
  else input = generate(rint(0, 600));
  if (i % 97 === 0) input = pick([ // a battery of fixed shapes, re-drawn per seed
    { text: '', header: true }, { text: '', header: false },
    { text: '\uFEFF', header: true }, { text: '\r', header: true }, { text: '\r\r\n', header: false },
    { text: '"', header: true }, { text: '""', header: true }, { text: '"""', header: false },
    { text: '"a', header: true }, { text: '"a', header: false }, { text: '"a,b', header: true },
    { text: 'a,b,', header: false }, { text: 'a,"', header: false }, { text: 'a,""\r\nb', header: true },
    { text: 12345, header: true }, { text: null, header: false }, { text: undefined, header: true },
    { text: true, header: false },
  ]);
  const a = run(input);
  const b = readCsv(input);
  if (!same(a, b)) {
    mismatches++;
    if (shown.length < 10) shown.push({ i, input, mine: a, ref: b });
  }
}
for (const s of shown) {
  console.log(`MISMATCH case ${s.i} input=${JSON.stringify(s.input)}`);
  console.log(`  mine: ${JSON.stringify(s.mine).slice(0, 400)}`);
  console.log(`  ref : ${JSON.stringify(s.ref).slice(0, 400)}`);
}
console.log(`seed=${seed}: ${count} random cases, ${mismatches} mismatches`);
process.exitCode = mismatches === 0 ? 0 : 1;
