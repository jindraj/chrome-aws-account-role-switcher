#!/usr/bin/env node
// create-icons.js - Generates extension icons
// Run with: node create-icons.js
// Requires: npm install canvas  (or uses built-in if available)

const fs = require('fs');
const path = require('path');

// We'll use a pure Node.js approach to generate minimal valid PNGs
// without any dependencies. We create simple colored square PNGs.

// AWS orange color: #FF9900
const ICON_COLOR = { r: 255, g: 153, b: 0 };
const BG_COLOR = { r: 22, g: 33, b: 62 }; // Dark blue #16213e

function createPNG(size) {
  // Build a simple PNG with a hexagon-like design
  // Using raw PNG generation (no deps needed)

  const width = size;
  const height = size;
  const pixels = new Uint8Array(width * height * 4); // RGBA

  const cx = width / 2;
  const cy = height / 2;
  const outerR = width * 0.42;
  const innerR = width * 0.18;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const idx = (y * width + x) * 4;

      // Hexagon shape
      const angle = Math.atan2(dy, dx);
      const hexDist = outerR * Math.cos(Math.PI / 6) /
        Math.cos(((angle % (Math.PI / 3)) + Math.PI / 6) % (Math.PI / 3) - Math.PI / 6);

      if (dist <= hexDist - 1) {
        // Inside hexagon
        if (dist >= innerR) {
          // Ring area - orange
          pixels[idx] = ICON_COLOR.r;
          pixels[idx + 1] = ICON_COLOR.g;
          pixels[idx + 2] = ICON_COLOR.b;
          pixels[idx + 3] = 255;
        } else {
          // Center - dark
          pixels[idx] = BG_COLOR.r;
          pixels[idx + 1] = BG_COLOR.g;
          pixels[idx + 2] = BG_COLOR.b;
          pixels[idx + 3] = 255;
        }
      } else {
        // Outside hexagon - transparent
        pixels[idx] = 0;
        pixels[idx + 1] = 0;
        pixels[idx + 2] = 0;
        pixels[idx + 3] = 0;
      }
    }
  }

  return encodePNG(width, height, pixels);
}

// Minimal PNG encoder (no dependencies)
function encodePNG(width, height, pixels) {
  const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  function crc32(buf) {
    let crc = 0xFFFFFFFF;
    const table = makeCRCTable();
    for (let i = 0; i < buf.length; i++) {
      crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  let crcTable;
  function makeCRCTable() {
    if (crcTable) return crcTable;
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      crcTable[n] = c;
    }
    return crcTable;
  }

  function chunk(type, data) {
    const typeBytes = Buffer.from(type, 'ascii');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length);
    const content = Buffer.concat([typeBytes, data]);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(content));
    return Buffer.concat([lenBuf, content, crcBuf]);
  }

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // IDAT - raw image data with filter bytes
  const zlib = require('zlib');
  const scanlines = [];
  for (let y = 0; y < height; y++) {
    scanlines.push(0); // filter type None
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      scanlines.push(pixels[i], pixels[i+1], pixels[i+2], pixels[i+3]);
    }
  }
  const rawData = Buffer.from(scanlines);
  const compressed = zlib.deflateSync(rawData);

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const iconsDir = path.join(__dirname, 'icons');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir);

for (const size of [16, 32, 48, 128]) {
  const png = createPNG(size);
  const outPath = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(outPath, png);
  console.log(`Created ${outPath} (${png.length} bytes)`);
}

console.log('Icons generated successfully!');
