// Test helpers: write GeoTIFFs by hand (independently of src/geotiff.js), including an LZW
// encoder that follows libtiff, and fake the NSIDC file server.
import { deflateSync } from 'node:zlib';

/* -------------------------------------------------------------------------- encoders */

/** TIFF LZW, as libtiff writes it: MSB-first codes, width grows early, clear when full. */
export function lzwEncode(bytes) {
    const out = [];
    let buffer = 0, count = 0, width = 9;
    const put = (code) => {
        buffer = ((buffer << width) | code) >>> 0;
        count += width;
        while (count >= 8) {
            out.push((buffer >>> (count - 8)) & 255);
            count -= 8;
        }
        buffer &= (1 << count) - 1;
    };
    let table = new Map();
    let next = 258;
    const added = () => {
        next++;
        if (next === 4094) {
            put(256);
            table = new Map();
            next = 258;
            width = 9;
        } else if (next > (1 << width) - 1) {
            width++;
        }
    };
    put(256);
    let w = -1;
    for (const b of bytes) {
        if (w === -1) { w = b; continue; }
        const key = w * 256 + b;
        const hit = table.get(key);
        if (hit !== undefined) { w = hit; continue; }
        put(w);
        table.set(key, next);
        added();
        w = b;
    }
    if (w !== -1) {
        put(w);
        added();
    }
    put(257);
    if (count > 0) out.push((buffer << (8 - count)) & 255);
    return new Uint8Array(out);
}

export function packBitsEncode(bytes) {
    const out = [];
    let i = 0;
    while (i < bytes.length) {
        let run = 1;
        while (i + run < bytes.length && run < 128 && bytes[i + run] === bytes[i]) run++;
        if (run >= 2) {
            out.push((1 - run) & 255, bytes[i]);
            i += run;
            continue;
        }
        let lit = 1;
        while (i + lit < bytes.length && lit < 128 && !(i + lit + 1 < bytes.length && bytes[i + lit] === bytes[i + lit + 1])) lit++;
        out.push(lit - 1, ...bytes.subarray(i, i + lit));
        i += lit;
    }
    return new Uint8Array(out);
}

/* ---------------------------------------------------------------------------- writer */

const NSIDC_GRIDS = {
    north: { width: 304, height: 448, x0: -3850000, y0: 5850000, epsg: 3411 },
    south: { width: 316, height: 332, x0: -3950000, y0: 4350000, epsg: 3412 }
};
export { NSIDC_GRIDS };

/**
 * Write a single-band GeoTIFF.
 * @param {object} o
 * @param {number} o.width
 * @param {number} o.height
 * @param {ArrayLike<number>} o.values           width * height samples, row by row
 * @param {number} [o.bits=16]
 * @param {number} [o.sampleFormat=1]            1 unsigned, 2 signed
 * @param {'none'|'deflate'|'lzw'|'packbits'} [o.compression='none']
 * @param {number} [o.predictor=1]
 * @param {number} [o.rowsPerStrip]              strips (default: 16 rows)
 * @param {number[]} [o.tile]                    [tileWidth, tileHeight] instead of strips
 * @param {boolean} [o.littleEndian=true]
 * @param {number[]} [o.tiepoint]                ModelTiepoint (6 doubles)
 * @param {number[]} [o.scale]                   ModelPixelScale (3 doubles)
 * @param {number[]} [o.transformation]          ModelTransformation (16 doubles) instead
 * @param {number[][]} [o.geoKeys]               [id, value] pairs; a number goes in the
 *   directory, a non-integer or {double} goes to GeoDoubleParams, a string to GeoAsciiParams
 * @param {number} [o.samplesPerPixel=1]
 * @param {boolean} [o.colorMap]                 add a 2^bits-entry palette, as NSIDC does
 * @param {boolean} [o.bigTiff]                  write a BigTIFF header only (to test rejection)
 */
export function makeTiff(o) {
    const {
        width, height, values, bits = 16, sampleFormat = 1, compression = 'none', predictor = 1,
        tile, littleEndian = true, samplesPerPixel = 1
    } = o;
    const le = littleEndian;
    const bytesPerSample = bits / 8;
    const blockWidth = tile ? tile[0] : width;
    const blockHeight = tile ? tile[1] : (o.rowsPerStrip ?? 16);
    const across = Math.ceil(width / blockWidth);
    const down = Math.ceil(height / blockHeight);

    // raw sample bytes of each strip or tile
    const blocks = [];
    for (let by = 0; by < down; by++) {
        for (let bx = 0; bx < across; bx++) {
            const rows = tile ? blockHeight : Math.min(blockHeight, height - by * blockHeight);
            const samples = new Array(blockWidth * rows).fill(0);
            for (let y = 0; y < rows; y++) {
                for (let x = 0; x < blockWidth; x++) {
                    const sx = bx * blockWidth + x, sy = by * blockHeight + y;
                    if (sx < width && sy < height) samples[y * blockWidth + x] = values[sy * width + sx];
                }
            }
            if (predictor === 2) {
                const mod = 2 ** bits;
                for (let y = 0; y < rows; y++) {
                    for (let x = blockWidth - 1; x > 0; x--) {
                        const i = y * blockWidth + x;
                        samples[i] = (((samples[i] - samples[i - 1]) % mod) + mod) % mod;
                    }
                }
            }
            const raw = new Uint8Array(samples.length * bytesPerSample * samplesPerPixel);
            const view = new DataView(raw.buffer);
            samples.forEach((v, i) => {
                for (let s = 0; s < samplesPerPixel; s++) {
                    const at = (i * samplesPerPixel + s) * bytesPerSample;
                    if (bits === 8) view.setUint8(at, v & 255);
                    else if (bits === 16) (sampleFormat === 2 && predictor === 1 ? view.setInt16(at, v, le) : view.setUint16(at, v & 0xffff, le));
                    else view.setUint32(at, v >>> 0, le);
                }
            });
            const packed = compression === 'deflate' ? new Uint8Array(deflateSync(raw))
                : compression === 'lzw' ? lzwEncode(raw)
                    : compression === 'packbits' ? packBitsEncode(raw) : raw;
            blocks.push(packed);
        }
    }

    // GeoKeys: directory shorts, plus double and ASCII params
    const directory = [1, 1, 0, 0];
    const doubles = [];
    let ascii = '';
    for (const [id, value] of o.geoKeys ?? []) {
        if (typeof value === 'string') {
            directory.push(id, 34737, value.length + 1, ascii.length);
            ascii += `${value}|`;
        } else if (typeof value === 'object' || !Number.isInteger(value) || value > 65535 || value < 0) {
            const v = typeof value === 'object' ? value.double : value;
            directory.push(id, 34736, 1, doubles.length);
            doubles.push(v);
        } else {
            directory.push(id, 0, 1, value);
        }
    }
    directory[3] = (directory.length - 4) / 4;

    const SHORT = 3, LONG = 4, DOUBLE = 12, ASCII = 2;
    const entries = [
        [256, LONG, [width]],
        [257, LONG, [height]],
        [258, SHORT, new Array(samplesPerPixel).fill(bits)],
        [259, SHORT, [{ none: 1, lzw: 5, deflate: 8, packbits: 32773 }[compression]]],
        [262, SHORT, [o.colorMap ? 3 : 1]],
        [277, SHORT, [samplesPerPixel]],
        [284, SHORT, [1]],
        [339, SHORT, new Array(samplesPerPixel).fill(sampleFormat)]
    ];
    if (predictor !== 1) entries.push([317, SHORT, [predictor]]);
    if (o.colorMap) entries.push([320, SHORT, new Array(3 * 2 ** bits).fill(0).map((_, i) => (i * 7919) & 0xffff)]);
    if (tile) {
        entries.push([322, SHORT, [blockWidth]], [323, SHORT, [blockHeight]], [324, LONG, null], [325, LONG, blocks.map((b) => b.length)]);
    } else {
        entries.push([273, LONG, null], [278, LONG, [blockHeight]], [279, LONG, blocks.map((b) => b.length)]);
    }
    if (o.transformation) entries.push([34264, DOUBLE, o.transformation]);
    if (o.scale) entries.push([33550, DOUBLE, o.scale]);
    if (o.tiepoint) entries.push([33922, DOUBLE, o.tiepoint]);
    if (o.geoKeys) {
        entries.push([34735, SHORT, directory]);
        if (doubles.length) entries.push([34736, DOUBLE, doubles]);
        if (ascii) entries.push([34737, ASCII, ascii]);
    }
    entries.sort((a, b) => a[0] - b[0]);

    // layout: header, pixel data, tag values that don't fit inline, IFD
    const size = { [SHORT]: 2, [LONG]: 4, [DOUBLE]: 8, [ASCII]: 1 };
    const dataStart = 8;
    const offsets = [];
    let pos = dataStart;
    for (const b of blocks) {
        offsets.push(pos);
        pos += b.length + (b.length & 1);
    }
    for (const e of entries) if (e[2] === null) e[2] = offsets;
    const placed = entries.map((e) => {
        const length = e[1] === ASCII ? e[2].length + 1 : e[2].length;
        const bytes = length * size[e[1]];
        if (bytes <= 4) return null;
        const at = pos;
        pos += bytes + (bytes & 1);
        return at;
    });
    const ifdStart = pos;
    const total = ifdStart + 2 + entries.length * 12 + 4;
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    out[0] = out[1] = le ? 0x49 : 0x4d;
    view.setUint16(2, o.bigTiff ? 43 : 42, le);
    view.setUint32(4, ifdStart, le);
    blocks.forEach((b, i) => out.set(b, offsets[i]));
    const writeValues = (at, type, vals) => {
        if (type === ASCII) {
            for (let i = 0; i < vals.length; i++) out[at + i] = vals.charCodeAt(i);
            return;
        }
        vals.forEach((v, i) => {
            if (type === SHORT) view.setUint16(at + i * 2, v, le);
            else if (type === LONG) view.setUint32(at + i * 4, v, le);
            else view.setFloat64(at + i * 8, v, le);
        });
    };
    view.setUint16(ifdStart, entries.length, le);
    entries.forEach(([tag, type, vals], i) => {
        const at = ifdStart + 2 + i * 12;
        view.setUint16(at, tag, le);
        view.setUint16(at + 2, type, le);
        view.setUint32(at + 4, type === ASCII ? vals.length + 1 : vals.length, le);
        if (placed[i] === null) writeValues(at + 8, type, vals);
        else {
            view.setUint32(at + 8, placed[i], le);
            writeValues(placed[i], type, vals);
        }
    });
    view.setUint32(ifdStart + 2 + entries.length * 12, 0, le);
    return out;
}

/**
 * A GeoTIFF laid out like an NSIDC Sea Ice Index daily concentration file for `hemisphere`
 * (grid size, georeferencing, EPSG code, palette), with each cell's value from
 * `valueAt(col, row, x, y)` where x, y are the cell centre's map coordinates in metres.
 */
export function nsidcTiff(hemisphere, valueAt, { compression = 'lzw', ...rest } = {}) {
    const g = NSIDC_GRIDS[hemisphere];
    const values = new Uint16Array(g.width * g.height);
    for (let row = 0; row < g.height; row++) {
        for (let col = 0; col < g.width; col++) {
            values[row * g.width + col] = valueAt(col, row, g.x0 + (col + 0.5) * 25000, g.y0 - (row + 0.5) * 25000);
        }
    }
    return makeTiff({
        width: g.width,
        height: g.height,
        values,
        compression,
        colorMap: true,
        tiepoint: [0, 0, 0, g.x0, g.y0, 0],
        scale: [25000, 25000, 0],
        geoKeys: [[1024, 1], [1025, 1], [3072, g.epsg], [3076, 9001]],
        ...rest
    });
}

/* ------------------------------------------------------------------------ fake NSIDC */

/**
 * Fake fetch for the NSIDC server. `fileFor(hemisphere, date)` returns GeoTIFF bytes, a
 * Response, or null for "not published" (404). HEAD and GET are both answered; every request
 * is recorded in `fake.requests` as [method, url].
 */
export function fakeNsidc(fileFor) {
    const fake = async (url, init = {}) => {
        const method = init.method ?? 'GET';
        fake.requests.push([method, url]);
        const m = url.match(/\/(north|south)\/daily\/geotiff\/(\d{4})\/(\d{2})_[A-Z][a-z]{2}\/([NS])_(\d{4})(\d{2})(\d{2})_concentration_v4\.0\.tif$/);
        if (!m) return new Response('<html><body><h1>Not Found</h1></body></html>', { status: 404 });
        const [, hemisphere, , , , y, mo, d] = m;
        const result = await fileFor(hemisphere, `${y}-${mo}-${d}`, method);
        if (result instanceof Response) return result;
        if (!result) return new Response(method === 'HEAD' ? null : '<html><body><h1>Not Found</h1></body></html>', { status: 404 });
        return new Response(method === 'HEAD' ? null : result, {
            headers: { 'content-type': 'image/tiff', 'content-length': String(result.length) }
        });
    };
    fake.requests = [];
    fake.gets = () => fake.requests.filter(([method]) => method === 'GET').map(([, url]) => url);
    return fake;
}
