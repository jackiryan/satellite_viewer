import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { readGeoTiff } from '../src/geotiff.js';
import { decodePng } from '../src/png.js';
import { EPSG_PROJECTIONS, polarStereographic } from '../src/polarstereo.js';
import {
    LAND_FILL_CELLS, clearSeaIceMemo, createSeaIceTexture, fileExists, prepareGrid, resolveSeaIceDate, seaIceUrl
} from '../src/seaice.js';
import { SEA_ICE_NAMESPACE, SEA_ICE_STORE_VERSION, STORE_NAMESPACE, STORE_VERSION } from '../src/store.js';
import { fakeR2, readRgba } from './helpers.js';
import { NSIDC_GRIDS, fakeNsidc, makeTiff, nsidcTiff } from './tiff-helpers.js';

const HOUR = 3_600_000;
const daysAgo = (n, now = Date.now()) => new Date(now - n * 86_400_000).toISOString().slice(0, 10);
const CONFIG = { seaIce: { baseUrl: 'https://nsidc.test/NOAA/G02135', fileVersion: '4.0', earliestDate: '1978-10-26' } };
const projections = { north: polarStereographic(EPSG_PROJECTIONS[3411]), south: polarStereographic(EPSG_PROJECTIONS[3412]) };

/** The grid cell (col, row) holding a longitude and latitude. */
function cellAt(hemisphere, lon, lat) {
    const g = NSIDC_GRIDS[hemisphere];
    const [x, y] = projections[hemisphere].forward(lon, lat);
    return [Math.floor((x - g.x0) / 25000), Math.floor((g.y0 - y) / 25000)];
}

/** The texture pixel holding a longitude and latitude. */
const pixelAt = (image, lon, lat) => image.pixel(
    Math.floor(((lon + 180) / 360) * image.width), Math.floor(((90 - lat) / 180) * image.height))[0];

// An Arctic grid with a block of 100% ice centered on 80 N 150 W, open water elsewhere, land
// in one corner of the grid (far from the ice) and the pole hole; an Antarctic grid with a
// block of 60% ice centered on 65 S 60 E.
const [iceCol, iceRow] = cellAt('north', -150, 80);
const [southCol, southRow] = cellAt('south', 60, -65);
const NORTH = nsidcTiff('north', (col, row, x, y) => {
    if (Math.abs(col - iceCol) <= 2 && Math.abs(row - iceRow) <= 2) return 1000;
    if (Math.abs(x) < 150000 && Math.abs(y) < 150000) return 2510;
    if (col < 20 && row < 20) return col === 19 || row === 19 ? 2530 : 2540;
    return 0;
});
const SOUTH = nsidcTiff('south', (col, row) =>
    (Math.abs(col - southCol) <= 2 && Math.abs(row - southRow) <= 2 ? 600 : 0), { compression: 'deflate' });

let r2, nsidc, published, ENV;

beforeEach(() => {
    clearSeaIceMemo();
    r2 = fakeR2();
    published = (date) => date <= daysAgo(1);
    nsidc = fakeNsidc((hemisphere, date) => (published(date) ? (hemisphere === 'north' ? NORTH : SOUTH) : null));
    globalThis.fetch = nsidc;
    ENV = { SEA_ICE_BASE_URL: CONFIG.seaIce.baseUrl, TEXTURES: r2 };
});

async function call(path, { env = ENV, method = 'GET', headers = {} } = {}) {
    const pending = [];
    const response = await worker.fetch(new Request(`https://clouds.test${path}`, { method, headers }), env,
        { waitUntil: (p) => pending.push(p) });
    const body = new Uint8Array(await response.arrayBuffer().catch(() => new ArrayBuffer(0)));
    await Promise.all(pending);
    return { response, body };
}

const errorOf = (body) => JSON.parse(new TextDecoder().decode(body));

/* ------------------------------------------------------------------------------ grid */

test('URLs follow the NSIDC layout', () => {
    assert.equal(seaIceUrl(CONFIG, 'north', '2026-10-17'),
        'https://nsidc.test/NOAA/G02135/north/daily/geotiff/2026/10_Oct/N_20261017_concentration_v4.0.tif');
    assert.equal(seaIceUrl(CONFIG, 'south', '1979-01-02'),
        'https://nsidc.test/NOAA/G02135/south/daily/geotiff/1979/01_Jan/S_19790102_concentration_v4.0.tif');
});

test('only concentrations are kept; holes, coast and some land are filled from their neighbours', async () => {
    // 40x40 cells of 80% ice, with a 3x3 pole hole, a 20x20 island ringed by coastline cells,
    // a missing cell, a cell under 15% and one at exactly 15%
    const width = 40;
    const values = Array.from({ length: width * width }, (_, i) => {
        const x = i % width, y = Math.floor(i / width);
        if (x >= 2 && x <= 4 && y >= 2 && y <= 4) return 2510;
        if (x >= 10 && x <= 29 && y >= 10 && y <= 29) return x === 10 || x === 29 || y === 10 || y === 29 ? 2530 : 2540;
        if (x === 35 && y === 5) return 2550;
        if (x === 35 && y === 35) return 140;
        if (x === 37 && y === 37) return 150;
        if (x === 0 && y === 39) return 2520; // not a documented value: treated as land
        return 800;
    });
    const tiff = await readGeoTiff(makeTiff({
        width, height: width, values, compression: 'lzw',
        tiepoint: [0, 0, 0, -500000, 500000, 0], scale: [25000, 25000, 0], geoKeys: [[3072, 3411]]
    }));
    const grid = prepareGrid(tiff, 'north');
    const at = (x, y) => grid.values[y * width + x];

    assert.ok(Math.abs(at(3, 3) - 0.8) < 1e-6, 'pole hole filled');
    assert.ok(Math.abs(at(35, 5) - 0.8) < 1e-6, 'missing cell filled');
    assert.ok(Math.abs(at(10, 20) - 0.8) < 1e-6, 'coast filled');
    assert.equal(at(35, 35), 0, 'under 15% is open water');
    assert.ok(Math.abs(at(37, 37) - 0.15) < 1e-6);
    // land is filled LAND_FILL_CELLS deep from the coastline cells, and no further
    assert.equal(LAND_FILL_CELLS, 2);
    assert.ok(Math.abs(at(12, 20) - 0.8) < 1e-6);
    assert.ok(Number.isNaN(at(13, 20)));
    assert.ok(Number.isNaN(at(20, 20)));
    assert.deepEqual(
        { poleHole: grid.stats.poleHole, coast: grid.stats.coast, land: grid.stats.land, missing: grid.stats.missing, unknown: grid.stats.unknown },
        { poleHole: 9, coast: 76, land: 324, missing: 1, unknown: 1 });
});

test('a grid in the wrong hemisphere or without georeferencing is refused', async () => {
    const values = new Array(16).fill(0);
    const south = await readGeoTiff(makeTiff({ width: 4, height: 4, values, tiepoint: [0, 0, 0, 0, 0, 0], scale: [25000, 25000, 0], geoKeys: [[3072, 3412]] }));
    assert.throws(() => prepareGrid(south, 'north'), /south polar projection/);
    const bare = await readGeoTiff(makeTiff({ width: 4, height: 4, values }));
    assert.throws(() => prepareGrid(bare, 'north'), /no georeferencing/);
});

test('ice lands at its own latitude and longitude on the texture', async () => {
    const grids = {
        north: prepareGrid(await readGeoTiff(NORTH), 'north'),
        south: prepareGrid(await readGeoTiff(SOUTH), 'south')
    };
    const made = await createSeaIceTexture({ grids, outputRes: '2k' });
    const png = new Uint8Array(await new Response(made.stream).arrayBuffer());
    await made.done;
    const reader = await decodePng(png);
    assert.deepEqual([reader.width, reader.height, reader.colorType], [2048, 1024, 0]); // greyscale
    const image = await readRgba(png, decodePng);

    assert.equal(pixelAt(image, -150, 80), 255);
    assert.equal(pixelAt(image, 30, 80), 0);       // the other side of the pole
    assert.equal(pixelAt(image, -150, -80), 0);    // the other hemisphere
    assert.equal(pixelAt(image, 60, -65), 153);    // 60%
    assert.equal(pixelAt(image, -120, -65), 0);
    assert.equal(pixelAt(image, 0, 89.95), 0);     // the pole hole is filled from open water around it
    assert.equal(pixelAt(image, 10, 0), 0);        // outside both grids
    assert.equal(made.sourceSize, 'N 304x448, S 316x332');
});

/* ---------------------------------------------------------------------- availability */

test('the newest date with both files is found, up to a week back', async () => {
    published = (date) => date <= '2026-10-15' && date !== '2026-10-14';
    let result = await resolveSeaIceDate(CONFIG, '2026-10-17');
    assert.deepEqual(result, { date: '2026-10-15', fallback: true, checked: true });

    // every other day, and one hemisphere missing on a day
    nsidc.requests.length = 0;
    published = (date) => date === '1980-01-01';
    result = await resolveSeaIceDate(CONFIG, '1980-01-02');
    assert.equal(result.date, '1980-01-01');
    assert.ok(nsidc.requests.every(([method]) => method === 'HEAD'));

    published = () => false;
    result = await resolveSeaIceDate(CONFIG, '1988-01-01');
    assert.equal(result.date, null);
    // nothing before the start of the record is asked for
    result = await resolveSeaIceDate(CONFIG, '1978-10-27');
    assert.equal(result.date, null);
    assert.ok(nsidc.requests.every(([, url]) => !/1978102[0-5]/.test(url)));
});

test('servers that refuse HEAD are asked with a one-byte GET', async () => {
    const seen = [];
    const fetchImpl = async (url, init) => {
        seen.push(init.method);
        if (init.method === 'HEAD') return new Response(null, { status: 405 });
        return url.endsWith('yes.tif') ? new Response('I', { status: 206 }) : new Response('no', { status: 404 });
    };
    assert.equal(await fileExists('https://nsidc.test/yes.tif', { fetchImpl }), true);
    assert.equal(await fileExists('https://nsidc.test/no.tif', { fetchImpl }), false);
    assert.deepEqual(seen, ['HEAD', 'GET', 'HEAD', 'GET']);
});

/* --------------------------------------------------------------------------- endpoint */

test('makes a sea ice texture once, stores it in R2, then serves it from there', async () => {
    const date = daysAgo(10);
    const first = await call(`/sea-ice-texture?date=${date}&outputRes=1k`);
    assert.equal(first.response.status, 200);
    const h = first.response.headers;
    assert.equal(h.get('content-type'), 'image/png');
    assert.equal(h.get('x-cache'), 'MISS');
    assert.equal(h.get('cache-control'), 'public, max-age=2592000');
    assert.equal(h.get('x-source-date'), date);
    assert.equal(h.get('x-texture-size'), '1024x512');
    assert.equal(h.get('x-texture-product'), 'concentration');
    assert.equal(h.get('x-source-size'), 'N 304x448, S 316x332');
    assert.match(h.get('x-source-layer'), /G02135 v4\.0/);
    assert.equal(h.get('access-control-allow-origin'), '*');
    const image = await readRgba(first.body, decodePng);
    assert.equal(pixelAt(image, -150, 80), 255);
    assert.deepEqual([...r2.objects.keys()], [`${SEA_ICE_NAMESPACE}v${SEA_ICE_STORE_VERSION}/G02135_v4.0/concentration/1k/${date}.png`]);
    assert.equal(nsidc.gets().length, 2);

    // a timestamp and other spellings map to the same stored texture, with no NSIDC requests
    nsidc.requests.length = 0;
    const second = await call(`/sea-ice-texture?outputRes=1K&date=${date}T12:00:00Z&product=Concentration`);
    assert.equal(second.response.headers.get('x-cache'), 'HIT');
    assert.deepEqual(second.body, first.body);
    assert.equal(second.response.headers.get('x-texture-size'), '1024x512');
    assert.equal(nsidc.requests.length, 0);
});

test('the default size is 4k', async () => {
    const { response } = await call(`/sea-ice-texture?date=${daysAgo(10)}`);
    assert.equal(response.headers.get('x-texture-size'), '4096x2048');
});

test('a date NSIDC has not published yet falls back to the most recent R2 texture', async () => {
    published = (date) => date <= daysAgo(3);

    // nothing in R2 yet → 404
    const noCache = await call(`/sea-ice-texture?date=${daysAgo(1)}&outputRes=1k`);
    assert.equal(noCache.response.status, 404);

    // prime R2 with a texture for the most recently published date
    const primed = await call(`/sea-ice-texture?date=${daysAgo(3)}&outputRes=1k`);
    assert.equal(primed.response.headers.get('x-cache'), 'MISS');
    clearSeaIceMemo();

    // a newer date NSIDC hasn't published yet is served from R2
    const { response } = await call(`/sea-ice-texture?date=${daysAgo(1)}&outputRes=1k`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-requested-date'), daysAgo(1));
    assert.equal(response.headers.get('x-source-date'), daysAgo(3));
    assert.equal(response.headers.get('x-cache'), 'R2-FALLBACK');
    assert.equal(response.headers.get('cache-control'), 'public, max-age=900');

    // once it is published, it is made and served fresh from NSIDC
    clearSeaIceMemo();
    published = (date) => date <= daysAgo(1);
    const later = await call(`/sea-ice-texture?date=${daysAgo(1)}&outputRes=1k`);
    assert.equal(later.response.headers.get('x-source-date'), daysAgo(1));
    assert.equal(later.response.headers.get('x-cache'), 'MISS');
    assert.equal(later.response.headers.get('cache-control'), 'public, max-age=3600');
});

test('no NSIDC data for the exact date and no R2 cache returns 404', async () => {
    published = () => false;
    const gap = await call('/sea-ice-texture?date=1988-01-01&outputRes=1k');
    assert.equal(gap.response.status, 404);
    assert.match(errorOf(gap.body).error, /No sea ice data available for 1988-01-01/);
});

test('rejects bad parameters with JSON errors', async () => {
    const cases = [
        ['/sea-ice-texture', 400, /Missing required parameter "date"/],
        ['/sea-ice-texture?date=2026-13-01', 400, /expected YYYY-MM-DD|does not exist/],
        ['/sea-ice-texture?date=1978-10-25', 404, /starts on 1978-10-26/],
        [`/sea-ice-texture?date=${daysAgo(-2)}`, 404, /in the future/],
        ['/sea-ice-texture?date=2026-10-01&outputRes=16k', 400, /one of 1k, 2k, 4k, 8k/],
        ['/sea-ice-texture?date=2026-10-01&product=extent', 400, /"concentration"/]
    ];
    for (const [path, status, message] of cases) {
        const { response, body } = await call(path);
        assert.equal(response.status, status, path);
        assert.match(errorOf(body).error, message, path);
    }
    assert.equal(nsidc.requests.length, 0);
    const post = await call('/sea-ice-texture?date=2026-10-01', { method: 'POST' });
    assert.equal(post.response.status, 405);
});

test('NSIDC failures become 502s and nothing is stored', async () => {
    globalThis.fetch = fakeNsidc((hemisphere, date, method) =>
        (method === 'GET' ? new Response('<html>Forbidden</html>', { status: 403 }) : NORTH));
    const forbidden = await call(`/sea-ice-texture?date=${daysAgo(10)}&outputRes=1k`);
    assert.equal(forbidden.response.status, 502);
    assert.equal(errorOf(forbidden.body).upstreamStatus, 403);
    assert.match(errorOf(forbidden.body).error, /NSIDC returned HTTP 403/);

    clearSeaIceMemo();
    globalThis.fetch = fakeNsidc(() => new TextEncoder().encode('<html>maintenance</html>'));
    const garbage = await call(`/sea-ice-texture?date=${daysAgo(10)}&outputRes=1k`);
    assert.equal(garbage.response.status, 502);
    assert.match(errorOf(garbage.body).error, /not usable: not a TIFF file/);
    assert.equal(r2.objects.size, 0);
});

test('a stored texture for a recent date is remade after the refresh interval, or served stale if NSIDC is down', async () => {
    const path = `/sea-ice-texture?date=${daysAgo(2)}&outputRes=1k`;
    await call(path);
    const [key] = r2.objects.keys();

    r2.setUploaded(key, new Date(Date.now() - 2 * HOUR));
    assert.equal((await call(path)).response.headers.get('x-cache'), 'HIT');

    r2.setUploaded(key, new Date(Date.now() - 7 * HOUR));
    const remade = await call(path);
    assert.equal(remade.response.headers.get('x-cache'), 'MISS');
    assert.ok(Date.now() - r2.objects.get(key).uploaded.getTime() < HOUR);

    r2.setUploaded(key, new Date(Date.now() - 7 * HOUR));
    globalThis.fetch = fakeNsidc(() => new Response('down', { status: 403 }));
    const original = console.error;
    console.error = () => {};
    try {
        const stale = await call(path);
        assert.equal(stale.response.status, 200);
        assert.equal(stale.response.headers.get('x-cache'), 'STALE');
        assert.equal(stale.response.headers.get('cache-control'), 'public, max-age=900');
    } finally {
        console.error = original;
    }
});

test('the root path describes the sea ice endpoint', async () => {
    const { body } = await call('/');
    const info = JSON.parse(new TextDecoder().decode(body));
    assert.equal(info.seaIce.parameters.outputRes.default, '4k');
    assert.equal(info.seaIce.parameters.date.earliest, '1978-10-26');
    assert.match(info.seaIce.endpoint, /\/sea-ice-texture$/);
});

/* ---------------------------------------------------------------------- hourly job */

async function runCron(env, now = Date.now()) {
    const logs = [];
    const original = console.log;
    console.log = (line) => logs.push(line);
    try {
        await worker.scheduled({ scheduledTime: now, cron: '7 * * * *' }, env, { waitUntil() {} });
    } finally {
        console.log = original;
    }
    return JSON.parse(logs.find((l) => l.includes('"sea_ice_prewarm"')));
}

test('the hourly job keeps recent sea ice textures ready, and prunes its own old ones', async () => {
    const env = {
        ...ENV,
        // no cloud textures in this test
        PREWARM_DAYS_BACK: 'none',
        PREWARM_RESOLUTIONS: 'none',
        SEA_ICE_PREWARM_RESOLUTIONS: '1k,2k'
    };
    published = (date) => date <= daysAgo(2);
    let summary = await runCron(env);
    // 1 and 2 days back both resolve to two days back
    assert.deepEqual(summary.dates, [daysAgo(2)]);
    assert.equal(summary.generated.length, 2);
    assert.equal(nsidc.gets().length, 2); // each GeoTIFF downloaded once for both sizes

    // the page's request is then served from R2
    nsidc.requests.length = 0;
    const page = await call(`/sea-ice-texture?date=${daysAgo(2)}&outputRes=2k`);
    assert.equal(page.response.headers.get('x-cache'), 'HIT');
    assert.equal(nsidc.requests.length, 0);

    clearSeaIceMemo();
    published = (date) => date <= daysAgo(1);
    summary = await runCron(env);
    assert.deepEqual(summary.dates.sort(), [daysAgo(2), daysAgo(1)].sort());
    assert.equal(summary.generated.length, 2);
    assert.equal(summary.fresh.length, 2);

    // past the refresh interval, plus an expired texture, one from an older store version and
    // a cloud texture, which this job must leave alone
    for (const key of r2.objects.keys()) r2.setUploaded(key, new Date(Date.now() - 7 * HOUR));
    const prefix = `${SEA_ICE_NAMESPACE}v${SEA_ICE_STORE_VERSION}/G02135_v4.0/concentration/1k/`;
    await r2.put(`${prefix}2025-01-01.png`, new Uint8Array(1));
    r2.setUploaded(`${prefix}2025-01-01.png`, new Date(Date.now() - 40 * 86_400_000));
    await r2.put(`${SEA_ICE_NAMESPACE}v0/old.png`, new Uint8Array(1));
    const cloud = `${STORE_NAMESPACE}v${STORE_VERSION}/VIIRS_NOAA20_Cloud_Optical_Thickness/1km/albedo/tm3/2k/${daysAgo(2)}.png`;
    await r2.put(cloud, new Uint8Array(1));
    clearSeaIceMemo();
    summary = await runCron(env);
    assert.equal(summary.generated.length, 4);
    assert.equal(summary.pruned, 2);
    assert.ok(r2.objects.has(cloud));
    assert.equal(r2.objects.size, 5);
});

test('the hourly job reports dates with nothing published, and NSIDC failures', async () => {
    const env = { ...ENV, PREWARM_DAYS_BACK: 'none', PREWARM_RESOLUTIONS: 'none', SEA_ICE_PREWARM_RESOLUTIONS: '1k' };
    published = () => false;
    let summary = await runCron(env);
    assert.deepEqual(summary.unavailable.sort(), [daysAgo(2), daysAgo(1)].sort());

    clearSeaIceMemo();
    globalThis.fetch = fakeNsidc((hemisphere, date, method) =>
        (method === 'GET' ? new Response('nope', { status: 403 }) : NORTH));
    const original = console.warn;
    console.warn = () => {};
    try {
        summary = await runCron(env);
    } finally {
        console.warn = original;
    }
    assert.equal(summary.failed.length, 2);
    assert.equal(r2.objects.size, 0);
});
