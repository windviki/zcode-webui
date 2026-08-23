#!/usr/bin/env node
// Minimal asar extractor (header layout: [u32 size=4][u32 headerSize][u32 headerObjectSize][u32 headerStringSize][json...]; base = 8 + headerSize)
'use strict';
const fs = require('fs');
const path = require('path');

const src = process.argv[2];
const dest = process.argv[3];
if (!src || !dest) {
  console.error('usage: node extract-asar.cjs <app.asar> <dest-dir>');
  process.exit(2);
}

const buf = fs.readFileSync(src);
const headerSize = buf.readUInt32LE(4);
const headerStringSize = buf.readUInt32LE(12);
const jsonStr = buf.toString('utf8', 16, 16 + headerStringSize);
const header = JSON.parse(jsonStr);
const base = 8 + headerSize;
let count = 0;

function walk(node, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const files = node.files || {};
  for (const [name, f] of Object.entries(files)) {
    const full = path.join(dir, name);
    if (f.files) {
      walk(f, full);
    } else if (f.link) {
      try { fs.symlinkSync(f.link, full); } catch (_e) { /* ignore */ }
    } else {
      const off = base + Number(f.offset);
      fs.writeFileSync(full, buf.subarray(off, off + f.size));
      count++;
      if (count % 5000 === 0) console.error('extracted files:', count);
    }
  }
}
walk(header, dest);
console.error('done, total files', count);
