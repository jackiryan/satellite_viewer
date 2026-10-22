/* seaice.js - a global sea ice concentration texture from the NSIDC Sea Ice Index (G02135,
 * version 4): the daily Arctic and Antarctic concentration GeoTIFFs, reprojected from their
 * polar stereographic grids into one equirectangular greyscale PNG.
 *
 *   https://noaadata.apps.nsidc.org/NOAA/G02135/north/daily/geotiff/2026/10_Oct/N_20261017_concentration_v4.0.tif
 *   https://noaadata.apps.nsidc.org/NOAA/G02135/south/daily/geotiff/2026/10_Oct/S_20261017_concentration_v4.0.tif
 *
 * Each GeoTIFF is one band of unsigned 16-bit values on a 25 km grid (304x448 in EPSG:3411,
 * 316x332 in EPSG:3412), with the land mask mixed into the same band (user guide, table 5):
 *
 *   0          open water
 *   1-1000     concentration x 10 (803 = 80.3%); under 150 (15%) counts as open water
 *   2510       pole hole (no satellite coverage around the North Pole)
 *   2530       coastline (a mixed land/ocean cell)
 *   2540       land
 *   2550       missing data (rare in version 4, which fills gaps over time)
 *
 * Only the concentration is kept. Before reprojecting, the cells without a concentration are
 * filled in from their neighbours, so the texture has no holes where it meets the globe's own
 * land and ocean:
 *   - pole hole and missing cells are filled completely, from the ice around them;
 *   - coastline cells too, so ice reaches the coast and fills narrow channels (in the Canadian
 *     Arctic Archipelago most channels are coastline cells);
 *   - land is filled LAND_FILL_CELLS cells (50 km) deep and is no data beyond that.
 * The globe's shader should multiply by its own ocean mask, which is far sharper than 25 km.
 *
 * The texture is 2:1 equirectangular like the cloud textures (west edge at 180 W, north at the
 * top), one byte per pixel: round(concentration * 255), so 0 is open water and anything with
 * no data, 255 is 100% ice. Each output pixel samples the grid bilinearly, from only the cells
 * that have data, with a few samples per pixel where it covers more than one grid cell.
 */
import { readGeoTiff, TiffError } from './geotiff.js';
import { RETRYABLE, UpstreamError, fetchBytes, sleep } from './gibs.js';
import { EPSG_PROJECTIONS, ProjectionError, polarStereographic, projectionFromGeoKeys } from './polarstereo.js';
import { PngStreamEncoder, filterScanline } from './png.js';
import { OUTPUT_SIZES } from './texture.js';
import { addDays, isRecent } from './dates.js';

export const SEA_ICE_PRODUCT = 'concentration';

// Values in the GeoTIFFs besides concentrations (user guide table 5)
export const SEA_ICE_FLAGS = { POLE_HOLE: 2510, COAST: 2530, LAND: 2540, MISSING: 2550 };
const MAX_CONCENTRATION = 1000;  // 100.0%
const MIN_CONCENTRATION = 150;   // 15%: lower values are "statistically irrelevant"

// How far, in grid cells, concentrations are carried into land (see above)
export const LAND_FILL_CELLS = 2;

// Most samples per output pixel along each axis. Only 1k textures need more than one
// (their pixels are up to ~1.7 grid cells wide at the edge of the grids).
const MAX_SUPERSAMPLE = 4;

export const HEMISPHERES = {
    north: { dir: 'north', prefix: 'N', epsg: 3411, label: 'Arctic' },
    south: { dir: 'south', prefix: 'S', epsg: 3412, label: 'Antarctic' }
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** URL of one day's concentration GeoTIFF for a hemisphere ('north' or 'south'). */
export function seaIceUrl(config, hemisphere, date) {
    const { dir, prefix } = HEMISPHERES[hemisphere];
    const [y, m, d] = date.split('-');
    return `${config.seaIce.baseUrl}/${dir}/daily/geotiff/${y}/${m}_${MONTHS[Number(m) - 1]}/` +
        `${prefix}_${y}${m}${d}_concentration_v${config.seaIce.fileVersion}.tif`;
}

/* ---------------------------------------------------------------------- availability
 *
 * NSIDC publishes a day's grids the next day, and before 20 August 1987 there is only one
 * every other day. A request is served the newest date at or before the one asked for that has
 * both GeoTIFFs, found by asking for the files' headers. Answers are remembered for a while.
 */

export const LOOKBACK_DAYS = 7;
const MEMO_MS = 10 * 60 * 1000;
const memo = new Map();
const USER_AGENT = 'gibs-cloud-texture/1.0 (Cloudflare Worker; sea ice)';

/** For tests: forget remembered dates. */
export function clearSeaIceMemo() {
    memo.clear();
}

/**
 * Whether a file exists: true, false (404/410), or throws UpstreamError if NSIDC can't say.
 * Uses HEAD, falling back to a one-byte GET for servers that don't allow HEAD.
 */
export async function fileExists(url, { fetchImpl = fetch, retries = 2 } = {}) {
    let method = 'HEAD';
    for (let attempt = 0; ; attempt++) {
        let response;
        try {
            response = await fetchImpl(url, {
                method,
                headers: method === 'HEAD' ? { 'User-Agent': USER_AGENT } : { 'User-Agent': USER_AGENT, Range: 'bytes=0-0' }
            });
            await response.body?.cancel();
        } catch (error) {
            if (attempt >= retries) throw new UpstreamError(`Could not reach NSIDC: ${error.message}`, { status: 504, detail: url });
            await sleep(250 * 3 ** attempt);
            continue;
        }
        if (response.ok) return true;
        if (response.status === 404 || response.status === 410) return false;
        if (method === 'HEAD' && (response.status === 405 || response.status === 501)) {
            method = 'GET';
            continue;
        }
        if (RETRYABLE.has(response.status) && attempt < retries) {
            await sleep(250 * 3 ** attempt);
            continue;
        }
        throw new UpstreamError(`NSIDC returned HTTP ${response.status} when checking for a sea ice GeoTIFF`, {
            upstreamStatus: response.status,
            detail: url
        });
    }
}

/**
 * The date to serve for a request for `date`: the newest date at or before it, at most
 * LOOKBACK_DAYS earlier, with both GeoTIFFs published.
 * @returns {Promise<{date: string|null, fallback: boolean, checked: boolean}>} date is null if
 *   there is none; checked is false if NSIDC couldn't be asked (the date is then used as asked).
 */
export async function resolveSeaIceDate(config, date, { fetchImpl = fetch, now = Date.now() } = {}) {
    const hit = memo.get(date);
    if (hit && hit.expires > now) return hit.result;

    let result = { date: null, fallback: false, checked: true };
    try {
        for (let back = 0; back <= LOOKBACK_DAYS; back++) {
            const candidate = addDays(date, -back);
            if (candidate < config.seaIce.earliestDate) break;
            const found = await Promise.all(Object.keys(HEMISPHERES).map((h) =>
                fileExists(seaIceUrl(config, h, candidate), { fetchImpl })));
            if (found.every(Boolean)) {
                result = { date: candidate, fallback: back > 0, checked: true };
                break;
            }
        }
    } catch (error) {
        console.warn(JSON.stringify({ event: 'sea_ice_availability_check_failed', date, message: error.message }));
        return { date, fallback: false, checked: false };
    }
    // older dates won't change; recent ones are checked again after a while
    memo.set(date, { result, expires: now + (isRecent(date, now) ? MEMO_MS : 24 * MEMO_MS) });
    return result;
}

/* --------------------------------------------------------------------------- loading */

/**
 * Download and prepare both hemispheres' grids for one date.
 * @returns {Promise<{north: object, south: object}>}
 */
export async function loadSeaIceGrids(config, date, { fetchImpl = fetch, cacheTtl } = {}) {
    const [north, south] = await Promise.all(Object.keys(HEMISPHERES).map(async (hemisphere) => {
        const url = seaIceUrl(config, hemisphere, date);
        const { bytes } = await fetchBytes(url, {
            fetchImpl, cacheTtl, source: 'NSIDC', what: `the ${HEMISPHERES[hemisphere].label} sea ice GeoTIFF`
        });
        try {
            return prepareGrid(await readGeoTiff(bytes), hemisphere);
        } catch (error) {
            if (!(error instanceof TiffError || error instanceof ProjectionError)) throw error;
            throw new UpstreamError(`NSIDC's ${HEMISPHERES[hemisphere].label} sea ice GeoTIFF is not usable: ${error.message}`, { detail: url });
        }
    }));
    return { north, south };
}

/**
 * Turn a decoded GeoTIFF into a grid ready to sample: concentrations 0-1 (NaN where there
 * is no data, after filling as described at the top), plus where it sits on the globe.
 */
export function prepareGrid(tiff, hemisphere) {
    const { width, height, raster, geoTransform: gt } = tiff;
    if (!gt) throw new TiffError('no georeferencing (ModelTiepoint/ModelPixelScale or ModelTransformation)');
    const projection = projectionFromGeoKeys(tiff.geoKeys)
        ?? polarStereographic({ ...EPSG_PROJECTIONS[HEMISPHERES[hemisphere].epsg], name: `EPSG:${HEMISPHERES[hemisphere].epsg}` });
    if (projection.north !== (hemisphere === 'north')) {
        throw new ProjectionError(`the ${hemisphere} grid is in a ${projection.north ? 'north' : 'south'} polar projection`);
    }

    const n = width * height;
    const values = new Float32Array(n).fill(NaN);
    // what each cell without a concentration is, and so how far filling may reach into it
    const UNLIMITED = 1, LAND = 2;
    const fillable = new Uint8Array(n);
    const stats = { ice: 0, water: 0, poleHole: 0, coast: 0, land: 0, missing: 0, unknown: 0 };
    for (let i = 0; i < n; i++) {
        const v = raster[i];
        if (v >= 0 && v <= MAX_CONCENTRATION) {
            values[i] = v < MIN_CONCENTRATION ? 0 : v / MAX_CONCENTRATION;
            if (v < MIN_CONCENTRATION) stats.water++;
            else stats.ice++;
        } else if (v === SEA_ICE_FLAGS.POLE_HOLE) {
            fillable[i] = UNLIMITED;
            stats.poleHole++;
        } else if (v === SEA_ICE_FLAGS.MISSING) {
            fillable[i] = UNLIMITED;
            stats.missing++;
        } else if (v === SEA_ICE_FLAGS.COAST) {
            fillable[i] = UNLIMITED;
            stats.coast++;
        } else {
            fillable[i] = LAND;
            if (v === SEA_ICE_FLAGS.LAND) stats.land++;
            else stats.unknown++;
        }
    }
    if (stats.ice + stats.water === 0) throw new TiffError('no concentration values in the grid');

    stats.filled = fillFromNeighbours(values, width, height, fillable, UNLIMITED, Infinity);
    stats.filled += fillFromNeighbours(values, width, height, fillable, LAND, LAND_FILL_CELLS);

    // inverse geotransform: map x, y -> continuous (col, row) with cell centres on integers
    const [x0, a, b, y0, d, e] = gt;
    const det = a * e - b * d;
    if (!det) throw new TiffError('degenerate geotransform');
    const cx = e / det, cy = -b / det, rx = -d / det, ry = a / det;
    const inverse = [-(cx * x0 + cy * y0) - 0.5, cx, cy, -(rx * x0 + ry * y0) - 0.5, rx, ry];

    // the farthest the grid reaches from the pole: one of its corners
    let reach = 0;
    for (const [col, row] of [[0, 0], [width, 0], [0, height], [width, height]]) {
        const x = x0 + col * a + row * b - projection.falseEasting;
        const y = y0 + col * d + row * e - projection.falseNorthing;
        reach = Math.max(reach, Math.hypot(x, y));
    }

    return {
        hemisphere,
        width,
        height,
        values,
        projection,
        inverse,
        cellSize: Math.sqrt(Math.abs(det)),
        reach,
        stats
    };
}

/**
 * Fill cells marked `kind` in `fillable` from their filled 8-neighbours, a ring at a time
 * (each new cell gets the mean of its neighbours that already had a value), for at most
 * `maxPasses` rings. Returns the number of cells filled.
 */
function fillFromNeighbours(values, width, height, fillable, kind, maxPasses) {
    let pending = [];
    for (let i = 0; i < values.length; i++) if (fillable[i] === kind && Number.isNaN(values[i])) pending.push(i);
    let filled = 0;
    for (let pass = 0; pass < maxPasses && pending.length; pass++) {
        const updates = [];
        const remaining = [];
        for (const i of pending) {
            const x = i % width, y = (i - x) / width;
            let sum = 0, count = 0;
            for (let dy = -1; dy <= 1; dy++) {
                const yy = y + dy;
                if (yy < 0 || yy >= height) continue;
                for (let dx = -1; dx <= 1; dx++) {
                    const xx = x + dx;
                    if ((dx === 0 && dy === 0) || xx < 0 || xx >= width) continue;
                    const v = values[yy * width + xx];
                    if (v === v) { sum += v; count++; }
                }
            }
            if (count) updates.push(i, sum / count);
            else remaining.push(i);
        }
        if (!updates.length) break;
        for (let k = 0; k < updates.length; k += 2) values[updates[k]] = updates[k + 1];
        filled += updates.length / 2;
        pending = remaining;
    }
    return filled;
}

/* ------------------------------------------------------------------------- rendering */

const BATCH_BYTES = 1 << 20;
const DEG = Math.PI / 180;

/**
 * Make the texture. Resolves once both GeoTIFFs are downloaded and checked, so NSIDC
 * failures are reported with a proper HTTP status; the PNG is then streamed, and can no
 * longer fail because of NSIDC (`complete` is always true).
 *
 * Pass `grids` (from loadSeaIceGrids) to make several sizes from one download.
 */
export async function createSeaIceTexture({ config, date, outputRes, fetchImpl = fetch, cacheTtl, grids }) {
    const started = Date.now();
    grids ??= await loadSeaIceGrids(config, date, { fetchImpl, cacheTtl });
    const [width, height] = OUTPUT_SIZES[outputRes];
    const encoder = new PngStreamEncoder(width, height, 1);
    const done = renderSeaIce(grids, encoder, width, height).then(
        () => ({ ms: Date.now() - started, north: grids.north.stats, south: grids.south.stats }),
        (error) => {
            encoder.abort(error);
            throw error;
        }
    );
    return {
        stream: encoder.readable,
        done,
        complete: true,
        width,
        height,
        grids,
        sourceSize: `N ${grids.north.width}x${grids.north.height}, S ${grids.south.width}x${grids.south.height}`
    };
}

async function renderSeaIce(grids, encoder, width, height) {
    const samplers = { north: new RowSampler(grids.north, width), south: new RowSampler(grids.south, width) };
    let current = new Uint8ClampedArray(width);
    let previous = null;
    const scanlineBytes = width + 1;
    const rowsPerBatch = Math.max(1, Math.floor(BATCH_BYTES / scanlineBytes));
    let batch = null;
    let batchRows = 0;

    for (let y = 0; y < height; y++) {
        const latTop = 90 - (y * 180) / height;
        const latBottom = 90 - ((y + 1) * 180) / height;
        samplers[latTop + latBottom >= 0 ? 'north' : 'south'].sampleRow(latTop, latBottom, current);

        if (!batch) batch = new Uint8Array(rowsPerBatch * scanlineBytes);
        filterScanline(batch.subarray(batchRows * scanlineBytes, (batchRows + 1) * scanlineBytes), current, previous);
        batchRows++;
        if (batchRows === rowsPerBatch || y === height - 1) {
            await encoder.write(batch.subarray(0, batchRows * scanlineBytes));
            batch = null; // the compressor may still hold the old buffer
            batchRows = 0;
        }
        const swap = previous ?? new Uint8ClampedArray(width);
        previous = current;
        current = swap;
    }
    await encoder.close();
}

/** Samples one hemisphere's grid along rows of the equirectangular texture. */
class RowSampler {
    constructor(grid, width) {
        this.grid = grid;
        this.width = width;
        this.trig = new Map(); // samples per pixel across -> [sin, cos] of (lon - lon0) per sample
        this.rhos = new Float64Array(MAX_SUPERSAMPLE);
    }

    trigFor(nX) {
        let table = this.trig.get(nX);
        if (!table) {
            const count = this.width * nX;
            const sin = new Float64Array(count), cos = new Float64Array(count);
            for (let k = 0; k < count; k++) {
                const lon = -180 + ((k + 0.5) / count) * 360;
                const dl = lon * DEG - this.grid.projection.lon0;
                sin[k] = Math.sin(dl);
                cos[k] = Math.cos(dl);
            }
            table = [sin, cos];
            this.trig.set(nX, table);
        }
        return table;
    }

    /** Fill `out` (one byte per pixel) for the texture row between two latitudes (degrees). */
    sampleRow(latTop, latBottom, out) {
        const { values, width: gw, height: gh, projection, inverse, cellSize, reach } = this.grid;
        const rhoTop = projection.rho(latTop * DEG);
        const rhoBottom = projection.rho(latBottom * DEG);
        if (Math.min(rhoTop, rhoBottom) > reach) {
            out.fill(0);
            return;
        }
        // samples per pixel, so that they are at most about a grid cell apart
        const nY = Math.min(MAX_SUPERSAMPLE, Math.max(1, Math.ceil(Math.abs(rhoTop - rhoBottom) / cellSize)));
        const nX = Math.min(MAX_SUPERSAMPLE, Math.max(1,
            Math.ceil((Math.max(rhoTop, rhoBottom) * 2 * Math.PI) / this.width / cellSize)));
        const rhos = this.rhos;
        for (let s = 0; s < nY; s++) {
            rhos[s] = projection.rho((latTop + ((s + 0.5) / nY) * (latBottom - latTop)) * DEG);
        }
        const [sin, cos] = this.trigFor(nX);
        const { falseEasting: fe, falseNorthing: fn, ySign } = projection;
        const [c0, cx, cy, r0, rx, ry] = inverse;
        const maxU = gw - 0.5, maxV = gh - 0.5;

        for (let x = 0; x < this.width; x++) {
            let sumWV = 0, sumW = 0;
            for (let s = 0; s < nY; s++) {
                const rho = rhos[s];
                for (let t = x * nX, end = t + nX; t < end; t++) {
                    const X = fe + rho * sin[t];
                    const Y = fn + ySign * rho * cos[t];
                    const u = c0 + cx * X + cy * Y;
                    const v = r0 + rx * X + ry * Y;
                    if (u < -0.5 || v < -0.5 || u > maxU || v > maxV) continue;
                    const i0 = Math.floor(u), j0 = Math.floor(v);
                    const fu = u - i0, fv = v - j0;
                    const base = j0 * gw + i0;
                    let val, w;
                    if (j0 >= 0) {
                        if (i0 >= 0 && (val = values[base]) === val) {
                            w = (1 - fu) * (1 - fv); sumWV += w * val; sumW += w;
                        }
                        if (i0 + 1 < gw && (val = values[base + 1]) === val) {
                            w = fu * (1 - fv); sumWV += w * val; sumW += w;
                        }
                    }
                    if (j0 + 1 < gh) {
                        if (i0 >= 0 && (val = values[base + gw]) === val) {
                            w = (1 - fu) * fv; sumWV += w * val; sumW += w;
                        }
                        if (i0 + 1 < gw && (val = values[base + gw + 1]) === val) {
                            w = fu * fv; sumWV += w * val; sumW += w;
                        }
                    }
                }
            }
            out[x] = sumW > 1e-6 ? (sumWV / sumW) * 255 : 0;
        }
    }
}
