import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { decodePng } from '../src/png.js';
import { fakeCache, fakeGibs, solidTile } from './helpers.js';

const ENV = { GIBS_BASE_URL: 'https://gibs.test' };
let cache, gibs;

beforeEach(() => {
    cache = fakeCache();
    gibs = fakeGibs(() => solidTile(1));
    globalThis.caches = { default: cache };
    globalThis.fetch = gibs;
});

// Call the Worker and wait for its background work (cache writes) to finish
async function call(path, { env = ENV, method = 'GET', headers = {} } = {}) {
    const pending = [];
    const response = await worker.fetch(new Request(`https://clouds.test${path}`, { method, headers }), env,
        { waitUntil: (p) => pending.push(p) });
    const body = new Uint8Array(await response.arrayBuffer());
    await Promise.all(pending);
    return { response, body };
}

const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

test('rejects bad parameters with JSON errors', async () => {
    const cases = [
        ['/global-texture', 400, /Missing required parameter "date"/],
        ['/global-texture?date=2026-02-30', 400, /does not exist/],
        ['/global-texture?date=10/12/2026', 400, /expected YYYY-MM-DD/],
        [`/global-texture?date=${daysAgo(-3)}`, 404, /in the future/],
        ['/global-texture?date=2017-12-31', 404, /starts on 2018-02-17/],
        ['/global-texture?date=2026-10-01&tileMatrix=-1', 400, /Invalid tileMatrix/],
        ['/global-texture?date=2026-10-01&tileMatrix=6', 400, /maximum is 5/],
        ['/global-texture?date=2026-10-01&outputRes=16k', 400, /one of 1k, 2k, 4k, 8k/],
        ['/elsewhere', 404, /\/global-texture/]
    ];
    for (const [path, status, message] of cases) {
        const { response, body } = await call(path);
        assert.equal(response.status, status, path);
        assert.match(JSON.parse(new TextDecoder().decode(body)).error, message, path);
        assert.equal(response.headers.get('access-control-allow-origin'), '*');
    }
    assert.equal(gibs.requests.length, 0);
});

test('serves a texture, then the same texture from cache', async () => {
    const date = daysAgo(10);
    const first = await call(`/global-texture?date=${date}&tileMatrix=0&outputRes=1k`);
    assert.equal(first.response.status, 200);
    const h = first.response.headers;
    assert.equal(h.get('content-type'), 'image/png');
    assert.equal(h.get('x-cache'), 'MISS');
    assert.equal(h.get('cache-control'), 'public, max-age=2592000'); // older data is final
    assert.equal(h.get('access-control-allow-origin'), '*');
    assert.equal(h.get('cross-origin-resource-policy'), 'cross-origin');
    assert.equal(h.get('x-texture-size'), '1024x512');
    assert.equal(h.get('x-source-size'), '640x320');
    const reader = await decodePng(first.body);
    assert.deepEqual([reader.width, reader.height], [1024, 512]);

    // a timestamp, other parameter order and case all map to the same cached texture
    const second = await call(`/global-texture?outputRes=1K&tileMatrix=0&date=${date}T00:00:00Z`);
    assert.equal(second.response.headers.get('x-cache'), 'HIT');
    assert.deepEqual(second.body, first.body);
    assert.equal(gibs.requests.length, 2);
});

test('recent dates are cached for an hour; the default is level 3 at 8k', async () => {
    const { response } = await call(`/global-texture?date=${daysAgo(2)}`);
    assert.equal(response.headers.get('cache-control'), 'public, max-age=3600');
    assert.equal(response.headers.get('x-texture-size'), '8192x4096');
    assert.equal(response.headers.get('x-source-tile-matrix'), '3');
    assert.equal(gibs.requests.length, 50);
});

test('a cached texture without its completion marker is rebuilt, not served', async () => {
    const path = `/global-texture?date=${daysAgo(10)}&tileMatrix=0&outputRes=1k`;
    await call(path);
    for (const key of cache.store.keys()) if (key.endsWith('&complete=1')) cache.store.delete(key);
    const again = await call(path);
    assert.equal(again.response.headers.get('x-cache'), 'MISS');
    assert.equal(gibs.requests.length, 4);
});

test('levels above 3 are not cached by the browser on the first, streamed response', async () => {
    const path = `/global-texture?date=${daysAgo(10)}&tileMatrix=4&outputRes=1k`;
    const first = await call(path);
    assert.equal(first.response.headers.get('cache-control'), 'no-store');
    const second = await call(path);
    assert.equal(second.response.headers.get('x-cache'), 'HIT');
    assert.equal(second.response.headers.get('cache-control'), 'public, max-age=2592000');
});

test('GIBS failures become 502s and are not cached', async () => {
    globalThis.fetch = fakeGibs(() => new Response('<ExceptionText>Invalid TIME</ExceptionText>', { status: 400 }));
    const { response, body } = await call(`/global-texture?date=${daysAgo(10)}&tileMatrix=0&outputRes=1k`);
    assert.equal(response.status, 502);
    const json = JSON.parse(new TextDecoder().decode(body));
    assert.equal(json.upstreamStatus, 400);
    assert.match(json.detail, /Invalid TIME/);
    assert.equal(cache.store.size, 0);
});

test('CORS: a list of origins is honoured, and preflight works', async () => {
    const env = { ...ENV, ALLOWED_ORIGINS: 'https://jackiepi.xyz, http://localhost:5173' };
    const path = `/global-texture?date=${daysAgo(10)}&tileMatrix=0&outputRes=1k`;
    const allowed = await call(path, { env, headers: { Origin: 'http://localhost:5173' } });
    assert.equal(allowed.response.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    assert.match(allowed.response.headers.get('vary'), /Origin/);
    const other = await call(path, { env, headers: { Origin: 'https://elsewhere.test' } });
    assert.equal(other.response.headers.get('access-control-allow-origin'), null);

    const preflight = await call('/global-texture', { method: 'OPTIONS' });
    assert.equal(preflight.response.status, 204);
    assert.match(preflight.response.headers.get('access-control-allow-methods'), /GET/);
    const post = await call('/global-texture', { method: 'POST' });
    assert.equal(post.response.status, 405);
});

test('the root path describes the API', async () => {
    const { response, body } = await call('/');
    const info = JSON.parse(new TextDecoder().decode(body));
    assert.equal(response.status, 200);
    assert.equal(info.parameters.tileMatrix.default, 3);
    assert.equal(info.parameters.outputRes.values['8k'], '8192x4096');
});

test('product=albedo is cached separately and labelled', async () => {
    globalThis.fetch = (await import('./helpers.js')).fakeGibsWithColormap(() => solidTile(4));
    const path = `/global-texture?date=${daysAgo(10)}&tileMatrix=0&outputRes=1k`;
    const colormap = await call(path);
    const albedo = await call(`${path}&product=albedo`);
    assert.equal(colormap.response.headers.get('x-texture-product'), 'colormap');
    assert.equal(albedo.response.headers.get('x-texture-product'), 'albedo');
    assert.equal(albedo.response.headers.get('x-cache'), 'MISS');
    assert.notDeepEqual(albedo.body, colormap.body);
    const again = await call(`${path}&product=Albedo`);
    assert.equal(again.response.headers.get('x-cache'), 'HIT');
    const bad = await call(`${path}&product=truecolor`);
    assert.equal(bad.response.status, 400);
});
