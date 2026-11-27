// PNG Squeeze — lossless PNG recompressor (png-squeeze-01-run-20261127).
// Reads 8 screenshots (1280x720 RGBA stored PNGs) from /input/<id>/image.png and
// writes the smallest lossless PNG it can for each to /output/<id>/image.png.
// Node 22 stdlib only. Deterministic: no clock, no randomness, no environment
// value affects the output (only the input/output directory paths).
//
// Strategy, per image:
//  - analyse: opaque? grey? at most 256 distinct RGBA colours?
//  - forms: palette (colour type 3, transparent entries first, tRNS short;
//    orders by count and by luminance) when <= 256 colours; grey (type 0)
//    or grey+alpha (type 4) when every pixel is grey; RGB (type 2) or RGBA
//    (type 6) otherwise; with a single fully-transparent value and no opaque
//    pixel of that value, type 0/2 plus a tRNS key instead of an alpha channel.
//  - filters: each row its own filter, chosen by minimum signed-byte sum,
//    by fewest distinct adjacent byte pairs, or by brute force (each filter
//    trial deflated at level 4 after the previous 32 KiB, smallest kept).
//  - every (form, filter choice) is weighed by one zlib deflate at level 6;
//    the winner is re-deflated at level 9 under a few strategies and the
//    smallest stream is kept.
import { inflateSync, deflateSync, constants } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const W = 1280;
const H = 720;

/* ------------------------------------------------------------------ */
/* CRC-32 (PNG)                                                        */
/* ------------------------------------------------------------------ */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* ------------------------------------------------------------------ */
/* PNG writing                                                         */
/* ------------------------------------------------------------------ */
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 4, 'ascii');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out, 4, 8 + data.length), 8 + data.length);
  return out;
}

function ihdr(width, height, colourType) {
  const d = Buffer.alloc(13);
  d.writeUInt32BE(width, 0);
  d.writeUInt32BE(height, 4);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

function pngOf(width, height, colourType, plte, trns, idat) {
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr(width, height, colourType))];
  if (plte !== null) parts.push(chunk('PLTE', plte));
  if (trns !== null) parts.push(chunk('tRNS', trns));
  parts.push(chunk('IDAT', idat));
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

/* ------------------------------------------------------------------ */
/* PNG reading (input screenshots: stored RGBA, but decode generally)  */
/* ------------------------------------------------------------------ */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function decodePng(bytes) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) throw new Error('not a PNG');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let header = null;
  let palette = null;
  let trns = null;
  const idat = [];
  let ended = false;
  while (at < bytes.length) {
    if (ended) throw new Error('bytes after IEND');
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) throw new Error(type + ' CRC');
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header = { width: dv.getUint32(0), height: dv.getUint32(4), colourType: data[9] };
      if (data[8] !== 8) throw new Error('bit depth not 8');
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') ended = true;
  }
  if (!header || !ended || idat.length === 0) throw new Error('incomplete PNG');
  const { width, height, colourType } = header;
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat));
  if (raw.length !== height * (stride + 1)) throw new Error('IDAT length mismatch');
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) samples.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) {
        samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
      }
    } else if (ft === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paeth(a, b, c);
      }
    } else throw new Error('bad filter ' + ft);
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) rgba.set(samples);
  else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette.length / 3;
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      if (e >= entries) throw new Error('palette index out of range');
      rgba[d] = palette[e * 3];
      rgba[d + 1] = palette[e * 3 + 1];
      rgba[d + 2] = palette[e * 3 + 2];
      rgba[d + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
  }
  return { width, height, rgba };
}

/* ------------------------------------------------------------------ */
/* Filtering                                                           */
/* ------------------------------------------------------------------ */
function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) out.set(cur);
  else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) {
      out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}

/** Sum of a filtered row's bytes read as signed (-128..127), absolute. */
function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

/** Distinct adjacent byte pairs in a row (stamp array avoids clearing). */
function pairsOf(row, seen, stamp) {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

const BRUTE_CONTEXT = 32768;

/**
 * Filter `samples` (height rows of width*bpp) by `choice`: a fixed filter
 * 0..4 for every row, or 'minsum' / 'pairs' / 'brute' per-row choice.
 * Returns the raw filtered data (filter byte + row, per row).
 */
function filtered(samples, width, height, bpp, choice) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial = [];
  for (let t = 0; t < 5; t++) {
    const row = new Uint8Array(stride + 1);
    row[0] = t;
    trial.push(row);
  }
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t].subarray(1));
      let cost;
      if (choice === 'minsum') cost = signedSum(trial[t].subarray(1));
      else if (choice === 'pairs') cost = pairsOf(trial[t].subarray(1), seen, ++stamp);
      else {
        cost = before.length === 0
          ? deflateSync(trial[t], { level: 4, memLevel: 9 }).length
          : deflateSync(trial[t], { level: 4, memLevel: 9, dictionary: before }).length;
      }
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw.set(trial[type], at);
  }
  return raw;
}

/* ------------------------------------------------------------------ */
/* Analysis + forms                                                    */
/* ------------------------------------------------------------------ */
function analyse(rgba) {
  const n = rgba.length >>> 2;
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = (rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  let colours = null;
  if (!many) {
    colours = [...counts.entries()].map(([c, count]) => ({
      r: (c >>> 24) & 0xff, g: (c >>> 16) & 0xff, b: (c >>> 8) & 0xff, a: c & 0xff,
      word: c, count,
    }));
  }
  return { opaque, grey, colours };
}

/**
 * The one fully transparent value the image may key by tRNS instead of an
 * alpha channel: every non-opaque pixel is that exact value at alpha 0, and
 * no opaque pixel has that value. Null when there is none.
 */
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

/** Palette entries: transparent ones first (by alpha), then by `order`. */
function paletteOrder(colours, order) {
  const lum = (c) => 299 * c.r + 587 * c.g + 114 * c.b;
  return [...colours].sort((x, y) => {
    const ta = x.a === 255 ? 1 : 0;
    const tb = y.a === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.a !== y.a) return x.a - y.a;
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
}

function paletteForm(rgba, colours, order) {
  const entries = paletteOrder(colours, order);
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.r;
    plte[i * 3 + 1] = c.g;
    plte[i * 3 + 2] = c.b;
    if (c.a !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.a);
  const n = rgba.length >>> 2;
  const indices = new Uint8Array(n);
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    indices[i] = index.get((rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3]);
  }
  return { colourType: 3, bpp: 1, samples: indices, plte, trns };
}

/** The forms an image can be written in, each with its filter choices. */
function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    const pCount = paletteForm(rgba, colours, 'count');
    forms.push({ ...pCount, filters: [0] });
    const pLum = paletteForm(rgba, colours, 'luminance');
    forms.push({ ...pLum, filters: [0, 'minsum', 'brute'] });
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct;
  let trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns, filters: [0, 1, 2, 4, 'minsum', 'pairs', 'brute'] });
  return forms;
}

const chunkBytes = (form) =>
  (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);

const SCREEN = { level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY };

/** Squeeze one image: the smallest lossless PNG over all forms/filters. */
function squeeze(rgba, width, height) {
  let best = null;
  for (const form of formsOf(rgba)) {
    for (const choice of form.filters) {
      const data = filtered(form.samples, width, height, form.bpp, choice);
      const zlib = deflateSync(data, SCREEN);
      const bytes = zlib.length + chunkBytes(form);
      if (best === null || bytes < best.bytes) {
        best = { form, choice, data, bytes };
      }
    }
  }
  // Best zlib level 9 stream (fallback) and the custom optimal-parse
  // stream; keep whichever is smaller. The custom deflate runs at chain
  // 512: the long chain (1024) bought ~7k more score on the practice set
  // but pushed the total past the 60 s wall (62 s measured), so 512 is
  // the time-safe choice. Nice length is 258 for small streams (their
  // long matches pay) and 128 for large ones (saves time, ~no loss).
  // Deterministic: every choice depends only on stream size, never the clock.
  let idat = deflateSync(best.data, { level: 9, memLevel: 9, strategy: constants.Z_DEFAULT_STRATEGY });
  const nice = best.data.length <= 1048576 ? 258 : 128;
  const custom = customDeflate(best.data, 2, 512, nice);
  if (custom.length < idat.length) idat = custom;
  return pngOf(width, height, best.form.colourType, best.form.plte, best.form.trns, idat);
}

/* ------------------------------------------------------------------ */
/* Custom optimal-parse DEFLATE (zopfli-lite)                            */
/* Hash-chain longest-match finder + shortest-path DP over (literal,    */
/* match) with iterated dynamic Huffman tables, emitted as one dynamic  */
/* DEFLATE block. Used only when it beats Node zlib level 9 on the      */
/* winning filtered stream (per-instance fallback). Deterministic: the  */
/* chain length depends only on the stream size, never on the clock.    */
/* ------------------------------------------------------------------ */

// ---- DEFLATE tables -------------------------------------------------------
const LENGTH_BASE = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
const LENGTH_EXTRA = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
const DIST_BASE = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
const DIST_EXTRA = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];

// len -> [lengthCode (257..285), extraBits]; dist -> [distCode (0..29), extraBits]
const LEN_CODE = new Array(259);
for (let c = 0; c < 29; c++) {
  const base = LENGTH_BASE[c];
  const next = c === 28 ? 259 : LENGTH_BASE[c + 1];
  for (let l = base; l < next; l++) LEN_CODE[l] = [257 + c, LENGTH_EXTRA[c]];
}
const DIST_CODE = new Array(32769);
for (let c = 0; c < 30; c++) {
  const base = DIST_BASE[c];
  const next = c === 29 ? 32769 : DIST_BASE[c + 1];
  for (let d = base; d < next; d++) DIST_CODE[d] = [c, DIST_EXTRA[c]];
}
// fixed Huffman code lengths (pass 1 cost model)
const FIXED_LIT = new Uint8Array(288);
for (let i = 0; i < 144; i++) FIXED_LIT[i] = 8;
for (let i = 144; i < 256; i++) FIXED_LIT[i] = 9;
for (let i = 256; i < 280; i++) FIXED_LIT[i] = 7;
for (let i = 280; i < 288; i++) FIXED_LIT[i] = 8;
const FIXED_DIST_LEN = 5;

// ---- Huffman: heap tree + zlib-style overflow fix + canonical codes -----
function huffmanLengths(freq, maxLen) {
  const n = freq.length;
  const symbols = [];
  for (let i = 0; i < n; i++) if (freq[i] > 0) symbols.push(i);
  const lengths = new Uint8Array(n);
  if (symbols.length === 0) return lengths;
  if (symbols.length === 1) { lengths[symbols[0]] = 1; return lengths; }
  const heapFreq = [];
  const heapNode = [];
  let heapSize = 0;
  const push = (f, node) => {
    let i = heapSize++;
    heapFreq[i] = f; heapNode[i] = node;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapFreq[p] < f || (heapFreq[p] === f && heapNode[p] < node)) break;
      heapFreq[i] = heapFreq[p]; heapNode[i] = heapNode[p];
      i = p;
    }
    heapFreq[i] = f; heapNode[i] = node;
  };
  const pop = () => {
    const f = heapFreq[0], node = heapNode[0];
    const lf = heapFreq[--heapSize], ln = heapNode[heapSize];
    if (heapSize > 0) {
      let i = 0;
      for (;;) {
        let c = i * 2 + 1;
        if (c >= heapSize) break;
        if (c + 1 < heapSize && (heapFreq[c + 1] < heapFreq[c] || (heapFreq[c + 1] === heapFreq[c] && heapNode[c + 1] < heapNode[c]))) c++;
        if (lf < heapFreq[c] || (lf === heapFreq[c] && ln < heapNode[c])) break;
        heapFreq[i] = heapFreq[c]; heapNode[i] = heapNode[c];
        i = c;
      }
      heapFreq[i] = lf; heapNode[i] = ln;
    }
    return [f, node];
  };
  const parent = new Int32Array(2 * n).fill(-1);
  const left = new Int32Array(2 * n).fill(-1);
  const right = new Int32Array(2 * n).fill(-1);
  for (const s of symbols) push(freq[s], s);
  let next = n;
  while (heapSize > 1) {
    const [f1, n1] = pop();
    const [f2, n2] = pop();
    const node = next++;
    left[node] = n1; right[node] = n2;
    parent[n1] = node; parent[n2] = node;
    push(f1 + f2, node);
  }
  const root = heapNode[0];
  const depth = new Int32Array(2 * n);
  const stack = [root];
  depth[root] = 0;
  let maxDepth = 0;
  while (stack.length) {
    const nd = stack.pop();
    const d = depth[nd];
    if (nd < n) {
      lengths[nd] = d;
      if (d > maxDepth) maxDepth = d;
    } else {
      depth[left[nd]] = d + 1; depth[right[nd]] = d + 1;
      stack.push(left[nd], right[nd]);
    }
  }
  if (maxDepth <= maxLen) return lengths;
  // Overflow fix (zlib gen_bitlen style): clamp overlong to maxLen, redistribute.
  const blCount = new Int32Array(maxDepth + 1);
  for (const s of symbols) blCount[lengths[s]]++;
  let overflow = 0;
  for (let b = maxLen + 1; b <= maxDepth; b++) overflow += blCount[b];
  blCount[maxLen] += overflow;
  for (let b = maxLen + 1; b <= maxDepth; b++) blCount[b] = 0;
  // Each shuffle step below removes exactly one unit (2^-maxLen) of Kraft
  // mass while preserving the code count; run until the code is complete
  // (Kraft == 1). The old `overflow -= 2` loop under-corrected when the
  // overlong codes were deeper than maxLen+1.
  let kraftUnits = 0;
  for (let l = 1; l <= maxLen; l++) kraftUnits += blCount[l] * (1 << (maxLen - l));
  const targetUnits = 1 << maxLen;
  while (kraftUnits > targetUnits) {
    let bits = maxLen - 1;
    while (bits > 1 && blCount[bits] === 0) bits--;
    blCount[bits]--;
    blCount[bits + 1] += 2;
    blCount[maxLen]--;
    kraftUnits--;
  }
  const byFreq = [...symbols].sort((a, b) => freq[b] - freq[a] || a - b);
  let idx = 0;
  for (let l = 1; l <= maxLen; l++) {
    for (let k = 0; k < blCount[l]; k++) lengths[byFreq[idx++]] = l;
  }
  return lengths;
}

/** Canonical Huffman codes from lengths: returns {codes, lengths}. */
function canonicalCodes(lengths) {
  const n = lengths.length;
  const maxLen = Math.max(...lengths);
  const blCount = new Int32Array(maxLen + 1);
  for (let i = 0; i < n; i++) if (lengths[i] > 0) blCount[lengths[i]]++;
  const nextCode = new Int32Array(maxLen + 1);
  let code = 0;
  for (let b = 1; b <= maxLen; b++) {
    code = (code + blCount[b - 1]) << 1;
    nextCode[b] = code;
  }
  const codes = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const l = lengths[i];
    if (l > 0) codes[i] = nextCode[l]++;
  }
  return { codes, lengths };
}

/** Reverse `len` bits of code (DEFLATE writes Huffman codes MSB-first into an LSB-first stream). */
function reverseBits(code, len) {
  let r = 0;
  for (let i = 0; i < len; i++) { r = (r << 1) | ((code >>> i) & 1); }
  return r;
}

// ---- Bit writer ------------------------------------------------------------
class BitWriter {
  constructor() { this.bytes = []; this.bitBuf = 0; this.bitCnt = 0; }
  writeBits(value, len) {
    this.bitBuf |= (value & ((1 << len) - 1)) << this.bitCnt;
    this.bitCnt += len;
    while (this.bitCnt >= 8) {
      this.bytes.push(this.bitBuf & 0xff);
      this.bitBuf >>>= 8;
      this.bitCnt -= 8;
    }
  }
  writeCode(code, len) { this.writeBits(reverseBits(code, len), len); }
  align() {
    if (this.bitCnt > 0) { this.bytes.push(this.bitBuf & 0xff); this.bitBuf = 0; this.bitCnt = 0; }
  }
  result() { this.align(); return Buffer.from(this.bytes); }
}

// ---- Match finder ----------------------------------------------------------
// For each position: longest match (len, dist) + closest match (len, dist).
function findMatches(data, maxChain = 128, niceLen = 64) {
  const n = data.length;
  const HASH_BITS = 15;
  const HASH_SIZE = 1 << HASH_BITS;
  const HASH_MASK = HASH_SIZE - 1;
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  const matchLen = new Uint16Array(n);
  const matchDist = new Int32Array(n);
  const closeLen = new Uint16Array(n);
  const closeDist = new Int32Array(n);
  const hashAt = (i) => (((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & HASH_MASK);
  for (let i = 0; i < n; i++) {
    if (i + 2 < n) {
      const h = hashAt(i);
      let cur = head[h];
      let bestLen = 0, bestDist = 0, cLen = 0, cDist = 0;
      let steps = 0;
      const maxLen = Math.min(258, n - i);
      while (cur !== -1 && steps < maxChain && i - cur <= 32768) {
        if (bestLen < maxLen && data[cur + bestLen] === data[i + bestLen]) {
          let l = 0;
          while (l < maxLen && data[cur + l] === data[i + l]) l++;
          if (l > bestLen) { bestLen = l; bestDist = i - cur; if (l >= niceLen) break; }
        }
        if (cLen === 0 && data[cur] === data[i] && data[cur + 1] === data[i + 1] && data[cur + 2] === data[i + 2]) {
          let l = 3;
          while (l < maxLen && data[cur + l] === data[i + l]) l++;
          cLen = l; cDist = i - cur;
        }
        cur = prev[cur];
        steps++;
      }
      matchLen[i] = bestLen; matchDist[i] = bestDist;
      closeLen[i] = cLen; closeDist[i] = cDist;
      prev[i] = head[h];
      head[h] = i;
    }
  }
  return { matchLen, matchDist, closeLen, closeDist };
}

// ---- Optimal parsing (DP) --------------------------------------------------
// Cost model from Huffman lengths: litCost[byte], lenCost[len], distCost[dist].
function buildCosts(litLen, distLen) {
  const litCost = new Float64Array(256);
  for (let i = 0; i < 256; i++) litCost[i] = litLen[i];
  const lenCost = new Float64Array(259);
  for (let l = 3; l <= 258; l++) {
    const [code, extra] = LEN_CODE[l];
    lenCost[l] = litLen[code] + extra;
  }
  const distCost = new Float64Array(32769);
  for (let d = 1; d <= 32768; d++) {
    const [code, extra] = DIST_CODE[d];
    distCost[d] = distLen[code] + extra;
  }
  return { litCost, lenCost, distCost };
}

// DP over one block; returns tokens (literals and {len, dist} matches).
function parseBlock(data, m, litLen, distLen) {
  const n = data.length;
  const { litCost, lenCost, distCost } = buildCosts(litLen, distLen);
  const cost = new Float64Array(n + 1).fill(Infinity);
  const choiceLen = new Int32Array(n + 1);
  const choiceDist = new Int32Array(n + 1);
  cost[0] = 0;
  for (let i = 0; i < n; i++) {
    const c = cost[i];
    if (c === Infinity) continue;
    const nc = c + litCost[data[i]];
    if (nc < cost[i + 1]) { cost[i + 1] = nc; choiceLen[i + 1] = 0; }
    for (let k = 0; k < 2; k++) {
      const ml = k === 0 ? m.matchLen[i] : m.closeLen[i];
      const md = k === 0 ? m.matchDist[i] : m.closeDist[i];
      if (ml < 3 || md === 0) continue;
      for (let L = ml; L >= ml - 1; L--) {
        if (L < 3 || i + L > n) continue;
        const mc = c + lenCost[L] + distCost[md];
        if (mc < cost[i + L]) { cost[i + L] = mc; choiceLen[i + L] = L; choiceDist[i + L] = md; }
      }
    }
  }
  const tokens = [];
  let j = n;
  while (j > 0) {
    const L = choiceLen[j];
    if (L === 0) { tokens.push(data[j - 1]); j--; }
    else { tokens.push({ len: L, dist: choiceDist[j] }); j -= L; }
  }
  tokens.reverse();
  return tokens;
}

function tokenFreqs(tokens) {
  const litFreq = new Float64Array(288);
  const distFreq = new Float64Array(30);
  for (const t of tokens) {
    if (typeof t === 'number') litFreq[t]++;
    else {
      const [lc] = LEN_CODE[t.len];
      const [dc] = DIST_CODE[t.dist];
      litFreq[lc]++;
      distFreq[dc]++;
    }
  }
  litFreq[256]++; // end of block
  return { litFreq, distFreq };
}

// ---- Dynamic block emission -----------------------------------------------
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** RLE-encode code lengths (litLen then distLen) into CL symbols + extra bits. */
function rleLengths(lengths) {
  const out = [];
  let i = 0;
  const n = lengths.length;
  while (i < n) {
    const v = lengths[i];
    if (v === 0) {
      let run = 0;
      while (i + run < n && lengths[i + run] === 0) run++;
      let r = run;
      while (r >= 11) { const take = Math.min(r, 138); out.push([18, 7, take - 11]); r -= take; }
      if (r >= 3) { out.push([17, 3, r - 3]); r = 0; }
      while (r-- > 0) out.push([0, 0, 0]);
      i += run;
    } else {
      out.push([v, 0, 0]);
      let run = 1;
      while (i + run < n && lengths[i + run] === v) run++;
      let r = run - 1;
      while (r >= 3) { const take = Math.min(r, 6); out.push([16, 2, take - 3]); r -= take; }
      // leftover 1-2 copies cannot use symbol 16 (min repeat 3): emit literally
      while (r-- > 0) out.push([v, 0, 0]);
      i += run;
    }
  }
  return out;
}

function emitDynamicBlock(w, tokens, litLen, distLen, isLast) {
  w.writeBits(isLast ? 1 : 0, 1);
  w.writeBits(2, 2); // BTYPE = dynamic
  let hlit = 257;
  for (let i = 287; i >= 257; i--) if (litLen[i] > 0) { hlit = i + 1; break; }
  let hdist = 1;
  for (let i = 29; i >= 0; i--) if (distLen[i] > 0) { hdist = i + 1; break; }
  if (hlit < 257) hlit = 257;
  if (hdist < 1) hdist = 1;
  const lens = [];
  for (let i = 0; i < hlit; i++) lens.push(litLen[i]);
  for (let i = 0; i < hdist; i++) lens.push(distLen[i]);
  const rle = rleLengths(lens);
  const clFreq = new Float64Array(19);
  for (const [s] of rle) clFreq[s]++;
  const clLen = huffmanLengths(clFreq, 7);
  let hclen = 4;
  for (let i = 18; i >= 4; i--) if (clLen[CL_ORDER[i]] > 0) { hclen = i + 1; break; }
  if (hclen < 4) hclen = 4;
  w.writeBits(hlit - 257, 5);
  w.writeBits(hdist - 1, 5);
  w.writeBits(hclen - 4, 4);
  for (let i = 0; i < hclen; i++) w.writeBits(clLen[CL_ORDER[i]], 3);
  const clCodes = canonicalCodes(clLen);
  for (const [s, eb, ev] of rle) {
    w.writeCode(clCodes.codes[s], clLen[s]);
    if (eb > 0) w.writeBits(ev, eb);
  }
  const litCodes = canonicalCodes(litLen);
  const distCodes = canonicalCodes(distLen);
  for (const t of tokens) {
    if (typeof t === 'number') {
      w.writeCode(litCodes.codes[t], litLen[t]);
    } else {
      const [lc, le] = LEN_CODE[t.len];
      const [dc, de] = DIST_CODE[t.dist];
      w.writeCode(litCodes.codes[lc], litLen[lc]);
      if (le > 0) w.writeBits(t.len - LENGTH_BASE[lc - 257], le);
      w.writeCode(distCodes.codes[dc], distLen[dc]);
      if (de > 0) w.writeBits(t.dist - DIST_BASE[dc], de);
    }
  }
  w.writeCode(litCodes.codes[256], litLen[256]);
}

function adler32(bytes) {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length;) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) { a += bytes[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** Custom deflate of a whole Uint8Array (single block, N DP passes). */
function customDeflate(data, iterations = 2, maxChain = 1024, niceLen = 258) {
  const m = findMatches(data, maxChain, niceLen);
  let litLen = FIXED_LIT.slice();
  let distLen = new Uint8Array(30).fill(5);
  let tokens;
  for (let it = 0; it < iterations; it++) {
    tokens = parseBlock(data, m, litLen, distLen);
    const { litFreq, distFreq } = tokenFreqs(tokens);
    litLen = huffmanLengths(litFreq, 15);
    distLen = huffmanLengths(distFreq, 15);
    let anyDist = false;
    for (let i = 0; i < 30; i++) if (distFreq[i] > 0) { anyDist = true; break; }
    if (!anyDist) { distLen = new Uint8Array(30); distLen[0] = 1; }
  }
  const w = new BitWriter();
  emitDynamicBlock(w, tokens, litLen, distLen, true);
  const raw = w.result();
  const out = Buffer.alloc(2 + raw.length + 4);
  out[0] = 0x78; out[1] = 0x9c;
  raw.copy(out, 2);
  out.writeUInt32BE(adler32(data), 2 + raw.length);
  return out;
}


/* ------------------------------------------------------------------ */
/* Main: every instance of the set in one run                          */
/* ------------------------------------------------------------------ */
const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const { width, height, rgba } = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), squeeze(rgba, width, height));
}
