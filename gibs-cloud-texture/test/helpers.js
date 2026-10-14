// Test helpers: build PNGs by hand (independently of src/png.js) and fake GIBS / the Cache API.
import { deflateSync } from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});

function crc(buf) {
    let c = 0xffffffff;
    for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    Buffer.from(data).copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
}

function applyFilter(type, row, prev, bpp) {
    const out = Buffer.alloc(row.length);
    for (let i = 0; i < row.length; i++) {
        const a = i >= bpp ? row[i - bpp] : 0;
        const b = prev ? prev[i] : 0;
        const c = prev && i >= bpp ? prev[i - bpp] : 0;
        let pred = 0;
        if (type === 1) pred = a;
        else if (type === 2) pred = b;
        else if (type === 3) pred = (a + b) >> 1;
        else if (type === 4) {
            const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
            pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        out[i] = (row[i] - pred) & 255;
    }
    return out;
}

/**
 * Make a PNG from raw (unfiltered) scanline bytes. `filters` picks the filter per row
 * (cycled), so decoders get exercised with every filter type.
 */
export function makePng({ width, height, colorType, bitDepth = 8, rows, palette, trns, filters = [0] }) {
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
    const bpp = Math.max(1, (channels * bitDepth) >> 3);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = bitDepth;
    ihdr[9] = colorType;
    const raw = [];
    let prev = null;
    rows.forEach((row, y) => {
        const type = filters[y % filters.length];
        raw.push(Buffer.from([type]), applyFilter(type, Buffer.from(row), prev, bpp));
        prev = Buffer.from(row);
    });
    const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr)];
    if (palette) parts.push(chunk('PLTE', Buffer.from(palette.flat())));
    if (trns) parts.push(chunk('tRNS', Buffer.from(trns)));
    // split the image data over two IDAT chunks, as encoders may do
    const z = deflateSync(Buffer.concat(raw));
    const half = Math.floor(z.length / 2);
    parts.push(chunk('IDAT', z.subarray(0, half)), chunk('IDAT', z.subarray(half)), chunk('IEND', Buffer.alloc(0)));
    return new Uint8Array(Buffer.concat(parts));
}

// GIBS no-data colour plus a few colormap entries (ice and water phases)
export const PALETTE = [[220, 220, 255], [184, 0, 185], [0, 122, 254], [255, 255, 0], [255, 0, 0]];

/** A 512x512 palette tile where every pixel is palette[index]; index 0 is transparent. */
export function solidTile(index) {
    const row = new Uint8Array(512).fill(index);
    return makePng({
        width: 512, height: 512, colorType: 3, palette: PALETTE, trns: [0],
        rows: Array.from({ length: 512 }, () => row), filters: [0, 1, 2, 3, 4]
    });
}

/**
 * Fake fetch for GIBS GetTile requests. `tileFor(level, row, col, time)` returns PNG bytes
 * or a Response; every request URL is recorded in `fake.requests`.
 */
export function fakeGibs(tileFor) {
    const fake = async (url) => {
        fake.requests.push(url);
        const q = new URL(url).searchParams;
        const result = await tileFor(+q.get('TileMatrix'), +q.get('TileRow'), +q.get('TileCol'), q.get('TIME'));
        return result instanceof Response ? result : new Response(result, { headers: { 'content-type': 'image/png' } });
    };
    fake.requests = [];
    return fake;
}

/** Minimal stand-in for the Workers Cache API (caches.default). */
export function fakeCache() {
    const store = new Map();
    return {
        store,
        async match(request) {
            const hit = store.get(request.url);
            return hit ? new Response(hit.body, { headers: hit.headers }) : undefined;
        },
        async put(request, response) {
            const body = new Uint8Array(await response.arrayBuffer());
            store.set(request.url, { body, headers: [...response.headers] });
        }
    };
}

/** Decode a PNG made by the Worker into straight RGBA bytes (via our own decoder). */
export async function readRgba(bytes, decodePng) {
    const reader = await decodePng(bytes);
    const out = new Uint8ClampedArray(reader.width * reader.height * 4);
    const row = new Float32Array(reader.width * 4);
    for (let y = 0; y < reader.height; y++) {
        reader.readRow(row, 0);
        for (let i = 0; i < row.length; i += 4) {
            const a = row[i + 3];
            const o = y * reader.width * 4 + i;
            if (a > 0) for (let c = 0; c < 3; c++) out[o + c] = (row[i + c] * 255) / a;
            out[o + 3] = a;
        }
    }
    return { width: reader.width, height: reader.height, pixel: (x, y) => [...out.subarray((y * reader.width + x) * 4, (y * reader.width + x) * 4 + 4)] };
}
