import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { clearAvailabilityMemo } from '../src/availability.js';
import { STORE_NAMESPACE, STORE_VERSION } from '../src/store.js';
import { fakeGibsWithColormap, fakeR2, solidTile } from './helpers.js';

const HOUR = 3_600_000;
const daysAgo = (n, now = Date.now()) => new Date(now - n * 86_400_000).toISOString().slice(0, 10);
let r2, gibs, env;

beforeEach(() => {
    clearAvailabilityMemo();
    r2 = fakeR2();
    gibs = fakeGibsWithColormap(() => solidTile(4));
    globalThis.fetch = gibs;
    env = {
        GIBS_BASE_URL: 'https://gibs.test',
        GIBS_COLORMAP_URL: 'https://gibs.test/colormaps/cot.xml',
        TEXTURES: r2,
        PREWARM_RESOLUTIONS: '1k,2k',   // small, to keep the test quick
        PREWARM_TILE_MATRIX: '0'
    };
});

async function runCron(now = Date.now()) {
    const logs = [];
    const original = console.log;
    console.log = (line) => logs.push(line);
    try {
        await worker.scheduled({ scheduledTime: now, cron: '7 * * * *' }, env, { waitUntil() {} });
    } finally {
        console.log = original;
    }
    return JSON.parse(logs.find((l) => l.includes('"prewarm"')));
}

test('makes the textures the site will ask for, for the newest published date', async () => {
    gibs.published = [['2018-02-17', daysAgo(2)]];
    const summary = await runCron();
    // 1 and 2 days back both resolve to the newest published date, two days back
    assert.deepEqual(summary.dates, [daysAgo(2)]);
    assert.equal(summary.generated.length, 2);
    const keys = [...r2.objects.keys()].sort();
    assert.deepEqual(keys, [
        `${STORE_NAMESPACE}v${STORE_VERSION}/VIIRS_NOAA20_Cloud_Optical_Thickness/1km/albedo/tm0/1k/${daysAgo(2)}.png`,
        `${STORE_NAMESPACE}v${STORE_VERSION}/VIIRS_NOAA20_Cloud_Optical_Thickness/1km/albedo/tm0/2k/${daysAgo(2)}.png`
    ]);

    // the page's request is then served straight from R2, with no GIBS tile requests
    const before = gibs.tileRequests().length;
    const response = await worker.fetch(
        new Request(`https://clouds.test/global-texture?date=${daysAgo(2)}&tileMatrix=0&outputRes=2k&product=albedo`),
        env, { waitUntil() {} });
    assert.equal(response.headers.get('x-cache'), 'HIT');
    assert.equal(gibs.tileRequests().length, before);
});

test('skips fresh textures, remakes recent ones after the refresh interval, and prunes old ones', async () => {
    gibs.published = [['2018-02-17', daysAgo(1)]];
    let summary = await runCron();
    assert.deepEqual(summary.dates.sort(), [daysAgo(2), daysAgo(1)].sort());
    assert.equal(summary.generated.length, 4);

    clearAvailabilityMemo();
    summary = await runCron(Date.now() + HOUR);
    assert.equal(summary.generated.length, 0);
    assert.equal(summary.fresh.length, 4);

    // seven hours later the textures are past the six-hour refresh interval
    for (const key of r2.objects.keys()) r2.setUploaded(key, new Date(Date.now() - 7 * HOUR));
    // plus an old texture and one from an earlier store version
    await r2.put(`${STORE_NAMESPACE}v${STORE_VERSION}/VIIRS_NOAA20_Cloud_Optical_Thickness/1km/albedo/tm0/1k/2025-01-01.png`, new Uint8Array(1));
    r2.setUploaded(`${STORE_NAMESPACE}v${STORE_VERSION}/VIIRS_NOAA20_Cloud_Optical_Thickness/1km/albedo/tm0/1k/2025-01-01.png`, new Date(Date.now() - 40 * 86_400_000));
    await r2.put(`${STORE_NAMESPACE}v2/old.png`, new Uint8Array(1));
    // and other data sharing the bucket, which must be left alone
    await r2.put('other-layer/2025-01-01.png', new Uint8Array(1));
    r2.setUploaded('other-layer/2025-01-01.png', new Date(Date.now() - 400 * 86_400_000));
    clearAvailabilityMemo();
    summary = await runCron();
    assert.equal(summary.generated.length, 4);
    assert.equal(summary.pruned, 2);
    assert.equal(r2.objects.size, 5);
    assert.ok(r2.objects.has('other-layer/2025-01-01.png'));
});

test('a texture that fails is reported, and the others are still made', async () => {
    gibs.published = [['2018-02-17', daysAgo(2)]];
    env.PREWARM_RESOLUTIONS = '1k,2k';
    let calls = 0;
    const inner = globalThis.fetch;
    globalThis.fetch = async (url) => {
        // fail every tile of the first texture (with retries, a 404 is not retried)
        if (url.includes('GetTile') && calls++ < 2) return new Response('nope', { status: 404 });
        return inner(url);
    };
    const original = console.warn;
    console.warn = () => {};
    try {
        const summary = await runCron();
        assert.equal(summary.failed.length, 1);
        assert.equal(summary.generated.length, 1);
        assert.equal(r2.objects.size, 1);
    } finally {
        console.warn = original;
    }
});

test('does nothing without an R2 binding', async () => {
    delete env.TEXTURES;
    const original = console.warn;
    let warned = '';
    console.warn = (line) => { warned = line; };
    try {
        await worker.scheduled({ scheduledTime: Date.now() }, env, { waitUntil() {} });
    } finally {
        console.warn = original;
    }
    assert.match(warned, /no TEXTURES R2 binding/);
    assert.equal(gibs.requests.length, 0);
});
