import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { PngStreamEncoder, decodePng, filterScanline } from '../src/png.js';
import { makePng } from './helpers.js';

// Read a decoded row back as straight RGBA numbers
function rgba(reader, width) {
    const out = new Float32Array(width * 4);
    reader.readRow(out, 0);
    const px = [];
    for (let i = 0; i < out.length; i += 4) {
        const a = out[i + 3];
        px.push(a > 0 ? [0, 1, 2].map((c) => Math.round((out[i + c] * 255) / a)).concat(Math.round(a)) : [0, 0, 0, 0]);
    }
    return px;
}

test('decodes 8-bit palette tiles with transparency and every row filter', async () => {
    const palette = [[220, 220, 255], [10, 20, 30], [200, 100, 50]];
    const rows = [[0, 1, 2, 1], [2, 2, 1, 0], [1, 0, 0, 2], [0, 0, 0, 0], [2, 1, 2, 1]];
    const png = makePng({ width: 4, height: 5, colorType: 3, palette, trns: [0], rows, filters: [0, 1, 2, 3, 4] });
    const reader = await decodePng(png);
    for (const row of rows) {
        assert.deepEqual(rgba(reader, 4), row.map((i) => (i === 0 ? [0, 0, 0, 0] : [...palette[i], 255])));
    }
});

test('decodes sub-byte palette and greyscale depths', async () => {
    const palette = [[0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255]];
    // 2-bit palette: 5 pixels -> indices 1,2,3,0,1 packed MSB first
    const png2 = makePng({ width: 5, height: 1, colorType: 3, bitDepth: 2, palette, rows: [[0b01101100, 0b01000000]] });
    assert.deepEqual(rgba(await decodePng(png2), 5).map((p) => p.slice(0, 3)),
        [[255, 0, 0], [0, 255, 0], [0, 0, 255], [0, 0, 0], [255, 0, 0]]);
    // 4-bit grey: values 0, 15, 5 -> 0, 255, 85
    const grey = makePng({ width: 3, height: 1, colorType: 0, bitDepth: 4, rows: [[0x0f, 0x50]] });
    assert.deepEqual(rgba(await decodePng(grey), 3).map((p) => p[0]), [0, 255, 85]);
});

test('decodes RGB with a tRNS colour key and 16-bit RGBA', async () => {
    const rgb = makePng({
        width: 2, height: 1, colorType: 2, rows: [[1, 2, 3, 9, 9, 9]], trns: [0, 9, 0, 9, 0, 9], filters: [1]
    });
    assert.deepEqual(rgba(await decodePng(rgb), 2), [[1, 2, 3, 255], [0, 0, 0, 0]]);

    const rgba16 = makePng({
        width: 1, height: 1, colorType: 6, bitDepth: 16, rows: [[0xff, 0xff, 0x80, 0x80, 0x00, 0x00, 0xff, 0xff]]
    });
    assert.deepEqual(rgba(await decodePng(rgba16), 1), [[255, 128, 0, 255]]);
});

test('rejects files that are not usable PNGs', async () => {
    await assert.rejects(decodePng(new TextEncoder().encode('<html>nope</html>')), /not a PNG/);
    const png = makePng({ width: 2, height: 2, colorType: 0, rows: [[1, 2], [3, 4]] });
    await assert.rejects(decodePng(png.subarray(0, 40)), /truncated/);
});

test('streaming encoder writes a valid PNG that round-trips', async () => {
    const width = 300, height = 7;
    const encoder = new PngStreamEncoder(width, height);
    const collected = new Response(encoder.readable).arrayBuffer();
    const image = [];
    let previous = null;
    for (let y = 0; y < height; y++) {
        const row = new Uint8ClampedArray(width * 4);
        for (let i = 0; i < row.length; i++) row[i] = (i * 7 + y * 31) & 255;
        const line = new Uint8Array(width * 4 + 1);
        filterScanline(line, row, previous);
        await encoder.write(line);
        image.push(row);
        previous = row;
    }
    await encoder.close();
    const png = new Uint8Array(await collected);

    // independent check of the stream structure with zlib
    const buf = Buffer.from(png);
    assert.equal(buf.toString('latin1', 12, 16), 'IHDR');
    assert.equal(buf.toString('latin1', buf.length - 8, buf.length - 4), 'IEND');
    let pos = 8, idat = [];
    while (pos < buf.length) {
        const len = buf.readUInt32BE(pos);
        if (buf.toString('latin1', pos + 4, pos + 8) === 'IDAT') idat.push(buf.subarray(pos + 8, pos + 8 + len));
        pos += 12 + len;
    }
    assert.equal(inflateSync(Buffer.concat(idat)).length, height * (width * 4 + 1));

    // and pixel-exact through our decoder
    const reader = await decodePng(png);
    const out = new Float32Array(width * 4);
    for (let y = 0; y < height; y++) {
        reader.readRow(out, 0);
        for (let i = 0; i < out.length; i += 4) {
            const a = out[i + 3];
            assert.equal(Math.round(a), image[y][i + 3]);
            if (a > 0) assert.equal(Math.round((out[i] * 255) / a), image[y][i]);
        }
    }
});
