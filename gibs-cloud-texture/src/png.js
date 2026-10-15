/* png.js - the small subset of PNG that this Worker needs, built on the runtime's native
 * zlib streams (DecompressionStream / CompressionStream), so there are no dependencies.
 *
 *   decodePng()        parses a tile and returns a reader that unfilters one row at a time
 *                      and writes it out as premultiplied RGBA floats (see below).
 *   PngStreamEncoder   writes an 8-bit RGBA or greyscale PNG as a stream: rows go in, PNG bytes come out,
 *                      and the full image never has to sit in memory (an 8k RGBA image is
 *                      134 MB raw, more than a Worker's 128 MB limit).
 *
 * Premultiplied alpha: decoded pixels are (r*a/255, g*a/255, b*a/255, a) with every channel
 * on a 0-255 scale. Resampling in this form keeps the colour of fully transparent pixels
 * (GIBS stores no-data as a transparent light lavender) from bleeding into cloud edges.
 */

const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }; // samples per pixel by colour type
const VALID_BIT_DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

export class PngError extends Error {
    constructor(message) {
        super(message);
        this.name = 'PngError';
    }
}

export function isPng(bytes) {
    if (bytes.length < SIGNATURE.length) return false;
    for (let i = 0; i < SIGNATURE.length; i++) {
        if (bytes[i] !== SIGNATURE[i]) return false;
    }
    return true;
}

/* ------------------------------------------------------------------------------ CRC-32 */

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(parts) {
    let crc = 0xffffffff;
    for (const bytes of parts) {
        for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

/* ----------------------------------------------------------------------------- decoder */

/**
 * Parse a PNG and inflate its pixel data.
 * @param {Uint8Array} bytes
 * @returns {Promise<PngRowReader>}
 */
export async function decodePng(bytes) {
    if (!isPng(bytes)) throw new PngError('not a PNG file');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    let header = null;
    let palette = null;
    let transparency = null;
    const idat = [];

    let pos = SIGNATURE.length;
    while (true) {
        if (pos + 8 > bytes.length) throw new PngError('truncated PNG (no IEND chunk)');
        const length = view.getUint32(pos);
        const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
        const end = pos + 8 + length;
        if (end + 4 > bytes.length) throw new PngError(`truncated PNG (in ${type} chunk)`);
        const data = bytes.subarray(pos + 8, end);
        pos = end + 4; // skip the CRC; zlib's own checksum catches corrupt pixel data

        if (type === 'IHDR') {
            const d = new DataView(data.buffer, data.byteOffset, data.byteLength);
            header = {
                width: d.getUint32(0),
                height: d.getUint32(4),
                bitDepth: data[8],
                colorType: data[9],
                interlace: data[12]
            };
        } else if (type === 'PLTE') {
            palette = data;
        } else if (type === 'tRNS') {
            transparency = data;
        } else if (type === 'IDAT') {
            idat.push(data);
        } else if (type === 'IEND') {
            break;
        }
    }

    if (!header) throw new PngError('missing IHDR chunk');
    const { width, height, bitDepth, colorType, interlace } = header;
    if (!(colorType in CHANNELS) || !VALID_BIT_DEPTHS[colorType].includes(bitDepth)) {
        throw new PngError(`unsupported colour type ${colorType} / bit depth ${bitDepth}`);
    }
    if (interlace !== 0) throw new PngError('interlaced PNGs are not supported');
    if (colorType === 3 && !palette) throw new PngError('palette image without a PLTE chunk');
    if (idat.length === 0) throw new PngError('no image data');

    const bitsPerPixel = CHANNELS[colorType] * bitDepth;
    const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
    const data = await inflate(idat);
    if (data.length < height * (rowBytes + 1)) {
        throw new PngError(`image data too short (${data.length} bytes for ${width}x${height})`);
    }
    return new PngRowReader(header, data, rowBytes, Math.max(1, bitsPerPixel >> 3), palette, transparency);
}

async function inflate(parts) {
    const stream = new Blob(parts).stream().pipeThrough(new DecompressionStream('deflate'));
    try {
        return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (error) {
        throw new PngError(`corrupt image data: ${error.message}`);
    }
}

/**
 * Hands out the rows of a decoded PNG in order, top to bottom. Rows are unfiltered in place
 * as they are read, so the inflated data is the only copy of the image held in memory.
 */
export class PngRowReader {
    constructor(header, data, rowBytes, filterBpp, palette, transparency) {
        this.width = header.width;
        this.height = header.height;
        this.bitDepth = header.bitDepth;
        this.colorType = header.colorType;
        this.data = data;
        this.rowBytes = rowBytes;
        this.filterBpp = filterBpp;
        this.y = 0;
        this.previous = null;
        this.palette = palette;
        this.transparency = transparency;

        // Lookup table of premultiplied colours for palette and low-bit-depth grey images
        if (this.colorType === 3) {
            this.lut = paletteLut(palette, transparency);
        } else if (this.colorType === 0 && this.bitDepth <= 8) {
            this.lut = greyLut(this.bitDepth, transparency);
        }
        // tRNS colour key (16-bit sample values) for grey and RGB images
        if (transparency && (this.colorType === 0 || this.colorType === 2)) {
            const d = new DataView(transparency.buffer, transparency.byteOffset, transparency.byteLength);
            this.key = this.colorType === 0
                ? [d.getUint16(0)]
                : [d.getUint16(0), d.getUint16(2), d.getUint16(4)];
        }
    }

    /**
     * Unfilter the next row and write its first `count` pixels to `out` as premultiplied RGBA
     * floats, starting at `offset` (an index into `out`, not a pixel index).
     */
    readRow(out, offset, count = this.width) {
        this.convert(this.nextRow(), out, offset, Math.min(count, this.width));
    }

    /**
     * Like readRow, but writes one float per pixel, mapped from its colour by `mapper`
     * (an AlbedoMapper). Palette images are mapped once per palette entry, so the pixel
     * loop is a table lookup.
     */
    readValues(out, offset, count, mapper) {
        const row = this.nextRow();
        count = Math.min(count, this.width);
        if (this.colorType === 3) {
            if (!this.valueLut || this.valueMapper !== mapper) {
                this.valueLut = mapper.paletteValues(this.palette, this.transparency);
                this.valueMapper = mapper;
            }
            const lut = this.valueLut;
            if (this.bitDepth === 8) {
                for (let x = 0; x < count; x++) out[offset + x] = lut[row[x]];
            } else {
                const depth = this.bitDepth, mask = (1 << depth) - 1;
                for (let x = 0; x < count; x++) {
                    const bit = x * depth;
                    out[offset + x] = lut[(row[bit >> 3] >> (8 - depth - (bit & 7))) & mask];
                }
            }
            return;
        }
        // Other colour types: decode to RGBA, then map each colour (cached per colour)
        const rgba = this.scratch ?? (this.scratch = new Float32Array(this.width * 4));
        this.convert(row, rgba, 0, count);
        for (let x = 0, i = 0; x < count; x++, i += 4) {
            const a = rgba[i + 3];
            out[offset + x] = a < 128 ? 0 : mapper.colorValue(
                Math.round((rgba[i] * 255) / a), Math.round((rgba[i + 1] * 255) / a), Math.round((rgba[i + 2] * 255) / a), a);
        }
    }

    nextRow() {
        if (this.y >= this.height) throw new PngError('read past the last row');
        const start = this.y * (this.rowBytes + 1);
        const filter = this.data[start];
        const row = this.data.subarray(start + 1, start + 1 + this.rowBytes);
        unfilter(filter, row, this.previous, this.filterBpp);
        this.previous = row;
        this.y++;
        return row;
    }

    convert(row, out, offset, count) {
        const { colorType, bitDepth, lut, key } = this;

        if (lut) { // palette or grey with 1-8 bits per sample
            if (bitDepth === 8) {
                for (let x = 0, o = offset; x < count; x++, o += 4) {
                    const l = row[x] * 4;
                    out[o] = lut[l]; out[o + 1] = lut[l + 1]; out[o + 2] = lut[l + 2]; out[o + 3] = lut[l + 3];
                }
            } else {
                const mask = (1 << bitDepth) - 1;
                for (let x = 0, o = offset; x < count; x++, o += 4) {
                    const bit = x * bitDepth;
                    const l = ((row[bit >> 3] >> (8 - bitDepth - (bit & 7))) & mask) * 4;
                    out[o] = lut[l]; out[o + 1] = lut[l + 1]; out[o + 2] = lut[l + 2]; out[o + 3] = lut[l + 3];
                }
            }
            return;
        }

        const wide = bitDepth === 16;
        const channels = CHANNELS[colorType];
        const step = channels * (wide ? 2 : 1);
        // 16-bit samples are scaled to 0-255 with /257, which maps 65535 to exactly 255
        const sample = wide
            ? (i) => ((row[i] << 8) | row[i + 1]) / 257
            : (i) => row[i];
        const raw = wide ? (i) => (row[i] << 8) | row[i + 1] : (i) => row[i];
        const sampleBytes = wide ? 2 : 1;

        for (let x = 0, i = 0, o = offset; x < count; x++, i += step, o += 4) {
            let r, g, b, a;
            if (colorType === 0) {          // grey, 16-bit
                r = g = b = sample(i);
                a = key && raw(i) === key[0] ? 0 : 255;
            } else if (colorType === 2) {   // RGB
                r = sample(i); g = sample(i + sampleBytes); b = sample(i + 2 * sampleBytes);
                a = key && raw(i) === key[0] && raw(i + sampleBytes) === key[1]
                    && raw(i + 2 * sampleBytes) === key[2] ? 0 : 255;
            } else if (colorType === 4) {   // grey + alpha
                r = g = b = sample(i);
                a = sample(i + sampleBytes);
            } else {                        // RGBA
                r = sample(i); g = sample(i + sampleBytes); b = sample(i + 2 * sampleBytes);
                a = sample(i + 3 * sampleBytes);
            }
            const s = a / 255;
            out[o] = r * s; out[o + 1] = g * s; out[o + 2] = b * s; out[o + 3] = a;
        }
    }
}

function paletteLut(palette, transparency) {
    const lut = new Float32Array(256 * 4); // indices past the palette stay transparent black
    const entries = Math.min(256, Math.floor(palette.length / 3));
    for (let i = 0; i < entries; i++) {
        const a = transparency && i < transparency.length ? transparency[i] : 255;
        const s = a / 255;
        lut[i * 4] = palette[i * 3] * s;
        lut[i * 4 + 1] = palette[i * 3 + 1] * s;
        lut[i * 4 + 2] = palette[i * 3 + 2] * s;
        lut[i * 4 + 3] = a;
    }
    return lut;
}

function greyLut(bitDepth, transparency) {
    const levels = 1 << bitDepth;
    const transparent = transparency ? ((transparency[0] << 8) | transparency[1]) : -1;
    const lut = new Float32Array(levels * 4);
    for (let v = 0; v < levels; v++) {
        if (v === transparent) continue;
        const grey = (v * 255) / (levels - 1);
        lut[v * 4] = lut[v * 4 + 1] = lut[v * 4 + 2] = grey;
        lut[v * 4 + 3] = 255;
    }
    return lut;
}

function unfilter(type, row, previous, bpp) {
    const n = row.length;
    switch (type) {
        case 0: // None
            return;
        case 1: // Sub
            for (let i = bpp; i < n; i++) row[i] += row[i - bpp];
            return;
        case 2: // Up
            if (previous) for (let i = 0; i < n; i++) row[i] += previous[i];
            return;
        case 3: // Average
            for (let i = 0; i < n; i++) {
                const left = i >= bpp ? row[i - bpp] : 0;
                const up = previous ? previous[i] : 0;
                row[i] += (left + up) >> 1;
            }
            return;
        case 4: // Paeth
            for (let i = 0; i < n; i++) {
                const a = i >= bpp ? row[i - bpp] : 0;
                const b = previous ? previous[i] : 0;
                const c = previous && i >= bpp ? previous[i - bpp] : 0;
                row[i] += paeth(a, b, c);
            }
            return;
        default:
            throw new PngError(`invalid row filter type ${type}`);
    }
}

function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    return pb <= pc ? b : c;
}

/* ----------------------------------------------------------------------------- encoder */

function chunk(type, parts) {
    const length = parts.reduce((sum, p) => sum + p.length, 0);
    const out = new Uint8Array(length + 12);
    const view = new DataView(out.buffer);
    view.setUint32(0, length);
    const typeBytes = new Uint8Array([...type].map((ch) => ch.charCodeAt(0)));
    out.set(typeBytes, 4);
    let pos = 8;
    for (const p of parts) {
        out.set(p, pos);
        pos += p.length;
    }
    view.setUint32(pos, crc32([typeBytes, ...parts]));
    return out;
}

// Compressed output is gathered into IDAT chunks of at least this many bytes
const IDAT_TARGET_BYTES = 256 * 1024;

/**
 * Streaming 8-bit PNG writer, RGBA (channels = 4) or greyscale (channels = 1). Feed it
 * complete scanlines (filter byte + channels * width bytes each) with write(), then call
 * close(). `readable` yields the PNG file.
 */
export class PngStreamEncoder {
    constructor(width, height, channels = 4) {
        if (channels !== 1 && channels !== 4) throw new Error('channels must be 1 or 4');
        this.width = width;
        this.height = height;
        this.rowBytes = width * channels + 1;

        const ihdr = new Uint8Array(13);
        const view = new DataView(ihdr.buffer);
        view.setUint32(0, width);
        view.setUint32(4, height);
        ihdr[8] = 8;                        // bit depth
        ihdr[9] = channels === 4 ? 6 : 0;   // RGBA or greyscale
        // compression, filter method and interlace are all 0
        const head = new Uint8Array(SIGNATURE.length + 25);
        head.set(SIGNATURE, 0);
        head.set(chunk('IHDR', [ihdr]), SIGNATURE.length);

        let pending = [];
        let pendingBytes = 0;
        const deflate = new CompressionStream('deflate'); // zlib format, as PNG requires
        this.writer = deflate.writable.getWriter();
        this.readable = deflate.readable.pipeThrough(new TransformStream({
            start(controller) {
                controller.enqueue(head);
            },
            transform(data, controller) {
                pending.push(data);
                pendingBytes += data.length;
                if (pendingBytes >= IDAT_TARGET_BYTES) {
                    controller.enqueue(chunk('IDAT', pending));
                    pending = [];
                    pendingBytes = 0;
                }
            },
            flush(controller) {
                if (pendingBytes > 0) controller.enqueue(chunk('IDAT', pending));
                controller.enqueue(chunk('IEND', []));
            }
        }));
    }

    /** Write one or more complete, already filtered scanlines. Waits under backpressure. */
    async write(scanlines) {
        await this.writer.ready;
        await this.writer.write(scanlines);
    }

    async close() {
        await this.writer.close();
    }

    /** Fail the output stream, so the client sees an aborted response, not a short PNG. */
    abort(reason) {
        this.writer.abort(reason).catch(() => {});
    }
}

/**
 * Filter one scanline (any channel count) for PNG output: dst[0] gets the filter type and dst[1..] the
 * filtered bytes. `previous` is the prior row's unfiltered bytes (null for the first row).
 *
 * Always uses the Up filter. On resampled cloud imagery it compresses as well as Paeth or
 * better (vertical neighbours are interpolated from the same source rows) and costs a
 * fraction of the CPU time.
 */
export function filterScanline(dst, current, previous) {
    const n = current.length;
    dst[0] = 2;
    if (!previous) {
        dst.set(current, 1);
        return;
    }
    for (let i = 0; i < n; i++) dst[1 + i] = current[i] - previous[i];
}
