import test from 'node:test';
import assert from 'node:assert/strict';
import { tileGrid, UpstreamError } from '../src/gibs.js';
import { decodePng } from '../src/png.js';
import { filterTaps } from '../src/resample.js';
import { createTexture } from '../src/texture.js';
import { fakeGibs, readRgba, solidTile } from './helpers.js';

const config = { gibsBaseUrl: 'https://gibs.test', layer: 'TEST_LAYER', tileMatrixSet: '1km' };

async function build(options, fetchImpl) {
    const texture = await createTexture({ date: '2026-10-12', config, fetchImpl, ...options });
    const png = new Uint8Array(await new Response(texture.stream).arrayBuffer());
    await texture.done;
    return { texture, image: await readRgba(png, decodePng) };
}

test('tile grid matches the GIBS EPSG:4326 tile matrices', () => {
    const expected = [[2, 1], [3, 2], [5, 3], [10, 5], [20, 10], [40, 20], [80, 40]];
    expected.forEach(([cols, rows], level) => {
        const g = tileGrid(level);
        assert.deepEqual([g.cols, g.rows], [cols, rows], `level ${level}`);
        assert.equal(g.width, 2 * g.height);
        assert.equal(g.degreesPerPixel, 0.5625 / 2 ** level);
    });
});

test('filter taps are normalised, wrap in longitude and clamp in latitude', () => {
    for (const [inSize, outSize] of [[5120, 8192], [5120, 1024], [640, 1024], [10240, 4096]]) {
        for (const wrap of [true, false]) {
            const t = filterTaps(inSize, outSize, { wrap });
            for (let o = 0; o < outSize; o++) {
                let sum = 0;
                for (let k = t.offsets[o]; k < t.offsets[o + 1]; k++) {
                    sum += t.weight[k];
                    assert.ok(t.index[k] >= 0 && t.index[k] < inSize);
                }
                assert.ok(Math.abs(sum - 1) < 1e-5);
            }
        }
    }
    const wrapped = filterTaps(640, 1024, { wrap: true });
    assert.equal(wrapped.index[wrapped.offsets[0]], 639); // column -1 is the last column
});

test('tiles land at the right longitudes, and the antimeridian blends across the seam', async () => {
    // Level 0: tile column 0 spans 180W-108E, column 1 spans 108E-180E (plus empty overhang)
    const gibs = fakeGibs((level, row, col) => solidTile(col === 0 ? 1 : 3));
    const { image } = await build({ tileMatrix: 0, outputRes: '1k' }, gibs);
    assert.equal(gibs.requests.length, 2);
    assert.deepEqual(image.pixel(400, 256), [184, 0, 185, 255]);  // 39W: ice colour
    assert.deepEqual(image.pixel(900, 10), [255, 255, 0, 255]);   // 136E: water colour
    // x = 0 is 0.8125 tile 0 + 0.1875 of the last source column (which belongs to tile 1)
    assert.deepEqual(image.pixel(0, 256), [197, 48, 150, 255]);
});

test('cloud edges fade in alpha without picking up the no-data colour', async () => {
    const gibs = fakeGibs((level, row, col) => solidTile(col === 0 ? 0 : 4)); // transparent | red
    const { image } = await build({ tileMatrix: 0, outputRes: '1k' }, gibs);
    assert.deepEqual(image.pixel(400, 256), [0, 0, 0, 0]);
    const edge = [818, 819, 820].map((x) => image.pixel(x, 256));
    assert.ok(edge.some(([, , , a]) => a > 0 && a < 255), 'expected a partly transparent edge');
    for (const [r, g, b, a] of edge) if (a > 0) assert.deepEqual([r, g, b], [255, 0, 0]);
});

test('defaults: a level 3 texture uses all 50 tiles and is 8192x4096', async () => {
    const gibs = fakeGibs(() => solidTile(2));
    const texture = await createTexture({ date: '2026-10-12', tileMatrix: 3, outputRes: '8k', config, fetchImpl: gibs });
    assert.equal(gibs.requests.length, 50); // all fetched and checked before streaming starts
    assert.equal(texture.complete, true);
    const png = new Uint8Array(await new Response(texture.stream).arrayBuffer());
    const reader = await decodePng(png);
    assert.deepEqual([reader.width, reader.height], [8192, 4096]);
    assert.match(gibs.requests[0], /TIME=2026-10-12T00%3A00%3A00Z/);
    assert.match(gibs.requests[0], /layer=TEST_LAYER/);
    assert.match(gibs.requests[0], /tilematrixset=1km/);
});

test('retries tiles that fail with 503', async () => {
    const failed = new Set();
    const gibs = fakeGibs((level, row, col) => {
        const key = `${row}/${col}`;
        if (!failed.has(key)) {
            failed.add(key);
            return new Response('busy', { status: 503 });
        }
        return solidTile(1);
    });
    await build({ tileMatrix: 0, outputRes: '1k' }, gibs);
    assert.equal(gibs.requests.length, 4);
});

test('reports GIBS errors before any bytes are sent', async () => {
    const exception = '<ExceptionReport><Exception><ExceptionText>Invalid TIME</ExceptionText></Exception></ExceptionReport>';
    const badTime = fakeGibs(() => new Response(exception, { status: 400 }));
    await assert.rejects(createTexture({ date: '2026-10-12', tileMatrix: 3, outputRes: '1k', config, fetchImpl: badTime }),
        (error) => error instanceof UpstreamError && error.upstreamStatus === 400 && /Invalid TIME/.test(error.detail));

    const html = fakeGibs(() => new Response('<html>down</html>', { headers: { 'content-type': 'text/html' } }));
    await assert.rejects(createTexture({ date: '2026-10-12', tileMatrix: 0, outputRes: '1k', config, fetchImpl: html }),
        /text\/html instead of a PNG/);

    // at level 3 every tile is checked up front, so a bad last tile still fails early
    const lastTileBad = fakeGibs((level, row, col) => (row === 4 && col === 9 ? new Response('x', { status: 404 }) : solidTile(1)));
    await assert.rejects(createTexture({ date: '2026-10-12', tileMatrix: 3, outputRes: '1k', config, fetchImpl: lastTileBad }), UpstreamError);
});

test('above level 3 a late tile failure aborts the stream instead', async () => {
    const gibs = fakeGibs((level, row) => (row === 6 ? new Response('gone', { status: 404 }) : solidTile(1)));
    const texture = await createTexture({ date: '2026-10-12', tileMatrix: 4, outputRes: '1k', config, fetchImpl: gibs });
    assert.equal(texture.complete, false);
    const reading = new Response(texture.stream).arrayBuffer();
    await assert.rejects(texture.done, UpstreamError);
    await assert.rejects(reading);
});
