'use strict';

/*
 * Standalone check for lib/zip.js. Verifies the archives we hand users are
 * actually valid: CRCs must pass `unzip -t`, extracted bytes must match the
 * originals, unicode names must survive, and duplicate titles must not collide.
 *
 * Run: node test/zip.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { writeStoredZip, crc32, uniqueName } = require('../lib/zip');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfzip-'));
let failures = 0;

function check(label, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/*
 * A deliberately independent reader: walks the End of Central Directory to the
 * central directory, then reads each entry's payload via its local header.
 * Written against the spec rather than reusing anything from lib/zip.js, so a
 * bug in the writer cannot hide behind a matching bug in the verifier.
 */
function readStoredZip(zipPath) {
  const buf = fs.readFileSync(zipPath);

  // EOCD is at the end, preceded by a variable-length comment (empty here).
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('EOCD signature not found');

  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset + cdSize > buf.length) throw new Error('central directory runs past EOF');

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`bad central header at entry ${i}`);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');

    // Follow the local header to the payload.
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const data = buf.slice(dataStart, dataStart + size);

    entries.push({ name, flags, method, crc, size, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

(async () => {
  console.log('lib/zip.js\n');

  // --- crc32 against a known value -------------------------------------
  // The CRC-32 of "123456789" is a standard test vector.
  check('crc32 known vector', crc32(Buffer.from('123456789')) === 0xcbf43926,
    `got 0x${crc32(Buffer.from('123456789')).toString(16)}`);

  // Chained/incremental CRC must equal the one-shot CRC.
  const whole = Buffer.from('the quick brown fox jumps over the lazy dog');
  const oneShot = crc32(whole);
  const chained = crc32(whole.slice(20), crc32(whole.slice(0, 20)));
  check('crc32 is chainable across chunks', oneShot === chained,
    `${oneShot} vs ${chained}`);

  // --- uniqueName ------------------------------------------------------
  const used = new Set();
  const a = uniqueName('Song.mp3', used);
  const b = uniqueName('Song.mp3', used);
  const c = uniqueName('Song.mp3', used);
  check('duplicate names get suffixed', a === 'Song.mp3' && b === 'Song (2).mp3' && c === 'Song (3).mp3',
    [a, b, c].join(', '));

  // --- build a realistic archive ---------------------------------------
  const sources = [
    // A few MB of random bytes stands in for a real mp3 and exercises the
    // multi-chunk streaming path in both the CRC and payload passes.
    { name: 'Track One.mp3', bytes: crypto.randomBytes(3 * 1024 * 1024) },
    // Non-Latin title: the whole point of the UTF-8 flag bit.
    { name: 'गाना दो.mp3', bytes: crypto.randomBytes(1024) },
    { name: '日本語のうた.mp3', bytes: crypto.randomBytes(64 * 1024) },
    // Same title twice, which a real playlist can absolutely contain.
    { name: 'Track One.mp3', bytes: crypto.randomBytes(2048) },
    // Degenerate but must not corrupt the archive.
    { name: 'Empty.mp3', bytes: Buffer.alloc(0) },
  ];

  const entries = sources.map((s, i) => {
    const p = path.join(tmp, `src${i}.bin`);
    fs.writeFileSync(p, s.bytes);
    return { path: p, name: s.name };
  });

  const zipPath = path.join(tmp, 'playlist.zip');
  const size = await writeStoredZip(entries, zipPath);

  check('archive was created', fs.existsSync(zipPath) && size > 0, `size=${size}`);
  check('reported size matches stat', size === fs.statSync(zipPath).size);

  // --- the real test: does unzip accept it? ----------------------------
  let testOut = '';
  let unzipOk = true;
  try {
    testOut = execFileSync('unzip', ['-t', zipPath], { encoding: 'utf8' });
  } catch (err) {
    unzipOk = false;
    testOut = `${err.message}\n${err.stdout || ''}${err.stderr || ''}`;
  }
  check('unzip -t reports no errors', unzipOk && /No errors detected/i.test(testOut),
    testOut.trim().split('\n').slice(-3).join(' | '));

  // Entry count and names come from our own central-directory parse rather
  // than the `unzip`/`zipinfo` CLI: those ignore the UTF-8 flag (bit 11) and
  // reinterpret names as CP437, which turns every non-Latin title into
  // mojibake. Windows Explorer, macOS Archive Utility and Python's zipfile all
  // honour the flag, so the CLI's rendering is the outlier, not the archive.
  const parsed = readStoredZip(zipPath);
  const listing = parsed.map(e => e.name);
  check('all 5 entries present', listing.length === 5, `got ${listing.length}: ${listing.join(', ')}`);
  check('UTF-8 flag set on every entry', parsed.every(e => (e.flags & 0x0800) !== 0));
  check('every entry is stored, not deflated', parsed.every(e => e.method === 0));
  check('unicode names preserved', listing.includes('गाना दो.mp3') && listing.includes('日本語のうた.mp3'),
    listing.join(', '));
  check('duplicate title disambiguated', listing.includes('Track One.mp3') && listing.includes('Track One (2).mp3'),
    listing.join(', '));

  // --- extract and compare bytes ---------------------------------------
  const expectByName = {
    'Track One.mp3': sources[0].bytes,
    'गाना दो.mp3': sources[1].bytes,
    '日本語のうた.mp3': sources[2].bytes,
    'Track One (2).mp3': sources[3].bytes,
    'Empty.mp3': sources[4].bytes,
  };

  let allMatch = true;
  const mismatches = [];
  for (const [name, expected] of Object.entries(expectByName)) {
    const entry = parsed.find(e => e.name === name);
    if (!entry) { allMatch = false; mismatches.push(`${name} missing`); continue; }
    if (sha(entry.data) !== sha(expected)) { allMatch = false; mismatches.push(`${name} bytes differ`); }
    if (crc32(entry.data) !== entry.crc) { allMatch = false; mismatches.push(`${name} crc mismatch`); }
  }
  check('every entry is byte-identical with a matching CRC', allMatch, mismatches.join('; '));

  // --- error handling --------------------------------------------------
  let threw = false;
  try { await writeStoredZip([], path.join(tmp, 'empty.zip')); } catch (e) { threw = true; }
  check('empty entry list rejected', threw);

  threw = false;
  try {
    await writeStoredZip([{ path: path.join(tmp, 'does-not-exist.bin'), name: 'x.mp3' }],
      path.join(tmp, 'missing.zip'));
  } catch (e) { threw = true; }
  check('missing source file rejected', threw);

  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(err => {
  console.error('\nTest harness crashed:', err);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  process.exit(1);
});
