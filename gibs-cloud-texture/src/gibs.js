/* gibs.js - the GIBS geographic (EPSG:4326) tile grid, tile requests, and a reader that
 * presents a whole TileMatrix level as one image, read top to bottom one row at a time.
 */
import { decodePng, isPng, PngError } from './png.js';

export const TILE_SIZE = 512;

// Deepest level of each GIBS EPSG:4326 TileMatrixSet (the "1km" set ends at level 6, whose
// 0.0088 deg pixels are ~1 km at the equator).
export const TILE_MATRIX_SET_MAX_LEVEL = { '2km': 5, '1km': 6, '500m': 7, '250m': 8 };

/**
 * Geometry of one TileMatrix level. Every GIBS EPSG:4326 set starts at 0.5625 deg per pixel
 * at level 0 and halves it per level, with the top-left corner at (-180, 90). The world is
 * 640 x 320 pixels at level 0, so at levels 0-2 the last tile column and row stick out past
 * 180 E / 90 S; that part holds no data and is cropped.
 */
export function tileGrid(level) {
    const width = 640 * 2 ** level;
    const height = 320 * 2 ** level;
    return {
        level,
        width,                                    // pixels covering 360 deg of longitude
        height,                                   // pixels covering 180 deg of latitude
        cols: Math.ceil(width / TILE_SIZE),
        rows: Math.ceil(height / TILE_SIZE),
        degreesPerPixel: 360 / width
    };
}

export class UpstreamError extends Error {
    constructor(message, { status = 502, upstreamStatus, detail } = {}) {
        super(message);
        this.name = 'UpstreamError';
        this.status = status;
        this.upstreamStatus = upstreamStatus;
        this.detail = detail;
    }
}

/** KVP GetTile URL, in the same form as the GIBS documentation examples. */
export function tileUrl(config, date, level, row, col) {
    const params = new URLSearchParams({
        TIME: `${date}T00:00:00Z`,
        layer: config.layer,
        style: 'default',
        tilematrixset: config.tileMatrixSet,
        Service: 'WMTS',
        Request: 'GetTile',
        Version: '1.0.0',
        Format: 'image/png',
        TileMatrix: String(level),
        TileCol: String(col),
        TileRow: String(row)
    });
    return `${config.gibsBaseUrl}/wmts.cgi?${params}`;
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Pull the human-readable part out of an OGC ExceptionReport (or any short text body)
function upstreamMessage(body) {
    const text = body.match(/<(?:ows:)?ExceptionText>([\s\S]*?)<\/(?:ows:)?ExceptionText>/i)?.[1]
        ?? body.match(/exceptionCode="([^"]+)"/i)?.[1]
        ?? body.replace(/<[^>]+>/g, ' ');
    return text.replace(/\s+/g, ' ').trim().slice(0, 300);
}

/**
 * Fetch a GIBS resource, retrying network errors and 5xx/429 responses with backoff.
 * Responses are cached by Cloudflare for `cacheTtl` seconds, so textures of other sizes made
 * from the same tiles don't download them again. `what` names the resource in errors.
 * @returns {Promise<{bytes: Uint8Array, contentType: string}>}
 */
export async function fetchBytes(url, { fetchImpl = fetch, signal, cacheTtl, retries = 3, what = 'a file' } = {}) {
    for (let attempt = 0; ; attempt++) {
        const retry = attempt < retries;
        let response;
        let bytes;
        try {
            response = await fetchImpl(url, {
                signal,
                headers: { 'User-Agent': 'gibs-cloud-texture/1.0 (Cloudflare Worker)' },
                cf: cacheTtl ? { cacheEverything: true, cacheTtl } : undefined
            });
            if (response.ok) bytes = new Uint8Array(await response.arrayBuffer());
        } catch (error) {
            if (signal?.aborted) throw error;
            if (!retry) {
                throw new UpstreamError(`Could not reach GIBS: ${error.message}`, { status: 504, detail: url });
            }
            await sleep(250 * 3 ** attempt);
            continue;
        }

        if (bytes) return { bytes, contentType: response.headers.get('content-type') ?? 'unknown type' };

        const body = await response.text().catch(() => '');
        if (RETRYABLE.has(response.status) && retry) {
            await sleep(250 * 3 ** attempt);
            continue;
        }
        throw new UpstreamError(`GIBS returned HTTP ${response.status} for ${what}`, {
            upstreamStatus: response.status,
            detail: `${url}: ${upstreamMessage(body)}`
        });
    }
}

/** Fetch one tile and check that it really is a PNG. */
export async function fetchTile(url, options = {}) {
    const { bytes, contentType } = await fetchBytes(url, { ...options, what: 'a tile' });
    if (isPng(bytes)) return bytes;
    throw new UpstreamError(`GIBS returned ${contentType} instead of a PNG tile`, {
        detail: `${url}: ${upstreamMessage(new TextDecoder().decode(bytes.subarray(0, 2000)))}`
    });
}

/**
 * Presents every tile of one TileMatrix level as a single width x height image (cropped to
 * the globe) that is read one pixel row at a time, top to bottom.
 *
 * Two loading modes:
 *   - prefetchAll: open() downloads every tile and checks that each one decodes before
 *     returning, so once the response has started nothing upstream can fail. Used for
 *     small levels (level 3 is 50 tiles; the compressed tiles take ~5-20 MB).
 *   - otherwise: open() loads only the first tile row, and each next row downloads in the
 *     background while the current one is read. Memory stays flat at any level, but a
 *     later tile can still fail after the response has started.
 * Either way only one tile row is held inflated at a time.
 *
 * Rows come out as premultiplied RGBA floats, or, when a `mapper` is given, as one float
 * per pixel from mapper (see albedo.js).
 */
export class TileMosaic {
    constructor({ grid, date, config, fetchImpl, cacheTtl, prefetchAll = false, mapper = null }) {
        this.grid = grid;
        this.width = grid.width;
        this.height = grid.height;
        this.prefetchAll = prefetchAll;
        this.mapper = mapper;
        this.channels = mapper ? 1 : 4;
        this.controller = new AbortController();
        this.fetchOptions = { date, config, fetchImpl, cacheTtl };
        this.pending = new Array(grid.rows).fill(null); // tile row -> Promise<Uint8Array[]>
        this.lookahead = prefetchAll ? grid.rows : 2;     // tile rows downloading or downloaded
        this.tileRow = -1;
        this.readers = null;
        this.tilesFetched = 0;
    }

    /**
     * Load the first tile row, or every tile with prefetchAll. Errors thrown here mean the
     * texture cannot be made, and can still be reported with a proper HTTP status.
     */
    async open() {
        for (let row = 0; row < this.lookahead; row++) this.startRow(row);
        if (this.prefetchAll) {
            for (let row = 0; row < this.grid.rows; row++) {
                // decode to validate, then drop the pixels; advance() decodes again when needed
                await this.decodeRow(row, await this.pending[row]);
            }
        }
        await this.advance();
    }

    /** Write source row y (rows must be read in order) into `out`, `channels` floats per pixel. */
    async readRow(y, out) {
        const tileRow = Math.floor(y / TILE_SIZE);
        while (this.tileRow < tileRow) await this.advance();
        for (let col = 0; col < this.grid.cols; col++) {
            const x0 = col * TILE_SIZE;
            const count = Math.min(TILE_SIZE, this.width - x0);
            if (this.mapper) this.readers[col].readValues(out, x0, count, this.mapper);
            else this.readers[col].readRow(out, x0 * 4, count);
        }
    }

    abort(reason) {
        this.controller.abort(reason);
    }

    startRow(row) {
        const promise = this.fetchRow(row);
        promise.catch(() => {}); // handled when awaited; avoids an unhandled rejection meanwhile
        this.pending[row] = promise;
    }

    async advance() {
        const row = this.tileRow + 1;
        const tiles = await this.pending[row];
        this.pending[row] = null;
        if (row + this.lookahead < this.grid.rows) this.startRow(row + this.lookahead);

        this.readers = null; // let the previous row be collected before inflating this one
        this.readers = await this.decodeRow(row, tiles);
        this.tileRow = row;
    }

    decodeRow(row, tiles) {
        return Promise.all(tiles.map(async (bytes, col) => {
            const name = `GIBS tile ${this.grid.level}/${row}/${col}`;
            let reader;
            try {
                reader = await decodePng(bytes);
            } catch (error) {
                if (!(error instanceof PngError)) throw error;
                throw new UpstreamError(`${name} is not a usable PNG: ${error.message}`);
            }
            if (reader.width !== TILE_SIZE || reader.height !== TILE_SIZE) {
                throw new UpstreamError(`${name} is ${reader.width}x${reader.height}, expected ${TILE_SIZE}x${TILE_SIZE}`);
            }
            return reader;
        }));
    }

    async fetchRow(row) {
        const { date, config, fetchImpl, cacheTtl } = this.fetchOptions;
        const signal = this.controller.signal;
        const tiles = await Promise.all(Array.from({ length: this.grid.cols }, (_, col) =>
            fetchTile(tileUrl(config, date, this.grid.level, row, col), { fetchImpl, signal, cacheTtl })
        ));
        this.tilesFetched += tiles.length;
        return tiles;
    }
}
