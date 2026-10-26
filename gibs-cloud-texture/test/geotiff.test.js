import test from 'node:test';
import assert from 'node:assert/strict';
import { readGeoTiff, TiffError, lzwDecode } from '../src/geotiff.js';
import { EPSG_PROJECTIONS, ProjectionError, polarStereographic, projectionFromGeoKeys } from '../src/polarstereo.js';
import { lzwEncode, makeTiff } from './tiff-helpers.js';

const WIDTH = 37, HEIGHT = 29; // odd sizes, so strips and tiles don't divide them evenly
// concentrations, runs (for LZW and PackBits), and the NSIDC flag values
const VALUES = Array.from({ length: WIDTH * HEIGHT }, (_, i) =>
    i % 11 === 0 ? 2540 : i % 13 === 0 ? 2530 : i % 17 === 0 ? 2510 : (i * 37) % 1001);
const GEO = { tiepoint: [0, 0, 0, -3850000, 5850000, 0], scale: [25000, 25000, 0], geoKeys: [[1024, 1], [1025, 1], [3072, 3411]] };

test('reads every layout and compression GDAL writes', async () => {
    const cases = [
        {},
        { compression: 'deflate' },
        { compression: 'deflate', predictor: 2 },
        { compression: 'lzw' },
        { compression: 'lzw', predictor: 2 },
        { compression: 'packbits' },
        { compression: 'lzw', tile: [16, 16] },
        { compression: 'deflate', predictor: 2, tile: [32, 8] },
        { compression: 'lzw', littleEndian: false },
        { compression: 'lzw', predictor: 2, littleEndian: false, tile: [16, 16] },
        { rowsPerStrip: 1 },
        { rowsPerStrip: HEIGHT, compression: 'lzw', colorMap: true }
    ];
    for (const options of cases) {
        const tiff = await readGeoTiff(makeTiff({ width: WIDTH, height: HEIGHT, values: VALUES, ...GEO, ...options }));
        const label = JSON.stringify(options);
        assert.equal(tiff.width, WIDTH, label);
        assert.equal(tiff.height, HEIGHT, label);
        assert.ok(tiff.raster instanceof Uint16Array, label);
        assert.deepEqual([...tiff.raster], VALUES, label);
        assert.deepEqual(tiff.geoTransform, [-3850000, 25000, 0, 5850000, 0, -25000], label);
        assert.equal(tiff.geoKeys[3072], 3411, label);
    }
});

test('reads 8-bit and signed samples', async () => {
    const bytes = VALUES.map((v) => v & 255);
    const u8 = await readGeoTiff(makeTiff({ width: WIDTH, height: HEIGHT, values: bytes, bits: 8, compression: 'lzw', predictor: 2 }));
    assert.ok(u8.raster instanceof Uint8Array);
    assert.deepEqual([...u8.raster], bytes);

    const signed = VALUES.map((v) => v - 1300);
    const i16 = await readGeoTiff(makeTiff({ width: WIDTH, height: HEIGHT, values: signed, sampleFormat: 2, compression: 'deflate' }));
    assert.ok(i16.raster instanceof Int16Array);
    assert.deepEqual([...i16.raster], signed);
    assert.equal(i16.geoTransform, null); // no georeferencing tags
});

test('LZW handles long inputs that fill the code table several times', () => {
    let seed = 1;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const input = Uint8Array.from({ length: 200_000 }, (_, i) => (i % 5000 < 2500 ? (i >> 6) & 255 : Math.floor(random() * 256)));
    assert.deepEqual(lzwDecode(lzwEncode(input), input.length), input);
});

test('georeferencing: ModelTransformation, PixelIsPoint, and GeoKey parameters', async () => {
    const base = { width: 4, height: 3, values: new Array(12).fill(0) };
    const matrix = await readGeoTiff(makeTiff({
        ...base, transformation: [25000, 0, 0, -3950000, 0, -25000, 0, 4350000, 0, 0, 0, 0, 0, 0, 0, 1]
    }));
    assert.deepEqual(matrix.geoTransform, [-3950000, 25000, 0, 4350000, 0, -25000]);

    // PixelIsPoint: the tiepoint is the center of the top-left pixel
    const point = await readGeoTiff(makeTiff({
        ...base, tiepoint: [0, 0, 0, -3837500, 5837500, 0], scale: [25000, 25000, 0], geoKeys: [[1025, 2], [3072, 3411]]
    }));
    assert.deepEqual(point.geoTransform, [-3850000, 25000, 0, 5850000, 0, -25000]);

    const custom = await readGeoTiff(makeTiff({
        ...base, ...GEO,
        geoKeys: [[1024, 1], [1026, 'NSIDC Sea Ice PS N'], [3072, 32767], [3075, 15], [3081, { double: 70 }],
            [3095, { double: -45 }], [2057, { double: 6378273 }], [2059, 298.279411123064]]
    }));
    assert.equal(custom.geoKeys[1026], 'NSIDC Sea Ice PS N');
    assert.equal(custom.geoKeys[3081], 70);
    assert.equal(custom.geoKeys[3095], -45);
    assert.equal(custom.geoKeys[2059], 298.279411123064);
});

test('rejects what it cannot read with a TiffError', async () => {
    const base = { width: 4, height: 3, values: new Array(12).fill(1) };
    await assert.rejects(readGeoTiff(makeTiff({ ...base, bigTiff: true })), (e) => e instanceof TiffError && /BigTIFF/.test(e.message));
    await assert.rejects(readGeoTiff(makeTiff({ ...base, samplesPerPixel: 3 })), (e) => e instanceof TiffError && /single-band/.test(e.message));
    await assert.rejects(readGeoTiff(new TextEncoder().encode('<html>Not Found</html>')), TiffError);

    // compression 7 (JPEG): patch the Compression tag of an otherwise valid file
    const jpeg = makeTiff(base);
    const view = new DataView(jpeg.buffer);
    const ifd = view.getUint32(4, true);
    for (let i = 0; i < view.getUint16(ifd, true); i++) {
        const at = ifd + 2 + i * 12;
        if (view.getUint16(at, true) === 259) view.setUint16(at + 8, 7, true);
    }
    await assert.rejects(readGeoTiff(jpeg), (e) => e instanceof TiffError && /compression 7/.test(e.message));

    const truncated = makeTiff({ ...base, compression: 'deflate' });
    await assert.rejects(readGeoTiff(truncated.subarray(0, 40)), TiffError);
});

/* ------------------------------------------------------------------------ projection */

// Reference points from PROJ 9 (pyproj), in metres
const PROJ_POINTS = {
    3411: [[0, 60, 2349878.836, -2349878.836], [-45, 75, 0, -1633913.954], [135, 85, 0, 541978.122], [-120, 40.5, -5514759.856, -1477675.45]],
    3412: [[0, -70, 0, 2187973.819], [90, -60, 3323230.519, 0], [-150, -80, -542971.594, -940454.388], [45, -45, 3628719.588, 3628719.588]]
};

test('polar stereographic matches PROJ for EPSG:3411 and EPSG:3412', () => {
    for (const [code, points] of Object.entries(PROJ_POINTS)) {
        const projection = polarStereographic(EPSG_PROJECTIONS[code]);
        for (const [lon, lat, x, y] of points) {
            const [px, py] = projection.forward(lon, lat);
            assert.ok(Math.abs(px - x) < 0.002 && Math.abs(py - y) < 0.002, `EPSG:${code} ${lon},${lat}: ${px},${py}`);
        }
    }
});

test('the projection comes from an EPSG code or from user-defined GeoKeys', () => {
    assert.equal(projectionFromGeoKeys({ 3072: 3412 }).name, 'EPSG:3412');
    assert.equal(projectionFromGeoKeys({}), null);

    // what GDAL writes for EPSG:3411 described by its parameters instead of its code
    const custom = projectionFromGeoKeys({
        1024: 1, 2048: 32767, 2057: 6378273, 2059: 298.279411123064, 3072: 32767, 3075: 15,
        3076: 9001, 3081: 70, 3082: 0, 3083: 0, 3092: 1, 3095: -45
    });
    assert.equal(custom.north, true);
    const [x, y] = custom.forward(0, 60);
    assert.ok(Math.abs(x - 2349878.836) < 0.002 && Math.abs(y + 2349878.836) < 0.002);

    assert.throws(() => projectionFromGeoKeys({ 3072: 32633 }), ProjectionError); // UTM 33N
    assert.throws(() => projectionFromGeoKeys({ 3072: 32767, 3075: 1 }), ProjectionError); // transverse Mercator
    assert.throws(() => projectionFromGeoKeys({ 3072: 32767, 3075: 15, 3076: 9002 }), ProjectionError); // feet
});
