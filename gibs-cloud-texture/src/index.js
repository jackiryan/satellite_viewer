/* gibs-cloud-texture - Cloudflare Worker that makes equirectangular PNG textures for three.js:
 * clouds, by stitching a full TileMatrix level of a NASA GIBS WMTS layer (by default NOAA-20
 * VIIRS Cloud Optical Thickness), and sea ice concentration, by reprojecting the NSIDC Sea Ice
 * Index polar grids (seaice.js, described at the end of this comment).
 *
 *   GET /global-texture?date=2026-10-12&tileMatrix=4&outputRes=8k
 *
 * date        required  YYYY-MM-DD; a full timestamp such as 2026-10-12T00:00:00Z is
 *                       accepted and its time of day ignored (the layer is daily)
 * tileMatrix  optional  GIBS TileMatrix (zoom level) to read; by default 4 for 8k, 3 otherwise
 * outputRes   optional  1k | 2k | 4k | 8k -> 1024x512 ... 8192x4096, default 8k
 * product     optional  colormap (default) | albedo
 *
 * The texture is a 2:1 equirectangular PNG: west edge at 180 W, north at the top.
 *   colormap  RGBA with the exact GIBS colormap colors, transparent where there is no data
 *   albedo    greyscale cloud reflectance (0 = clear) stored as sqrt(reflectance) * 255,
 *             worked out from the optical thickness each color stands for (albedo.js)
 *
 * Finished textures are kept in R2 (binding TEXTURES, see store.js) and served from there.
 * For recent dates, the newest date GIBS has published at or before the one asked for is
 * served (availability.js); X-Source-Date says which. A Cron Trigger keeps the textures the
 * site asks for ready ahead of time (prewarm.js).
 *
 *   GET /sea-ice-texture?date=2026-10-17&outputRes=4k
 *
 * date        required  YYYY-MM-DD (or a timestamp, as above), from 1978-10-26
 * outputRes   optional  1k | 2k | 4k | 8k, default 4k (the grids are 25 km, so 4k already has
 *                       more than two texels per grid cell)
 * product     optional  concentration (the only one)
 *
 * A greyscale PNG of the Arctic and Antarctic sea ice concentration from the daily G02135
 * GeoTIFFs, round(concentration * 255), 0 for open water, land and no data. The newest date
 * NSIDC has published at or before the one asked for (at most 7 days before) is served, and
 * stored in R2 under sea-ice-texture/ like the cloud textures.
 */
import { resolveDate } from './availability.js';
import { isRecent, maxAgeFor, todayUtc } from './dates.js';
import { TILE_MATRIX_SET_MAX_LEVEL, UpstreamError, tileGrid } from './gibs.js';
import { prewarm, prewarmSeaIce } from './prewarm.js';
import { LOOKBACK_DAYS, SEA_ICE_PRODUCT, createSeaIceTexture, resolveSeaIceDate } from './seaice.js';
import { seaIceKey, seaIceMetadata, storeStream, textureKey, textureMetadata } from './store.js';
import { OUTPUT_SIZES, PRODUCTS, createTexture } from './texture.js';

const TEXTURE_PATH = '/global-texture';
const SEA_ICE_PATH = '/sea-ice-texture';
// The sea ice grids are 25 km, so a 4k texture (~10 km per texel north-south) already shows all
// of their detail; 8k only interpolates further.
const DEFAULT_SEA_ICE_OUTPUT_RES = '4k';
// TileMatrix used when a request doesn't name one, by outputRes: the lowest level with at least
// as many pixels as the texture, so it is made by shrinking the tiles rather than enlarging them.
// Level 3 is 5120x2560 and level 4 10240x5120 (4x the tiles: 200 rather than 50).
export const DEFAULT_TILE_MATRIX = { '1k': 3, '2k': 3, '4k': 3, '8k': 4 };
const DEFAULT_OUTPUT_RES = '8k';
const DEFAULT_PRODUCT = 'colormap';
// Cache lifetime of a texture for an older date than the one asked for (because the asked-for
// date wasn't published yet), so caches pick up the right one soon after it is published
const FALLBACK_MAX_AGE = 15 * 60;

const EXPOSED_HEADERS = ['X-Cache', 'X-Requested-Date', 'X-Source-Layer', 'X-Source-Date', 'X-Source-Tile-Matrix',
    'X-Source-Size', 'X-Texture-Size', 'X-Texture-Product'];

class RequestError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

// PREWARM_TILE_MATRIX: a level for every resolution ("3"), or levels by resolution
// ("2k:3,4k:3,8k:4"); resolutions it leaves out use DEFAULT_TILE_MATRIX
export function tileMatrixByResolution(value) {
    const levels = { ...DEFAULT_TILE_MATRIX };
    for (const entry of listOf(value, '')) {
        const [res, level] = entry.includes(':') ? entry.split(':').map((s) => s.trim().toLowerCase()) : [null, entry];
        if (!/^\d+$/.test(level) || (res !== null && !(res in OUTPUT_SIZES))) continue;
        if (res === null) {
            for (const key of Object.keys(levels)) levels[key] = Number(level);
        } else {
            levels[res] = Number(level);
        }
    }
    return levels;
}

function readConfig(env) {
    const tileMatrixSet = env.GIBS_TILE_MATRIX_SET || '1km';
    const configuredMax = Number.parseInt(env.MAX_TILE_MATRIX ?? '5', 10);
    return {
        gibsBaseUrl: (env.GIBS_BASE_URL || 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best').replace(/\/+$/, ''),
        layer: env.GIBS_LAYER || 'VIIRS_NOAA20_Cloud_Optical_Thickness',
        tileMatrixSet,
        earliestDate: env.GIBS_EARLIEST_DATE || '2018-02-17',
        colormapUrl: env.GIBS_COLORMAP_URL || 'https://gibs.earthdata.nasa.gov/colormaps/v1.3/MODIS_VIIRS_Cloud_Optical_Thickness.xml',
        maxTileMatrix: Math.min(
            Number.isFinite(configuredMax) ? configuredMax : 5,
            TILE_MATRIX_SET_MAX_LEVEL[tileMatrixSet] ?? Infinity
        ),
        allowedOrigins: (env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean),
        prewarm: {
            daysBack: listOf(env.PREWARM_DAYS_BACK, '1,2').map(Number).filter(Number.isFinite),
            resolutions: listOf(env.PREWARM_RESOLUTIONS, '2k,4k,8k').filter((r) => r in OUTPUT_SIZES),
            product: PRODUCTS.includes(env.PREWARM_PRODUCT) ? env.PREWARM_PRODUCT : 'albedo',
            tileMatrix: tileMatrixByResolution(env.PREWARM_TILE_MATRIX),   // by outputRes
            refreshHours: Number(env.PREWARM_REFRESH_HOURS ?? 6),
            retainDays: Number(env.STORE_RETAIN_DAYS ?? 30)
        },
        seaIce: {
            baseUrl: (env.SEA_ICE_BASE_URL || 'https://noaadata.apps.nsidc.org/NOAA/G02135').replace(/\/+$/, ''),
            fileVersion: env.SEA_ICE_FILE_VERSION || '4.0',
            earliestDate: env.SEA_ICE_EARLIEST_DATE || '1978-10-26',
            // "none" (or an empty value) turns the hourly sea ice job off
            prewarm: {
                daysBack: listOf(env.SEA_ICE_PREWARM_DAYS_BACK, '1,2', true).map(Number).filter(Number.isFinite),
                resolutions: listOf(env.SEA_ICE_PREWARM_RESOLUTIONS, '2k,4k', true).filter((r) => r in OUTPUT_SIZES)
            }
        }
    };
}

function listOf(value, fallback, allowNone = false) {
    if (allowNone && value !== undefined && /^\s*(none)?\s*$/i.test(value)) return [];
    return (value || fallback).split(',').map((s) => s.trim()).filter(Boolean);
}

/* ---------------------------------------------------------------------------- params */

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function parseDate(value, earliestDate, sourceName) {
    if (!value) throw new RequestError(400, 'Missing required parameter "date" (YYYY-MM-DD)');
    const match = DATE_PATTERN.exec(value.trim());
    if (!match) throw new RequestError(400, `Invalid date "${value}"; expected YYYY-MM-DD`);
    const [, y, m, d] = match.map(Number);
    const parsed = new Date(Date.UTC(y, m - 1, d));
    if (parsed.getUTCFullYear() !== y || parsed.getUTCMonth() !== m - 1 || parsed.getUTCDate() !== d) {
        throw new RequestError(400, `Invalid date "${value}"; that day does not exist`);
    }
    const date = parsed.toISOString().slice(0, 10);
    if (date < earliestDate) {
        throw new RequestError(404, `No data for ${date}: ${sourceName} starts on ${earliestDate}`);
    }
    if (date > todayUtc()) {
        throw new RequestError(404, `No data for ${date}: that date is in the future (UTC)`);
    }
    return date;
}

function defaultTileMatrix(outputRes, config) {
    return Math.min(DEFAULT_TILE_MATRIX[outputRes], config.maxTileMatrix);
}

function parseTileMatrix(value, config, outputRes) {
    if (value === null || value === '') return defaultTileMatrix(outputRes, config);
    if (!/^\d+$/.test(value.trim())) {
        throw new RequestError(400, `Invalid tileMatrix "${value}"; expected an integer from 0 to ${config.maxTileMatrix}`);
    }
    const level = Number(value);
    if (level > config.maxTileMatrix) {
        throw new RequestError(400, `tileMatrix ${level} is not allowed; the maximum is ${config.maxTileMatrix}` +
            ` (level ${level} is ${tileGrid(level).cols * tileGrid(level).rows} tiles)`);
    }
    return level;
}

function parseOutputRes(value, fallback = DEFAULT_OUTPUT_RES) {
    if (value === null || value === '') return fallback;
    const res = value.trim().toLowerCase();
    if (!(res in OUTPUT_SIZES)) {
        throw new RequestError(400, `Invalid outputRes "${value}"; expected one of ${Object.keys(OUTPUT_SIZES).join(', ')}`);
    }
    return res;
}

function parseProduct(value) {
    if (value === null || value === '') return DEFAULT_PRODUCT;
    const product = value.trim().toLowerCase();
    if (!PRODUCTS.includes(product)) {
        throw new RequestError(400, `Invalid product "${value}"; expected one of ${PRODUCTS.join(', ')}`);
    }
    return product;
}

function parseParams(searchParams, config) {
    const date = parseDate(searchParams.get('date'), config.earliestDate, config.layer);
    const outputRes = parseOutputRes(searchParams.get('outputRes'));
    return {
        date,
        tileMatrix: parseTileMatrix(searchParams.get('tileMatrix'), config, outputRes),
        outputRes,
        product: parseProduct(searchParams.get('product'))
    };
}

function parseSeaIceParams(searchParams, config) {
    const product = searchParams.get('product');
    if (product !== null && product !== '' && product.trim().toLowerCase() !== SEA_ICE_PRODUCT) {
        throw new RequestError(400, `Invalid product "${product}"; the sea ice texture is "${SEA_ICE_PRODUCT}"`);
    }
    return {
        date: parseDate(searchParams.get('date'), config.seaIce.earliestDate, 'The Sea Ice Index'),
        outputRes: parseOutputRes(searchParams.get('outputRes'), DEFAULT_SEA_ICE_OUTPUT_RES)
    };
}

/* --------------------------------------------------------------------------- responses */

function corsHeaders(request, config) {
    const headers = {
        'Access-Control-Expose-Headers': EXPOSED_HEADERS.join(', '),
        // lets pages served with Cross-Origin-Embedder-Policy: require-corp use the texture
        'Cross-Origin-Resource-Policy': 'cross-origin'
    };
    if (config.allowedOrigins.includes('*')) {
        headers['Access-Control-Allow-Origin'] = '*';
    } else {
        headers.Vary = 'Origin';
        const origin = request.headers.get('Origin');
        if (origin && config.allowedOrigins.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
    }
    return headers;
}

function withHeaders(response, extra) {
    const out = new Response(response.body, response);
    for (const [name, value] of Object.entries(extra)) {
        if (name === 'Vary') out.headers.append(name, value);
        else out.headers.set(name, value);
    }
    return out;
}

function json(body, status, cors) {
    return new Response(JSON.stringify(body, null, 2), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors }
    });
}

function apiDescription(origin, config) {
    return {
        name: 'gibs-cloud-texture',
        description: 'Stitches every tile of one GIBS WMTS TileMatrix level into a single 2:1 equirectangular RGBA PNG.',
        source: { layer: config.layer, tileMatrixSet: config.tileMatrixSet, service: config.gibsBaseUrl },
        endpoint: `${origin}${TEXTURE_PATH}`,
        parameters: {
            date: {
                required: true,
                format: 'YYYY-MM-DD (a time of day is accepted and ignored)',
                earliest: config.earliestDate,
                note: 'for recent dates, the newest date GIBS has published at or before it is served (X-Source-Date)'
            },
            tileMatrix: {
                default: Object.fromEntries(Object.keys(OUTPUT_SIZES).map((res) => [res, defaultTileMatrix(res, config)])),
                note: 'the default depends on outputRes',
                min: 0,
                max: config.maxTileMatrix
            },
            outputRes: {
                default: DEFAULT_OUTPUT_RES,
                values: Object.fromEntries(Object.entries(OUTPUT_SIZES).map(([k, [w, h]]) => [k, `${w}x${h}`]))
            },
            product: {
                default: DEFAULT_PRODUCT,
                values: {
                    colormap: 'RGBA PNG with the GIBS colormap colors',
                    albedo: 'greyscale PNG of cloud reflectance, stored as sqrt(reflectance) * 255'
                }
            }
        },
        example: `${origin}${TEXTURE_PATH}?date=2026-10-12&tileMatrix=3&outputRes=4k`,
        seaIce: {
            description: 'Arctic and Antarctic sea ice concentration from the NSIDC Sea Ice Index (G02135), ' +
                'reprojected into one 2:1 equirectangular greyscale PNG: round(concentration * 255), ' +
                '0 for open water, land and no data.',
            source: { dataset: `G02135 v${config.seaIce.fileVersion} daily concentration GeoTIFFs`, service: config.seaIce.baseUrl },
            endpoint: `${origin}${SEA_ICE_PATH}`,
            parameters: {
                date: {
                    required: true,
                    format: 'YYYY-MM-DD (a time of day is accepted and ignored)',
                    earliest: config.seaIce.earliestDate,
                    note: `the newest date NSIDC has published at or before it (at most ${LOOKBACK_DAYS} days earlier) is served (X-Source-Date)`
                },
                outputRes: {
                    default: DEFAULT_SEA_ICE_OUTPUT_RES,
                    values: Object.fromEntries(Object.entries(OUTPUT_SIZES).map(([k, [w, h]]) => [k, `${w}x${h}`]))
                },
                product: { default: SEA_ICE_PRODUCT, values: { [SEA_ICE_PRODUCT]: 'greyscale PNG, concentration * 255' } }
            },
            example: `${origin}${SEA_ICE_PATH}?date=2026-10-17&outputRes=4k`
        }
    };
}

/** Send a texture that is being made, storing a copy in R2 once it is complete. Returns the body. */
function streamTexture(made, { bucket, key, metadata, ctx, event, log }) {
    let body = made.stream;
    let storing = Promise.resolve();
    if (bucket) {
        const [toClient, toStore] = made.stream.tee();
        body = toClient;
        storing = storeStream(bucket, key, toStore, metadata).then(
            () => console.log(JSON.stringify({ event: 'stored', key })),
            (error) => console.warn(JSON.stringify({ event: 'store_failed', key, message: error.message }))
        );
    }
    ctx.waitUntil(Promise.all([
        made.done.then(
            (stats) => console.log(JSON.stringify({ event, ...log, ...stats })),
            (error) => console.error(JSON.stringify({ event: `${event}_failed`, ...log, message: error.message, detail: error.detail }))
        ),
        storing
    ]));
    return body;
}

/* ------------------------------------------------------------------------------ clouds */

async function handleClouds({ url, env, ctx, config, cors }) {
    let params;
    try {
        params = parseParams(url.searchParams, config);
    } catch (error) {
        if (error instanceof RequestError) return json({ error: error.message }, error.status, cors);
        throw error;
    }

    const requestedDate = params.date;
    const { date, fallback } = await resolveDate(config, requestedDate);
    const { tileMatrix, outputRes, product } = params;
    const texture = { date, tileMatrix, outputRes, product };
    const key = textureKey(config, texture);
    const bucket = env.TEXTURES;
    const maxAge = fallback ? FALLBACK_MAX_AGE : maxAgeFor(date);
    const headers = (sourceSize, textureSize) => ({
        ...cors,
        'Content-Type': 'image/png',
        'Cache-Control': `public, max-age=${maxAge}`,
        'Content-Disposition': `inline; filename="clouds_${date}_tm${tileMatrix}_${outputRes}_${product}.png"`,
        'X-Requested-Date': requestedDate,
        'X-Source-Layer': `${config.layer} (${config.tileMatrixSet})`,
        'X-Source-Date': date,
        'X-Source-Tile-Matrix': String(tileMatrix),
        'X-Source-Size': sourceSize,
        'X-Texture-Size': textureSize,
        'X-Texture-Product': product
    });

    const stored = bucket ? await bucket.get(key) : null;
    if (stored) {
        const meta = stored.customMetadata ?? {};
        return new Response(stored.body, {
            headers: {
                ...headers(meta.sourceSize, meta.textureSize),
                'Content-Length': String(stored.size),
                ETag: stored.httpEtag,
                'X-Cache': 'HIT'
            }
        });
    }

    let made;
    try {
        made = await createTexture({ ...texture, config, cacheTtl: maxAgeFor(date) });
    } catch (error) {
        if (error instanceof UpstreamError) {
            console.error(JSON.stringify({ event: 'upstream_error', date, tileMatrix, message: error.message, detail: error.detail }));
            return json({ error: error.message, upstreamStatus: error.upstreamStatus, detail: error.detail }, error.status, cors);
        }
        throw error;
    }

    // The PNG streams from here on. If it still fails (only possible above level 3, where
    // tiles are fetched as the texture is written) the body is cut short, and nothing is
    // stored: the R2 upload only completes once the whole texture has been written.
    const body = streamTexture(made, {
        bucket, key, metadata: textureMetadata(texture, made), ctx,
        event: 'texture', log: { date, requestedDate, tileMatrix, outputRes, product }
    });

    const responseHeaders = {
        ...headers(`${made.grid.width}x${made.grid.height}`, `${made.width}x${made.height}`),
        'X-Cache': 'MISS'
    };
    // A browser can't tell a cut-short PNG from a whole one, so a response that could still
    // fail is not stored by the browser. Later requests are served from R2.
    if (!made.complete) responseHeaders['Cache-Control'] = 'no-store';
    return new Response(body, { headers: responseHeaders });
}

/* ----------------------------------------------------------------------------- sea ice */

// Whether a stored sea ice texture is still current: NSIDC recomputes a day's grids the next
// day, so textures for recent dates are remade once they are refreshHours old. Older dates are
// final. Returns null if nothing is stored, otherwise 'fresh' or 'stale'.
async function seaIceState(bucket, key, date, config, now = Date.now()) {
    const head = await bucket.head(key);
    if (!head) return null;
    const age = now - head.uploaded.getTime();
    return !isRecent(date, now) || age <= config.prewarm.refreshHours * 3_600_000 ? 'fresh' : 'stale';
}

async function handleSeaIce({ url, env, ctx, config, cors }) {
    let params;
    try {
        params = parseSeaIceParams(url.searchParams, config);
    } catch (error) {
        if (error instanceof RequestError) return json({ error: error.message }, error.status, cors);
        throw error;
    }
    const { date: requestedDate, outputRes } = params;
    const bucket = env.TEXTURES;
    const headers = (date, maxAge, sourceSize, textureSize) => ({
        ...cors,
        'Content-Type': 'image/png',
        'Cache-Control': `public, max-age=${maxAge}`,
        'Content-Disposition': `inline; filename="sea_ice_${date}_${outputRes}.png"`,
        'X-Requested-Date': requestedDate,
        'X-Source-Layer': `NSIDC Sea Ice Index G02135 v${config.seaIce.fileVersion} daily concentration`,
        'X-Source-Date': date,
        'X-Source-Size': sourceSize,
        'X-Texture-Size': textureSize,
        'X-Texture-Product': SEA_ICE_PRODUCT
    });
    const serveStored = async (key, date, maxAge, label) => {
        const stored = await bucket.get(key);
        if (!stored) return null;
        const meta = stored.customMetadata ?? {};
        return new Response(stored.body, {
            headers: {
                ...headers(date, maxAge, meta.sourceSize, meta.textureSize),
                'Content-Length': String(stored.size),
                ETag: stored.httpEtag,
                'X-Cache': label
            }
        });
    };

    // A texture already made for the date asked for, unless it is due to be remade. Its stale
    // copy is still served if NSIDC can't be reached.
    let stale = null;
    if (bucket) {
        const key = seaIceKey(config, { date: requestedDate, outputRes });
        const state = await seaIceState(bucket, key, requestedDate, config);
        if (state === 'fresh') {
            const response = await serveStored(key, requestedDate, maxAgeFor(requestedDate), 'HIT');
            if (response) return response;
        } else if (state === 'stale') {
            stale = { key, date: requestedDate };
        }
    }

    // Otherwise the newest date NSIDC has published at or before it
    const resolved = await resolveSeaIceDate(config, requestedDate);
    if (!resolved.date) {
        return json({ error: `No sea ice data for ${requestedDate} or the ${LOOKBACK_DAYS} days before it` }, 404, cors);
    }
    const date = resolved.date;
    // a stand-in for a recent date that isn't published yet is only kept briefly
    const maxAge = resolved.fallback && isRecent(requestedDate) ? FALLBACK_MAX_AGE : maxAgeFor(date);
    const key = seaIceKey(config, { date, outputRes });
    if (bucket && resolved.fallback) {
        const state = await seaIceState(bucket, key, date, config);
        if (state === 'fresh') {
            const response = await serveStored(key, date, maxAge, 'HIT');
            if (response) return response;
        } else if (state === 'stale') {
            stale ??= { key, date };
        }
    }

    let made;
    try {
        made = await createSeaIceTexture({ config, date, outputRes, cacheTtl: maxAgeFor(date) });
    } catch (error) {
        if (!(error instanceof UpstreamError)) throw error;
        console.error(JSON.stringify({ event: 'sea_ice_upstream_error', date, message: error.message, detail: error.detail }));
        if (stale) {
            const response = await serveStored(stale.key, stale.date, FALLBACK_MAX_AGE, 'STALE');
            if (response) return response;
        }
        return json({ error: error.message, upstreamStatus: error.upstreamStatus, detail: error.detail }, error.status, cors);
    }

    // Both GeoTIFFs are downloaded and checked by now, so the PNG can't be cut short
    const body = streamTexture(made, {
        bucket, key, metadata: seaIceMetadata({ date, outputRes }, made), ctx,
        event: 'sea_ice_texture', log: { date, requestedDate, outputRes }
    });
    return new Response(body, {
        headers: { ...headers(date, maxAge, made.sourceSize, `${made.width}x${made.height}`), 'X-Cache': 'MISS' }
    });
}

/* ------------------------------------------------------------------------------ worker */

const HANDLERS = { [TEXTURE_PATH]: handleClouds, [SEA_ICE_PATH]: handleSeaIce };

export default {
    async fetch(request, env, ctx) {
        const config = readConfig(env);
        const url = new URL(request.url);
        const cors = corsHeaders(request, config);

        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Max-Age': '86400' }
            });
        }
        if (url.pathname === '/' && request.method === 'GET') {
            return json(apiDescription(url.origin, config), 200, cors);
        }
        const handler = HANDLERS[url.pathname];
        if (!handler) {
            return json({ error: `Not found; the texture endpoints are ${TEXTURE_PATH} and ${SEA_ICE_PATH}` }, 404, cors);
        }
        if (request.method !== 'GET') {
            return withHeaders(json({ error: 'Method not allowed' }, 405, cors), { Allow: 'GET, OPTIONS' });
        }
        return handler({ request, url, env, ctx, config, cors });
    },

    // Cron Trigger: keep the textures the site asks for ready in R2 (prewarm.js). The cloud and
    // sea ice jobs run one after the other; if one throws, the other still runs, and the error
    // is rethrown at the end so the run shows as failed.
    async scheduled(controller, env, ctx) {
        const config = readConfig(env);
        if (!env.TEXTURES) {
            console.warn(JSON.stringify({ event: 'prewarm_skipped', reason: 'no TEXTURES R2 binding' }));
            return;
        }
        const jobs = [['prewarm', prewarm]];
        if (config.seaIce.prewarm.daysBack.length && config.seaIce.prewarm.resolutions.length) {
            jobs.push(['sea_ice_prewarm', prewarmSeaIce]);
        }
        let thrown = null;
        for (const [event, job] of jobs) {
            try {
                const summary = await job({ config, bucket: env.TEXTURES, now: controller.scheduledTime });
                console.log(JSON.stringify({ event, ...summary }));
                if (summary.failed.length) {
                    console.warn(JSON.stringify({ event: `${event}_failures`, failed: summary.failed }));
                }
            } catch (error) {
                console.error(JSON.stringify({ event: `${event}_error`, message: error.message }));
                thrown ??= error;
            }
        }
        if (thrown) throw thrown;
    }
};
