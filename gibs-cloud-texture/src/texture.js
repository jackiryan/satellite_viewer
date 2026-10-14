/* texture.js - turns a TileMatrix level of GIBS tiles into one equirectangular PNG texture,
 * streamed out as it is produced.
 *
 * Two products:
 *   colormap  RGBA, the GIBS colours as they are
 *   albedo    greyscale, the cloud's visible reflectance worked out from each tile colour
 *             (see albedo.js), stored as sqrt(reflectance)
 *
 * Pipeline, one output row at a time:
 *   tile rows (TileMosaic) -> source row: premultiplied RGBA floats, or reflectance
 *     -> horizontal resample to the output width (kept in a small ring buffer)
 *     -> vertical blend of the buffered rows -> straight-alpha RGBA8, or sqrt-encoded grey
 *     -> Up filter -> zlib (CompressionStream) -> PNG chunks
 *
 * The finished image is never held in memory: peak live memory measured 35-50 MB for
 * 8k textures from levels 3-5, inside a Worker's 128 MB, although the raw 8k image alone
 * would be 134 MB.
 */
import { TileMosaic, tileGrid } from './gibs.js';
import { PngStreamEncoder, filterScanline } from './png.js';
import { blendRows, blendValues, filterTaps, resampleRow, resampleValues } from './resample.js';
import { loadAlbedoMapper } from './albedo.js';

export const PRODUCTS = ['colormap', 'albedo'];

export const OUTPUT_SIZES = {
    '1k': [1024, 512],
    '2k': [2048, 1024],
    '4k': [4096, 2048],
    '8k': [8192, 4096]
};

// Scanlines are handed to the compressor in batches of about this many bytes
const BATCH_BYTES = 1 << 20;

// Levels with at most this many tiles are downloaded and checked in full before the
// response starts (levels 0-3; level 3 is 50 tiles). Larger levels stream tile rows.
export const PREFETCH_ALL_MAX_TILES = 64;

/**
 * Start building a texture. Resolves once the tiles needed up front are downloaded and
 * decoded (all of them for small levels, the first row otherwise), so a bad date, layer or
 * upstream outage still produces a proper HTTP error; the PNG itself is then streamed.
 *
 * @returns {Promise<{stream: ReadableStream<Uint8Array>, done: Promise<object>,
 *   complete: boolean, grid: object, width: number, height: number}>}
 *   `stream` is the PNG file. `done` settles when it is finished (with stats) or has failed,
 *   in which case the stream is aborted. `complete` is true when every tile was already
 *   checked, so the stream can no longer fail because of GIBS.
 */
export async function createTexture({
    date, tileMatrix, outputRes, product = 'colormap', config, fetchImpl = fetch, cacheTtl
}) {
    const grid = tileGrid(tileMatrix);
    const [width, height] = OUTPUT_SIZES[outputRes];
    const started = Date.now();

    const mapper = product === 'albedo' ? await loadAlbedoMapper(config.colormapUrl, { fetchImpl }) : null;
    const prefetchAll = grid.cols * grid.rows <= PREFETCH_ALL_MAX_TILES;
    const mosaic = new TileMosaic({ grid, date, config, fetchImpl, cacheTtl, prefetchAll, mapper });
    try {
        await mosaic.open();
    } catch (error) {
        mosaic.abort(error);
        throw error;
    }

    const encoder = new PngStreamEncoder(width, height, mosaic.channels);
    const done = render(mosaic, encoder, width, height).then(
        () => ({ tiles: mosaic.tilesFetched, ms: Date.now() - started }),
        (error) => {
            mosaic.abort(error);
            encoder.abort(error);
            throw error;
        }
    );
    return { stream: encoder.readable, done, complete: prefetchAll, grid, width, height };
}

async function render(source, encoder, width, height) {
    const horizontal = filterTaps(source.width, width, { wrap: true });
    const vertical = filterTaps(source.height, height, { wrap: false });
    const channels = source.channels;
    const resample = channels === 4 ? resampleRow : resampleValues;
    const blend = channels === 4 ? blendRows : blendValues;

    const sourceRow = new Float32Array(source.width * channels);
    // Ring buffer of horizontally resampled source rows. Each output row draws on at most
    // maxTaps consecutive source rows, so that many slots are enough.
    const slots = vertical.maxTaps;
    const ring = Array.from({ length: slots }, () => new Float32Array(width * channels));
    let nextSourceRow = 0;

    let current = new Uint8ClampedArray(width * channels);
    let previous = null;
    const scanlineBytes = width * channels + 1;
    const rowsPerBatch = Math.max(1, Math.floor(BATCH_BYTES / scanlineBytes));
    let batch = null;
    let batchRows = 0;

    for (let y = 0; y < height; y++) {
        const first = vertical.offsets[y];
        const end = vertical.offsets[y + 1];

        const lastSourceRow = vertical.index[end - 1];
        while (nextSourceRow <= lastSourceRow) {
            await source.readRow(nextSourceRow, sourceRow);
            resample(sourceRow, ring[nextSourceRow % slots], horizontal);
            nextSourceRow++;
        }

        const rows = [];
        const weights = [];
        for (let k = first; k < end; k++) {
            rows.push(ring[vertical.index[k] % slots]);
            weights.push(vertical.weight[k]);
        }
        blend(rows, weights, current);

        if (!batch) batch = new Uint8Array(rowsPerBatch * scanlineBytes);
        filterScanline(batch.subarray(batchRows * scanlineBytes, (batchRows + 1) * scanlineBytes), current, previous);
        batchRows++;
        if (batchRows === rowsPerBatch || y === height - 1) {
            await encoder.write(batch.subarray(0, batchRows * scanlineBytes));
            batch = null; // the compressor may still hold the old buffer, so start a new one
            batchRows = 0;
        }

        // keep this row unfiltered; the next row is filtered against it
        const swap = previous ?? new Uint8ClampedArray(width * channels);
        previous = current;
        current = swap;
    }
    await encoder.close();
}
