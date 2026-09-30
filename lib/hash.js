// Хеш файла в формате OpenSubtitles: размер файла + сумма 64-битных слов
// первых и последних 64 КБ (little-endian), 16 hex-символов.
"use strict";
const fs = require("fs");

const CHUNK = 65536;
const MASK = (1n << 64n) - 1n;

function sumWords(buf) {
  let s = 0n;
  for (let i = 0; i + 8 <= buf.length; i += 8) s = (s + buf.readBigUInt64LE(i)) & MASK;
  return s;
}

async function movieHash(file) {
  const fh = await fs.promises.open(file, "r");
  try {
    const { size } = await fh.stat();
    if (size < CHUNK * 2) return null;
    const head = Buffer.alloc(CHUNK), tail = Buffer.alloc(CHUNK);
    await fh.read(head, 0, CHUNK, 0);
    await fh.read(tail, 0, CHUNK, size - CHUNK);
    const h = (BigInt(size) + sumWords(head) + sumWords(tail)) & MASK;
    return h.toString(16).padStart(16, "0");
  } finally { await fh.close(); }
}

module.exports = { movieHash };
