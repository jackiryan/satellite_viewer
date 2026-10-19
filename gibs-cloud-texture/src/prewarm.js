/* prewarm.js - scheduled job (Cron Trigger) that keeps the textures the site asks for ready
 * in R2, so visitors never wait for one to be made.
 *
 * Each run:
 *   1. works out the dates pages will ask for (by default 1 and 2 days back, UTC; the globe asks
 *      for 2 days back, and 1 day back becomes that at the next UTC midnight) and, for each, the
 *      newest date GIBS has published at or before it (availability.js);
 *   2. makes and stores any of those textures (each configured resolution) that are missing,
 *      and remakes ones for recent dates that are older than the refresh interval, in case GIBS
 *      has filled in more of that day since;
 *   3. deletes stored textures older than the retention period, and any left over from an
 *      older STORE_VERSION or another layer. The bucket should be used only by this Worker.
 *
 * Textures are made one at a time to keep memory use down.
 */
import { resolveDate } from './availability.js';
import { DAY_MS, isRecent, maxAgeFor, todayUtc, addDays } from './dates.js';
import { storePrefix, storeStream, textureKey, textureMetadata } from './store.js';
import { createTexture } from './texture.js';

/**
 * @param {object} options
 * @param {object} options.config   Worker config (readConfig), including config.prewarm
 * @param {R2Bucket} options.bucket
 * @param {number} options.now      scheduled time, ms since the epoch
 * @returns {Promise<object>} summary of what was done
 */
export async function prewarm({ config, bucket, now = Date.now(), fetchImpl = fetch }) {
    const settings = config.prewarm;
    const summary = { dates: [], generated: [], fresh: [], failed: [], pruned: 0 };

    const dates = new Set();
    for (const daysBack of settings.daysBack) {
        const wanted = addDays(todayUtc(now), -daysBack);
        const { date } = await resolveDate(config, wanted, { fetchImpl, now });
        dates.add(date);
    }
    summary.dates = [...dates];

    for (const date of dates) {
        for (const outputRes of settings.resolutions) {
            const params = { date, tileMatrix: settings.tileMatrix, outputRes, product: settings.product };
            const key = textureKey(config, params);
            const existing = await bucket.head(key);
            const age = existing ? now - existing.uploaded.getTime() : Infinity;
            if (existing && !(isRecent(date, now) && age > settings.refreshHours * 3_600_000)) {
                summary.fresh.push(key);
                continue;
            }
            const started = Date.now();
            try {
                const texture = await createTexture({ ...params, config, fetchImpl, cacheTtl: maxAgeFor(date, now) });
                // Wait for both: if the texture fails, the upload is aborted before moving on
                const [stored, done] = await Promise.allSettled([
                    storeStream(bucket, key, texture.stream, textureMetadata(params, texture, now)),
                    texture.done
                ]);
                if (done.status === 'rejected') throw done.reason;
                if (stored.status === 'rejected') throw stored.reason;
                summary.generated.push({ key, ms: Date.now() - started });
            } catch (error) {
                summary.failed.push({ key, message: error.message, detail: error.detail });
            }
        }
    }

    summary.pruned = await prune(config, bucket, now - settings.retainDays * DAY_MS);
    return summary;
}

/** Delete objects uploaded before `cutoff`, or not under the current prefix. */
async function prune(config, bucket, cutoff) {
    const prefix = storePrefix(config);
    const doomed = [];
    let cursor;
    do {
        const page = await bucket.list({ cursor, limit: 1000 });
        for (const object of page.objects) {
            if (!object.key.startsWith(prefix) || object.uploaded.getTime() < cutoff) doomed.push(object.key);
        }
        cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    for (let i = 0; i < doomed.length; i += 1000) await bucket.delete(doomed.slice(i, i + 1000));
    return doomed.length;
}
