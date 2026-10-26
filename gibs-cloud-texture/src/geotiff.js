/* geotiff.js - the small subset of TIFF and GeoTIFF needed to read a single-band raster such
 * as the NSIDC Sea Ice Index concentration grids, with no dependencies.
 *
 * Supported: classic (32-bit offset) TIFF in either byte order; strips or tiles; one sample
 * per pixel of 8, 16 or 32-bit integers or 32-bit floats; no compression, LZW, Deflate or
 * PackBits; horizontal-differencing predictor (Predictor 2). That covers what GDAL writes by
 * default. BigTIFF, JPEG, multi-band images and other compression schemes are rejected with a
 * TiffError rather than misread.
 *
 * Georeferencing comes from ModelTiepoint + ModelPixelScale or ModelTransformation, and is
 * returned as a GDAL-style geotransform for pixel corners. GeoKeys are returned by key ID with
 * their double and ASCII parameters resolved.
 */

export class TiffError extends Error {
    constructor(message) {
        super(message);
        this.name = 'TiffError';
    }
}

// Rasters bigger than this are refused, so a bad or unexpected file can't exhaust a Worker's
// memory (the NSIDC 25 km grids are 304x448 and 316x332).
const MAX_PIXELS = 4096 * 4096;

const TAG = {
    ImageWidth: 256,
    ImageLength: 257,
    BitsPerSample: 258,
    Compression: 259,
    StripOffsets: 273,
    SamplesPerPixel: 277,
    RowsPerStrip: 278,
    StripByteCounts: 279,
    Predictor: 317,
    TileWidth: 322,
    TileLength: 323,
    TileOffsets: 324,
    TileByteCounts: 325,
    SampleFormat: 339,
    ModelPixelScale: 33550,
    ModelTiepoint: 33922,
    ModelTransformation: 34264,
    GeoKeyDirectory: 34735,
    GeoDoubleParams: 34736,
    GeoAsciiParams: 34737,
    GdalNoData: 42113
};

const COMPRESSION = { NONE: 1, LZW: 5, DEFLATE: 8, DEFLATE_OLD: 32946, PACKBITS: 32773 };

/** GeoKey IDs used by this Worker (GeoTIFF 1.1 spec, section 7.1). */
export const GEOKEY = {
    GTModelType: 1024,
    GTRasterType: 1025,
    GeographicType: 2048,
    GeogEllipsoid: 2056,
    GeogSemiMajorAxis: 2057,
    GeogSemiMinorAxis: 2058,
    GeogInvFlattening: 2059,
    ProjectedCSType: 3072,
    ProjCoordTrans: 3075,
    ProjStdParallel1: 3078,
    ProjNatOriginLat: 3081,
    ProjFalseEasting: 3082,
    ProjFalseNorthing: 3083,
    ProjScaleAtNatOrigin: 3092,
    ProjStraightVertPoleLong: 3095
};

const RASTER_PIXEL_IS_POINT = 2;

// bytes per value of each TIFF field type
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

/**
 * Read the first image of a TIFF file.
 * @param {Uint8Array} bytes
 * @returns {Promise<{width: number, height: number, raster: Uint8Array|Int8Array|Uint16Array|
 *   Int16Array|Uint32Array|Int32Array|Float32Array, geoTransform: number[]|null,
 *   geoKeys: Object<number, number|string|number[]>, noData: number|null, compression: number}>}
 *   `raster` holds width * height samples, row by row from the top. `geoTransform` maps pixel
 *   corner coordinates (col, row) to the model's x and y, as in GDAL:
 *   x = gt[0] + col * gt[1] + row * gt[2],  y = gt[3] + col * gt[4] + row * gt[5].
 */
export async function readGeoTiff(bytes) {
    const ifd = parseFirstIfd(bytes);
    const get = (tag, fallback) => ifd.values(tag) ?? fallback;
    const one = (tag, fallback) => get(tag, [fallback])[0];

    const width = one(TAG.ImageWidth);
    const height = one(TAG.ImageLength);
    if (!width || !height) throw new TiffError('missing image size');
    if (width * height > MAX_PIXELS) throw new TiffError(`image is ${width}x${height}, larger than allowed`);

    const samplesPerPixel = one(TAG.SamplesPerPixel, 1);
    if (samplesPerPixel !== 1) throw new TiffError(`${samplesPerPixel} samples per pixel; only single-band images are supported`);
    const bits = one(TAG.BitsPerSample, 1);
    const sampleFormat = one(TAG.SampleFormat, 1);
    const ArrayType = sampleArrayType(bits, sampleFormat);
    const compression = one(TAG.Compression, COMPRESSION.NONE);
    if (!Object.values(COMPRESSION).includes(compression)) throw new TiffError(`unsupported compression ${compression}`);
    const predictor = one(TAG.Predictor, 1);
    if (predictor !== 1 && predictor !== 2) throw new TiffError(`unsupported predictor ${predictor}`);
    if (predictor === 2 && sampleFormat === 3) throw new TiffError('horizontal predictor with floating point samples');

    // Strips are tiles as wide as the image
    const tiled = ifd.has(TAG.TileWidth);
    const blockWidth = tiled ? one(TAG.TileWidth) : width;
    const blockHeight = tiled ? one(TAG.TileLength) : Math.min(one(TAG.RowsPerStrip, height), height);
    const offsets = get(tiled ? TAG.TileOffsets : TAG.StripOffsets);
    const counts = get(tiled ? TAG.TileByteCounts : TAG.StripByteCounts);
    if (!blockWidth || !blockHeight || !offsets || !counts) throw new TiffError('missing strip or tile layout');
    const across = Math.ceil(width / blockWidth);
    const down = Math.ceil(height / blockHeight);
    if (offsets.length < across * down || counts.length < across * down) {
        throw new TiffError(`expected ${across * down} strips or tiles, found ${offsets.length}`);
    }

    const bytesPerSample = bits / 8;
    const raster = new ArrayType(width * height);
    for (let by = 0; by < down; by++) {
        for (let bx = 0; bx < across; bx++) {
            const index = by * across + bx;
            const start = offsets[index];
            const end = start + counts[index];
            if (end > bytes.length) throw new TiffError('truncated file (a strip or tile runs past its end)');
            // the last strip may be shorter; tiles are always full size
            const rows = tiled ? blockHeight : Math.min(blockHeight, height - by * blockHeight);
            const expected = blockWidth * rows * bytesPerSample;
            const block = await decompress(bytes.subarray(start, end), compression, expected);
            if (block.length < expected) {
                throw new TiffError(`${tiled ? 'tile' : 'strip'} ${index} decoded to ${block.length} bytes, expected ${expected}`);
            }
            const samples = toSamples(block, expected / bytesPerSample, ArrayType, bits, sampleFormat, ifd.littleEndian);
            if (predictor === 2) undoHorizontalDifferencing(samples, blockWidth, rows);
            placeBlock(raster, width, height, samples, blockWidth, rows, bx * blockWidth, by * blockHeight);
        }
    }

    const geoKeys = readGeoKeys(ifd);
    const noDataText = ifd.values(TAG.GdalNoData);
    const noData = noDataText ? Number.parseFloat(noDataText) : null;
    return {
        width,
        height,
        raster,
        compression,
        geoKeys,
        geoTransform: readGeoTransform(ifd, geoKeys),
        noData: Number.isFinite(noData) ? noData : null
    };
}

/* ------------------------------------------------------------------------------- IFD */

function parseFirstIfd(bytes) {
    if (bytes.length < 8) throw new TiffError('not a TIFF file (too short)');
    const order = String.fromCharCode(bytes[0], bytes[1]);
    if (order !== 'II' && order !== 'MM') throw new TiffError('not a TIFF file');
    const littleEndian = order === 'II';
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const magic = view.getUint16(2, littleEndian);
    if (magic === 43) throw new TiffError('BigTIFF files are not supported');
    if (magic !== 42) throw new TiffError('not a TIFF file');

    const ifdOffset = view.getUint32(4, littleEndian);
    if (ifdOffset + 2 > bytes.length) throw new TiffError('truncated file (no image directory)');
    const count = view.getUint16(ifdOffset, littleEndian);
    if (ifdOffset + 2 + count * 12 > bytes.length) throw new TiffError('truncated file (in the image directory)');

    const entries = new Map();
    for (let i = 0; i < count; i++) {
        const at = ifdOffset + 2 + i * 12;
        entries.set(view.getUint16(at, littleEndian), {
            type: view.getUint16(at + 2, littleEndian),
            count: view.getUint32(at + 4, littleEndian),
            at: at + 8
        });
    }

    const cache = new Map();
    // A tag's values: an array of numbers, or a string for ASCII. Read when first asked for,
    // so tags this reader doesn't need (such as a 65536-entry ColorMap) are never decoded.
    const values = (tag) => {
        if (cache.has(tag)) return cache.get(tag);
        const entry = entries.get(tag);
        const value = entry ? readEntry(view, entry, littleEndian) : undefined;
        cache.set(tag, value);
        return value;
    };
    return { littleEndian, has: (tag) => entries.has(tag), values };
}

function readEntry(view, { type, count, at }, le) {
    const size = TYPE_SIZE[type];
    if (!size) throw new TiffError(`unknown field type ${type}`);
    const offset = size * count <= 4 ? at : view.getUint32(at, le);
    if (offset + size * count > view.byteLength) throw new TiffError('truncated file (a tag points past its end)');
    if (type === 2) {
        let text = '';
        for (let i = 0; i < count; i++) text += String.fromCharCode(view.getUint8(offset + i));
        return text;
    }
    const out = new Array(count);
    for (let i = 0; i < count; i++) {
        const p = offset + i * size;
        switch (type) {
            case 1: case 7: out[i] = view.getUint8(p); break;
            case 6: out[i] = view.getInt8(p); break;
            case 3: out[i] = view.getUint16(p, le); break;
            case 8: out[i] = view.getInt16(p, le); break;
            case 4: out[i] = view.getUint32(p, le); break;
            case 9: out[i] = view.getInt32(p, le); break;
            case 5: out[i] = view.getUint32(p, le) / view.getUint32(p + 4, le); break;
            case 10: out[i] = view.getInt32(p, le) / view.getInt32(p + 4, le); break;
            case 11: out[i] = view.getFloat32(p, le); break;
            case 12: out[i] = view.getFloat64(p, le); break;
        }
    }
    return out;
}

/* ---------------------------------------------------------------------------- pixels */

function sampleArrayType(bits, format) {
    const types = {
        1: { 8: Uint8Array, 16: Uint16Array, 32: Uint32Array },
        2: { 8: Int8Array, 16: Int16Array, 32: Int32Array },
        3: { 32: Float32Array }
    };
    const type = types[format]?.[bits];
    if (!type) throw new TiffError(`unsupported sample type (${bits}-bit, SampleFormat ${format})`);
    return type;
}

/** Turn decompressed bytes in the file's byte order into `count` samples. */
function toSamples(block, count, ArrayType, bits, format, le) {
    if (bits === 8) return new ArrayType(block.buffer, block.byteOffset, count);
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    const out = new ArrayType(count);
    if (bits === 16) {
        if (format === 2) for (let i = 0; i < count; i++) out[i] = view.getInt16(i * 2, le);
        else for (let i = 0; i < count; i++) out[i] = view.getUint16(i * 2, le);
    } else if (format === 3) {
        for (let i = 0; i < count; i++) out[i] = view.getFloat32(i * 4, le);
    } else if (format === 2) {
        for (let i = 0; i < count; i++) out[i] = view.getInt32(i * 4, le);
    } else {
        for (let i = 0; i < count; i++) out[i] = view.getUint32(i * 4, le);
    }
    return out;
}

/** Predictor 2: each sample is stored as the difference from the one to its left. */
function undoHorizontalDifferencing(samples, width, rows) {
    // the typed array wraps sums around at its bit depth, as the predictor requires
    for (let y = 0; y < rows; y++) {
        const start = y * width;
        for (let x = start + 1; x < start + width; x++) samples[x] += samples[x - 1];
    }
}

function placeBlock(raster, width, height, samples, blockWidth, rows, x0, y0) {
    const count = Math.min(blockWidth, width - x0);
    for (let y = 0; y < rows && y0 + y < height; y++) {
        raster.set(samples.subarray(y * blockWidth, y * blockWidth + count), (y0 + y) * width + x0);
    }
}

/* ----------------------------------------------------------------------- compression */

async function decompress(data, compression, expected) {
    switch (compression) {
        case COMPRESSION.NONE:
            return data;
        case COMPRESSION.LZW:
            return lzwDecode(data, expected);
        case COMPRESSION.PACKBITS:
            return packBitsDecode(data, expected);
        default: // Deflate: zlib streams, as GDAL and libtiff write them
            try {
                const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate'));
                return new Uint8Array(await new Response(stream).arrayBuffer());
            } catch (error) {
                throw new TiffError(`corrupt Deflate data: ${error.message}`);
            }
    }
}

const LZW_CLEAR = 256;
const LZW_END = 257;

/**
 * TIFF LZW (TIFF 6.0 section 13): MSB-first codes of 9 to 12 bits, with the code width growing
 * one code early, as libtiff writes it. Decodes at most `expected` bytes.
 */
export function lzwDecode(input, expected) {
    const out = new Uint8Array(expected);
    const prefix = new Int16Array(4096);
    const suffix = new Uint8Array(4096);
    const length = new Uint16Array(4096);
    for (let i = 0; i < 256; i++) {
        prefix[i] = -1;
        suffix[i] = i;
        length[i] = 1;
    }

    let pos = 0;           // bytes written
    let bitBuffer = 0;
    let bitCount = 0;
    let inputPos = 0;
    let width = 9;
    let next = 258;
    let previous = -1;

    // Write the string for `code` at `pos` (it may run past `expected`; the tail is dropped)
    const emit = (code) => {
        const n = length[code];
        let c = code;
        for (let i = n - 1; i >= 0; i--) {
            if (pos + i < expected) out[pos + i] = suffix[c];
            c = prefix[c];
        }
        pos += n;
    };
    const firstByte = (code) => {
        let c = code;
        while (prefix[c] !== -1) c = prefix[c];
        return suffix[c];
    };

    while (pos < expected) {
        while (bitCount < width && inputPos < input.length) {
            bitBuffer = ((bitBuffer << 8) | input[inputPos++]) >>> 0;
            bitCount += 8;
        }
        if (bitCount < width) break; // out of data
        const code = (bitBuffer >>> (bitCount - width)) & ((1 << width) - 1);
        bitCount -= width;
        bitBuffer &= (1 << bitCount) - 1;

        if (code === LZW_END) break;
        if (code === LZW_CLEAR) {
            width = 9;
            next = 258;
            previous = -1;
            continue;
        }
        if (previous === -1) {
            if (code > 255) throw new TiffError('corrupt LZW data (first code after a clear is not a byte)');
            emit(code);
            previous = code;
            continue;
        }
        let first;
        if (code < next) {
            first = firstByte(code);
            emit(code);
        } else if (code === next) {
            // the code being defined right now: the previous string plus its own first byte
            first = firstByte(previous);
            emit(previous);
            if (pos < expected) out[pos] = first;
            pos += 1;
        } else {
            throw new TiffError(`corrupt LZW data (code ${code} before ${next} was defined)`);
        }
        if (next < 4096) {
            prefix[next] = previous;
            suffix[next] = first;
            length[next] = length[previous] + 1;
            next++;
            if (next >= (1 << width) - 1 && width < 12) width++;
        }
        previous = code;
    }
    return pos >= expected ? out : out.subarray(0, pos);
}

/** PackBits run-length decoding (TIFF 6.0 section 9). */
export function packBitsDecode(input, expected) {
    const out = new Uint8Array(expected);
    let pos = 0;
    let i = 0;
    while (i < input.length && pos < expected) {
        const n = (input[i++] << 24) >> 24; // as a signed byte
        if (n >= 0) {
            const count = Math.min(n + 1, expected - pos, input.length - i);
            out.set(input.subarray(i, i + count), pos);
            pos += count;
            i += n + 1;
        } else if (n !== -128) {
            const count = Math.min(1 - n, expected - pos);
            out.fill(input[i++], pos, pos + count);
            pos += count;
        }
    }
    return pos >= expected ? out : out.subarray(0, pos);
}

/* ---------------------------------------------------------------------- georeference */

function readGeoKeys(ifd) {
    const directory = ifd.values(TAG.GeoKeyDirectory);
    const keys = {};
    if (!directory || directory.length < 4) return keys;
    const doubles = ifd.values(TAG.GeoDoubleParams) ?? [];
    const ascii = ifd.values(TAG.GeoAsciiParams) ?? '';
    const count = directory[3];
    for (let i = 0; i < count && 4 + i * 4 + 3 < directory.length; i++) {
        const [id, location, n, value] = directory.slice(4 + i * 4, 8 + i * 4);
        if (location === 0) {
            keys[id] = value;
        } else if (location === TAG.GeoDoubleParams) {
            keys[id] = n === 1 ? doubles[value] : doubles.slice(value, value + n);
        } else if (location === TAG.GeoAsciiParams) {
            keys[id] = ascii.slice(value, value + n).replace(/[|\0]+$/, '');
        } else if (location === TAG.GeoKeyDirectory) {
            keys[id] = n === 1 ? directory[value] : directory.slice(value, value + n);
        }
    }
    return keys;
}

function readGeoTransform(ifd, geoKeys) {
    let gt = null;
    const matrix = ifd.values(TAG.ModelTransformation);
    const tiepoint = ifd.values(TAG.ModelTiepoint);
    const scale = ifd.values(TAG.ModelPixelScale);
    if (matrix && matrix.length >= 16) {
        gt = [matrix[3], matrix[0], matrix[1], matrix[7], matrix[4], matrix[5]];
    } else if (tiepoint && tiepoint.length >= 6 && scale && scale.length >= 2) {
        const [i, j, , x, y] = tiepoint;
        gt = [x - i * scale[0], scale[0], 0, y + j * scale[1], 0, -scale[1]];
    }
    if (!gt) return null;
    // PixelIsPoint: the model coordinates are those of pixel centers; move them to corners
    if (geoKeys[GEOKEY.GTRasterType] === RASTER_PIXEL_IS_POINT) {
        gt[0] -= 0.5 * (gt[1] + gt[2]);
        gt[3] -= 0.5 * (gt[4] + gt[5]);
    }
    return gt;
}
