'use strict';

/*
 * Minimal dependency-free ZIP writer.
 *
 * Entries are written with method 0 (stored). MP3 payloads are already
 * compressed, so deflating them would burn CPU for roughly nothing — this
 * keeps the whole implementation to a few header structs instead of pulling in
 * an archiver dependency, and produces a plain archive that every extractor
 * accepts.
 */

const fs = require('fs');
const zlib = require('zlib');

// zlib.crc32 landed in Node 20.15 / 22.2. package.json allows Node 18, so fall
// back to a table implementation rather than crashing on an older runtime.
const crc32 = (() => {
  if (typeof zlib.crc32 === 'function') {
    return (buf, seed = 0) => zlib.crc32(buf, seed);
  }
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return (buf, seed = 0) => {
    let c = ~seed;
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (~c) >>> 0;
  };
})();

function crc32File(filePath) {
  return new Promise((resolve, reject) => {
    let value = 0;
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => { value = crc32(chunk, value); });
    stream.on('error', reject);
    stream.on('end', () => resolve(value >>> 0));
  });
}

// DOS timestamp packing used by the ZIP local and central headers.
function dosDateTime(date) {
  const year = date.getFullYear();
  // The format cannot represent anything before 1980; clamp rather than write a
  // negative year field that makes the archive look corrupt.
  const safeYear = year < 1980 ? 1980 : year;
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((safeYear - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

// Two tracks can legitimately share a title, and duplicate names inside one
// archive confuse extractors, so disambiguate with a numeric suffix.
function uniqueName(name, usedNames) {
  if (!usedNames.has(name.toLowerCase())) {
    usedNames.add(name.toLowerCase());
    return name;
  }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let n = 2;
  while (usedNames.has(`${stem} (${n})${ext}`.toLowerCase())) n++;
  const out = `${stem} (${n})${ext}`;
  usedNames.add(out.toLowerCase());
  return out;
}

/**
 * Streams `entries` into a stored-mode zip at `outPath`.
 *
 * @param {Array<{path: string, name: string}>} entries source files
 * @param {string} outPath destination archive
 * @returns {Promise<number>} the finished archive size in bytes
 *
 * Each source file is read twice: once for its CRC (the local header needs it
 * up front) and once for the payload. Both passes stream, so memory stays flat
 * regardless of how large the playlist is.
 */
async function writeStoredZip(entries, outPath) {
  if (!Array.isArray(entries) || !entries.length) {
    throw new Error('writeStoredZip: no entries');
  }

  const out = fs.createWriteStream(outPath);
  const writeBuf = (buf) => new Promise((resolve, reject) => {
    out.write(buf, err => (err ? reject(err) : resolve()));
  });

  let offset = 0;
  const central = [];
  const usedNames = new Set();

  try {
    for (const entry of entries) {
      const stat = fs.statSync(entry.path);
      const name = uniqueName(entry.name, usedNames);
      const nameBuf = Buffer.from(name, 'utf8');
      const crc = await crc32File(entry.path);
      const { time, date } = dosDateTime(stat.mtime);
      const size = stat.size;

      if (size > 0xffffffff) {
        throw new Error(`writeStoredZip: ${name} exceeds the 4GB zip32 limit`);
      }

      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);   // local file header signature
      local.writeUInt16LE(20, 4);           // version needed to extract
      local.writeUInt16LE(0x0800, 6);       // flags: UTF-8 filename
      local.writeUInt16LE(0, 8);            // method: stored
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(size, 18);        // compressed size
      local.writeUInt32LE(size, 22);        // uncompressed size
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(0, 28);           // extra field length

      await writeBuf(local);
      await writeBuf(nameBuf);

      const localHeaderOffset = offset;
      offset += local.length + nameBuf.length;

      await new Promise((resolve, reject) => {
        const rs = fs.createReadStream(entry.path);
        rs.on('error', reject);
        rs.on('end', resolve);
        // end:false keeps the archive stream open for the following entries.
        rs.pipe(out, { end: false });
      });
      offset += size;

      central.push({ nameBuf, crc, size, time, date, localHeaderOffset });
    }

    const centralStart = offset;
    for (const e of central) {
      const head = Buffer.alloc(46);
      head.writeUInt32LE(0x02014b50, 0);    // central directory header signature
      head.writeUInt16LE(20, 4);            // version made by
      head.writeUInt16LE(20, 6);            // version needed to extract
      head.writeUInt16LE(0x0800, 8);        // flags: UTF-8 filename
      head.writeUInt16LE(0, 10);            // method: stored
      head.writeUInt16LE(e.time, 12);
      head.writeUInt16LE(e.date, 14);
      head.writeUInt32LE(e.crc, 16);
      head.writeUInt32LE(e.size, 20);       // compressed size
      head.writeUInt32LE(e.size, 24);       // uncompressed size
      head.writeUInt16LE(e.nameBuf.length, 28);
      head.writeUInt16LE(0, 30);            // extra field length
      head.writeUInt16LE(0, 32);            // file comment length
      head.writeUInt16LE(0, 34);            // disk number start
      head.writeUInt16LE(0, 36);            // internal attributes
      head.writeUInt32LE(0, 38);            // external attributes
      head.writeUInt32LE(e.localHeaderOffset, 42);
      await writeBuf(head);
      await writeBuf(e.nameBuf);
      offset += head.length + e.nameBuf.length;
    }

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);      // end of central directory signature
    eocd.writeUInt16LE(0, 4);               // number of this disk
    eocd.writeUInt16LE(0, 6);               // disk with the central directory
    eocd.writeUInt16LE(central.length, 8);  // entries on this disk
    eocd.writeUInt16LE(central.length, 10); // total entries
    eocd.writeUInt32LE(offset - centralStart, 12);
    eocd.writeUInt32LE(centralStart, 16);
    eocd.writeUInt16LE(0, 20);              // archive comment length
    await writeBuf(eocd);

    await new Promise((resolve, reject) => {
      out.end(err => (err ? reject(err) : resolve()));
    });
  } catch (err) {
    try { out.destroy(); } catch (e) {}
    throw err;
  }

  return fs.statSync(outPath).size;
}

module.exports = { writeStoredZip, crc32, crc32File, dosDateTime, uniqueName };
