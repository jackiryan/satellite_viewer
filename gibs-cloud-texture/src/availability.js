/* availability.js - which dates GIBS has published for the layer.
 *
 * GIBS takes about two days to publish a day of this layer, so the date a page asks for
 * (two days back) is often not out yet, especially early in the UTC day. Asking GIBS for tiles
 * of an unpublished date fails or comes back empty. Instead, requests for recent dates are
 * served the newest published date at or before the one asked for.
 *
 * GIBS lists published dates in a WMTS "DescribeDomains" document:
 *   {base}/1.0.0/{layer}/default/{tileMatrixSet}/all/{from}--{to}.xml
 * whose time Domain is a comma-separated list of ranges such as
 *   2024-04-17/2024-09-21/P1D,2024-09-23/2026-10-17/P1D
 */
import { fetchBytes } from './gibs.js';
import { addDays, isRecent } from './dates.js';

// How far back to look for a published date before giving up and using the date as asked
const LOOKBACK_DAYS = 10;
// Published dates are remembered per isolate for this long
const MEMO_MS = 10 * 60 * 1000;
const memo = new Map();

export function domainsUrl(config, from, to) {
    return `${config.gibsBaseUrl}/1.0.0/${config.layer}/default/${config.tileMatrixSet}/all/${from}--${to}.xml`;
}

/**
 * Parse the time domain of a DescribeDomains document into [start, end] date pairs.
 * Returns null if the document has no time dimension.
 */
export function parseTimeDomain(xml) {
    for (const [, body] of xml.matchAll(/<DimensionDomain\b[^>]*>([\s\S]*?)<\/DimensionDomain>/g)) {
        if (!/<(?:ows:)?Identifier>\s*time\s*<\/(?:ows:)?Identifier>/i.test(body)) continue;
        const domain = body.match(/<Domain>([\s\S]*?)<\/Domain>/)?.[1] ?? '';
        return domain.split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
            const [start, end = start] = part.split('/');
            return [start.slice(0, 10), end.slice(0, 10)];
        });
    }
    return null;
}

/** The latest published date on or before `date`, or null if there is none in `ranges`. */
export function latestAvailable(ranges, date) {
    let best = null;
    for (const [start, end] of ranges) {
        if (start > date) continue;
        const candidate = end < date ? end : date;
        if (!best || candidate > best) best = candidate;
    }
    return best;
}

/** Published date ranges between `from` and `to`, remembered for a few minutes. */
export async function availableRanges(config, from, to, { fetchImpl = fetch, now = Date.now() } = {}) {
    const url = domainsUrl(config, from, to);
    const hit = memo.get(url);
    if (hit && hit.expires > now) return hit.ranges;
    const { bytes } = await fetchBytes(url, { fetchImpl, cacheTtl: MEMO_MS / 1000, what: 'the list of published dates' });
    const ranges = parseTimeDomain(new TextDecoder().decode(bytes));
    memo.set(url, { ranges, expires: now + MEMO_MS });
    return ranges;
}

/**
 * The date to actually serve for a request for `date`: the newest published date at or before
 * it. Only recent dates are checked (older ones are long since published); if the check fails
 * or finds nothing, the date is used as asked.
 * @returns {Promise<{date: string, fallback: boolean}>}
 */
export async function resolveDate(config, date, { fetchImpl = fetch, now = Date.now() } = {}) {
    if (!isRecent(date, now)) return { date, fallback: false };
    let ranges;
    try {
        ranges = await availableRanges(config, addDays(date, -LOOKBACK_DAYS), date, { fetchImpl, now });
    } catch (error) {
        console.warn(JSON.stringify({ event: 'availability_check_failed', date, message: error.message }));
        return { date, fallback: false };
    }
    const latest = ranges ? latestAvailable(ranges, date) : null;
    if (!latest) return { date, fallback: false };
    return { date: latest, fallback: latest !== date };
}

/** For tests: forget remembered date lists. */
export function clearAvailabilityMemo() {
    memo.clear();
}
