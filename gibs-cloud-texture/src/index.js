/* gibs-cloud-texture - Cloudflare Worker that stitches a full TileMatrix level of a NASA GIBS
 * WMTS layer (by default NOAA-20 VIIRS Cloud Optical Thickness) into one equirectangular
 * PNG texture for three.js.
 *
 *   GET /global-texture?date=2026-10-12&tileMatrix=3&outputRes=8k
 *
 * date        required  YYYY-MM-DD; a full timestamp such as 2026-10-12T00:00:00Z is
 *                       accepted and its time of day ignored (the layer is daily)
 * tileMatrix  optional  GIBS TileMatrix (zoom level) to read, default 3
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
 */
import { resolveDate } from './availability.js';
import { maxAgeFor, todayUtc } from './dates.js';
import { TILE_MATRIX_SET_MAX_LEVEL, UpstreamError, tileGrid } from './gibs.js';
import { prewarm } from './prewarm.js';
import { storeStream, textureKey, textureMetadata } from './store.js';
import { OUTPUT_SIZES, PRODUCTS, createTexture } from './texture.js';

const TEXTURE_PATH = '/global-texture';
const DEFAULT_TILE_MATRIX = 3;
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
            tileMatrix: Number.parseInt(env.PREWARM_TILE_MATRIX ?? '3', 10),
            refreshHours: Number(env.PREWARM_REFRESH_HOURS ?? 6),
            retainDays: Number(env.STORE_RETAIN_DAYS ?? 30)
        }
    };
}

function listOf(value, fallback) {
    return (value || fallback).split(',').map((s) => s.trim()).filter(Boolean);
}

/* ---------------------------------------------------------------------------- params */

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function parseDate(value, config) {
    if (!value) throw new RequestError(400, 'Missing required parameter "date" (YYYY-MM-DD)');
    const match = DATE_PATTERN.exec(value.trim());
    if (!match) throw new RequestError(400, `Invalid date "${value}"; expected YYYY-MM-DD`);
    const [, y, m, d] = match.map(Number);
    const parsed = new Date(Date.UTC(y, m - 1, d));
    if (parsed.getUTCFullYear() !== y || parsed.getUTCMonth() !== m - 1 || parsed.getUTCDate() !== d) {
        throw new RequestError(400, `Invalid date "${value}"; that day does not exist`);
    }
    const date = parsed.toISOString().slice(0, 10);
    if (date < config.earliestDate) {
        throw new RequestError(404, `No data for ${date}: ${config.layer} starts on ${config.earliestDate}`);
    }
    if (date > todayUtc()) {
        throw new RequestError(404, `No data for ${date}: that date is in the future (UTC)`);
    }
    return date;
}

function parseTileMatrix(value, config) {
    if (value === null || value === '') return DEFAULT_TILE_MATRIX;
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

function parseOutputRes(value) {
    if (value === null || value === '') return DEFAULT_OUTPUT_RES;
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
    return {
        date: parseDate(searchParams.get('date'), config),
        tileMatrix: parseTileMatrix(searchParams.get('tileMatrix'), config),
        outputRes: parseOutputRes(searchParams.get('outputRes')),
        product: parseProduct(searchParams.get('product'))
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
            tileMatrix: { default: DEFAULT_TILE_MATRIX, min: 0, max: config.maxTileMatrix },
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
        example: `${origin}${TEXTURE_PATH}?date=2026-10-12&tileMatrix=3&outputRes=4k`
    };
}

/* ------------------------------------------------------------------------------ worker */

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
        if (url.pathname !== TEXTURE_PATH) {
            return json({ error: `Not found; the texture endpoint is ${TEXTURE_PATH}` }, 404, cors);
        }
        if (request.method !== 'GET') {
            return withHeaders(json({ error: 'Method not allowed' }, 405, cors), { Allow: 'GET, OPTIONS' });
        }

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
        const log = { date, requestedDate, tileMatrix, outputRes, product };
        let body = made.stream;
        let storing = Promise.resolve();
        if (bucket) {
            const [toClient, toStore] = made.stream.tee();
            body = toClient;
            storing = storeStream(bucket, key, toStore, textureMetadata(texture, made)).then(
                () => console.log(JSON.stringify({ event: 'stored', key })),
                (error) => console.warn(JSON.stringify({ event: 'store_failed', key, message: error.message }))
            );
        }
        ctx.waitUntil(Promise.all([
            made.done.then(
                (stats) => console.log(JSON.stringify({ event: 'texture', ...log, ...stats })),
                (error) => console.error(JSON.stringify({ event: 'texture_failed', ...log, message: error.message, detail: error.detail }))
            ),
            storing
        ]));

        const responseHeaders = {
            ...headers(`${made.grid.width}x${made.grid.height}`, `${made.width}x${made.height}`),
            'X-Cache': 'MISS'
        };
        // A browser can't tell a cut-short PNG from a whole one, so a response that could still
        // fail is not stored by the browser. Later requests are served from R2.
        if (!made.complete) responseHeaders['Cache-Control'] = 'no-store';
        return new Response(body, { headers: responseHeaders });
    },

    // Cron Trigger: keep the textures the site asks for ready in R2 (prewarm.js)
    async scheduled(controller, env, ctx) {
        const config = readConfig(env);
        if (!env.TEXTURES) {
            console.warn(JSON.stringify({ event: 'prewarm_skipped', reason: 'no TEXTURES R2 binding' }));
            return;
        }
        const summary = await prewarm({ config, bucket: env.TEXTURES, now: controller.scheduledTime });
        console.log(JSON.stringify({ event: 'prewarm', ...summary }));
        if (summary.failed.length) {
            console.warn(JSON.stringify({ event: 'prewarm_failures', failed: summary.failed }));
        }
    }
};
