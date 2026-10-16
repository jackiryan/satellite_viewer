import test from 'node:test';
import assert from 'node:assert/strict';
import { AlbedoMapper, cloudReflectance, parseColormap } from '../src/albedo.js';
import { decodePng } from '../src/png.js';
import { createTexture } from '../src/texture.js';
import { COLORMAP_XML, PALETTE, fakeGibsWithColormap, readRgba, solidTile } from './helpers.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test('reflectance grows with optical thickness and saturates', () => {
    assert.equal(cloudReflectance(0, 'water'), 0);
    close(cloudReflectance(10, 'water'), 1.4 / 3.4);          // (1-g) tau / (2 + (1-g) tau), g = 0.86
    close(cloudReflectance(10, 'ice'), 2.5 / 4.5);            // g = 0.75
    assert.ok(cloudReflectance(1, 'water') < 0.1);
    assert.ok(cloudReflectance(150, 'water') > 0.9);
    for (let tau = 1; tau < 150; tau *= 1.5) assert.ok(cloudReflectance(tau * 1.5, 'water') > cloudReflectance(tau, 'water'));
});

test('parses GIBS colormap XML into reflectance per color', () => {
    const entries = parseColormap(COLORMAP_XML);
    assert.equal(entries.length, 5); // LegendEntry elements are not colormap entries
    const by = Object.fromEntries(entries.map((e) => [e.rgb.join(','), e]));
    assert.equal(by['220,220,255'].reflectance, 0);
    assert.equal(by['184,0,185'].phase, 'ice');
    close(by['184,0,185'].tau, 0.5);                          // open-ended first bin
    close(by['0,122,254'].tau, Math.sqrt(21.813 * 22.638));   // geometric mean of the bin
    assert.equal(by['255,0,0'].phase, 'water');
    close(by['255,0,0'].reflectance, cloudReflectance(Math.sqrt(45.845 * 47.58), 'water'));
});

test('maps palette entries exactly, near misses to the closest entry, and others to clear', () => {
    const mapper = new AlbedoMapper(parseColormap(COLORMAP_XML));
    const lut = mapper.paletteValues(new Uint8Array(PALETTE.flat()), new Uint8Array([0]));
    assert.equal(lut[0], 0);
    close(lut[4], cloudReflectance(Math.sqrt(45.845 * 47.58), 'water'));
    close(mapper.colorValue(254, 1, 0), lut[4]);              // within tolerance
    assert.equal(mapper.colorValue(10, 200, 10), 0);          // not a colormap color
    assert.equal(mapper.colorValue(255, 0, 0, 0), 0);         // transparent pixel
});

test('albedo product: greyscale PNG of sqrt(reflectance)', async () => {
    const gibs = fakeGibsWithColormap((level, row, col) => solidTile(col === 0 ? 4 : 0)); // thick water | no data
    const texture = await createTexture({
        date: '2026-10-12', tileMatrix: 0, outputRes: '1k', product: 'albedo', fetchImpl: gibs,
        config: { gibsBaseUrl: 'https://gibs.test', layer: 'L', tileMatrixSet: '1km', colormapUrl: 'https://gibs.test/colormaps/x.xml' }
    });
    const png = new Uint8Array(await new Response(texture.stream).arrayBuffer());
    await texture.done;
    assert.equal(png[25], 0); // IHDR color type: greyscale
    const image = await readRgba(png, decodePng);
    const expected = Math.round(Math.sqrt(cloudReflectance(Math.sqrt(45.845 * 47.58), 'water')) * 255);
    assert.deepEqual(image.pixel(400, 256), [expected, expected, expected, 255]);
    assert.deepEqual(image.pixel(900, 256), [0, 0, 0, 255]);
    const edge = image.pixel(819, 256)[0];                    // tile boundary blends reflectance
    assert.ok(edge > 0 && edge < expected);
});
