// Pure Client-Side ISO/IEC 18004 QR Code SVG Generator (Versions 1–10, ECC Level L)
// Zero external APIs — 100% offline & Tor (.onion) safe!

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) {
  return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];
}

function rsPoly(deg) {
  let p = [1];
  for (let i = 0; i < deg; i++) {
    const next = new Array(p.length + 1).fill(0);
    for (let j = 0; j < p.length; j++) {
      next[j] ^= p[j];
      next[j + 1] ^= gfMul(p[j], EXP[i]);
    }
    p = next;
  }
  return p;
}

function rsEncode(data, ecLen) {
  const gen = rsPoly(ecLen);
  const msg = [...data, ...new Array(ecLen).fill(0)];
  for (let i = 0; i < data.length; i++) {
    const coef = msg[i];
    if (coef !== 0) {
      for (let j = 0; j < gen.length; j++) {
        msg[i + j] ^= gfMul(gen[j], coef);
      }
    }
  }
  return msg.slice(data.length);
}

// Version specs for ECC Level L: [totalDataCodewords, ecCodewordsPerBlock, numBlocks, alignPositions]
const V_SPECS = [
  null,
  [19, 7, 1, []],
  [34, 10, 1, [6, 18]],
  [55, 15, 1, [6, 22]],
  [80, 20, 1, [6, 26]],
  [108, 26, 1, [6, 30]],
  [136, 18, 2, [6, 34]],
  [156, 20, 2, [6, 22, 38]],
  [194, 24, 2, [6, 24, 42]],
  [232, 30, 2, [6, 26, 46]],
  [274, 18, 4, [6, 28, 50]]
];

export function renderQrSvg(text, pixelSize = 196) {
  const bytes = Array.from(new TextEncoder().encode(text));
  let ver = 1;
  while (ver <= 10) {
    const cap = V_SPECS[ver][0] - (ver <= 9 ? 2 : 3);
    if (bytes.length <= cap) break;
    ver++;
  }
  if (ver > 10) return `<div class="mono" style="font-size:11px;padding:12px;">URL too long for compact QR</div>`;

  const [totalData, ecPerBlock, blocks, align] = V_SPECS[ver];
  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };

  pushBits(0b0100, 4); // Byte mode
  pushBits(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) pushBits(b, 8);
  pushBits(0, Math.min(4, totalData * 8 - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);

  const dataWords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let w = 0;
    for (let b = 0; b < 8; b++) w = (w << 1) | bits[i + b];
    dataWords.push(w);
  }
  let padToggle = true;
  while (dataWords.length < totalData) {
    dataWords.push(padToggle ? 0xec : 0x11);
    padToggle = !padToggle;
  }

  // Interleave blocks (for versions 1-10 L, blocks are equal size except v10 which has 2x68 + 2x69)
  const baseLen = Math.floor(totalData / blocks);
  const extra = totalData % blocks;
  const dBlocks = [];
  const eBlocks = [];
  let offset = 0;
  for (let b = 0; b < blocks; b++) {
    const len = baseLen + (b >= blocks - extra ? 1 : 0);
    const slice = dataWords.slice(offset, offset + len);
    offset += len;
    dBlocks.push(slice);
    eBlocks.push(rsEncode(slice, ecPerBlock));
  }

  const finalBytes = [];
  const maxDLen = baseLen + (extra > 0 ? 1 : 0);
  for (let i = 0; i < maxDLen; i++) {
    for (let b = 0; b < blocks; b++) {
      if (i < dBlocks[b].length) finalBytes.push(dBlocks[b][i]);
    }
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (let b = 0; b < blocks; b++) finalBytes.push(eBlocks[b][i]);
  }

  const size = ver * 4 + 17;
  const mat = Array.from({ length: size }, () => new Int8Array(size).fill(-1));
  const isFunc = Array.from({ length: size }, () => new Uint8Array(size));

  const setMod = (r, c, val, fn = true) => {
    if (r >= 0 && r < size && c >= 0 && c < size) {
      mat[r][c] = val ? 1 : 0;
      if (fn) isFunc[r][c] = 1;
    }
  };

  const drawFinder = (r0, c0) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const onRing = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const inCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        setMod(r0 + dr, c0 + dc, inOuter && (onRing || inCore), true);
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  for (let i = 8; i < size - 8; i++) {
    setMod(6, i, i % 2 === 0, true);
    setMod(i, 6, i % 2 === 0, true);
  }

  for (const ar of align) {
    for (const ac of align) {
      if ((ar < 9 && ac < 9) || (ar < 9 && ac > size - 10) || (ar > size - 10 && ac < 9)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          setMod(ar + dr, ac + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1, true);
        }
      }
    }
  }

  // Reserve format info modules
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) { isFunc[8][i] = 1; isFunc[i][8] = 1; }
  }
  for (let i = 0; i < 8; i++) {
    isFunc[8][size - 1 - i] = 1;
    isFunc[size - 1 - i][8] = 1;
  }
  setMod(size - 8, 8, 1, true);

  // Place data bits
  const allBits = [];
  for (const b of finalBytes) {
    for (let i = 7; i >= 0; i--) allBits.push((b >> i) & 1);
  }

  let bitIdx = 0;
  let up = true;
  for (let col = size - 1; col >= 1; col -= 2) {
    if (col === 6) col--;
    for (let step = 0; step < size; step++) {
      const r = up ? size - 1 - step : step;
      for (let dc = 0; dc < 2; dc++) {
        const c = col - dc;
        if (!isFunc[r][c]) {
          const bit = bitIdx < allBits.length ? allBits[bitIdx++] : 0;
          // Mask 0: (r + c) % 2 === 0
          mat[r][c] = ((r + c) % 2 === 0) ? (bit ^ 1) : bit;
        }
      }
    }
    up = !up;
  }

  // Format bits for ECC Level L (01) + Mask 0 (000) => precomputed BCH masked = 0x77c4
  const fmt = 0x77c4;
  const fCoords1 = [[8,0],[8,1],[8,2],[8,3],[8,4],[8,5],[8,7],[8,8],[7,8],[5,8],[4,8],[3,8],[2,8],[1,8],[0,8]];
  for (let i = 0; i < 15; i++) {
    const bit = (fmt >> i) & 1;
    mat[fCoords1[i][0]][fCoords1[i][1]] = bit;
    if (i < 8) mat[8][size - 1 - i] = bit;
    else mat[size - 15 + i][8] = bit;
  }

  const quiet = 3;
  const total = size + quiet * 2;
  let paths = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (mat[r][c] === 1) paths += `M${c + quiet},${r + quiet}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${pixelSize}" height="${pixelSize}" shape-rendering="crispEdges">
    <rect width="${total}" height="${total}" fill="#FFFFFF"/>
    <path d="${paths}" fill="#08080A"/>
  </svg>`;
}
