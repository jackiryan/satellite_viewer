/* albedo.js - turns GIBS Cloud Optical Thickness colors back into optical thickness, and
 * optical thickness into the cloud's visible reflectance (its albedo).
 *
 * The colormap XML says which optical thickness range each color stands for and whether it
 * is an ice or water cloud. Tiles use exactly those colors, so each palette entry maps to
 * one reflectance before any resampling blends neighbouring colors together.
 *
 * Reflectance of a non-absorbing cloud over a dark surface, two-stream approximation
 * (e.g. Bohren 1987, "Multiple scattering of light and some of its observable consequences"):
 *
 *     R = (1 - g) tau / (2 + (1 - g) tau)
 *
 * with g the asymmetry parameter of the cloud particles at visible wavelengths. It gives
 * R ~ 0.07 at tau = 1 (thin haze), 0.43 at tau = 10 and 0.8 at tau = 50, close to the
 * nadir reflectances seen in true color imagery. Transmission through the cloud is 1 - R.
 */
import { UpstreamError, fetchBytes } from './gibs.js';

// Asymmetry parameters at visible wavelengths: water droplets, and the roughened ice
// particles assumed by the MODIS/VIIRS cloud retrievals.
export const ASYMMETRY = { water: 0.86, ice: 0.75 };

// colors within this distance (sum of |dR| + |dG| + |dB|) of a colormap entry match it.
// GIBS palettes use the colormap colors exactly; this only absorbs rounding elsewhere.
const MATCH_TOLERANCE = 6;

export function cloudReflectance(tau, phase) {
    const s = (1 - ASYMMETRY[phase]) * Math.max(tau, 0);
    return s / (2 + s);
}

// A representative optical thickness for a colormap bin such as "[1.038,1.077)". Bins are
// log-spaced, so take the geometric mean; the open-ended first bin "[0.01,1)" counts as 0.5.
function binValue(text) {
    const numbers = (text.match(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi) ?? []).map(Number);
    if (numbers.length === 0 || numbers.some((n) => !Number.isFinite(n))) return null;
    if (numbers.length === 1) return numbers[0];
    const [lo, hi] = numbers;
    return Math.sqrt(Math.max(lo, hi / 4) * hi);
}

function attributes(tag) {
    const out = {};
    for (const [, name, value] of tag.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) out[name] = value;
    return out;
}

/**
 * Parse a GIBS colormap (v1.x XML) into entries of { rgb, reflectance }.
 * Transparent and no-data entries get reflectance 0.
 */
export function parseColormap(xml) {
    const entries = [];
    for (const [, mapTag, body] of xml.matchAll(/<ColorMap\b([^>]*)>([\s\S]*?)<\/ColorMap>/g)) {
        const title = attributes(mapTag).title ?? '';
        const phase = /\bice\b/i.test(title) ? 'ice' : 'water';
        for (const [tag] of body.matchAll(/<ColorMapEntry\b[^>]*>/g)) {
            const a = attributes(tag);
            const rgb = (a.rgb ?? '').split(',').map((v) => Number.parseInt(v, 10));
            if (rgb.length !== 3 || rgb.some((v) => !(v >= 0 && v <= 255))) continue;
            const empty = a.transparent === 'true' || a.nodata === 'true';
            const tau = empty ? null : binValue(a.value ?? '');
            if (!empty && tau === null) continue;
            entries.push({ rgb, reflectance: empty ? 0 : cloudReflectance(tau, phase), tau, phase });
        }
    }
    return entries;
}

/** Maps tile colors (palette entries or RGBA pixels) to cloud reflectance. */
export class AlbedoMapper {
    constructor(entries) {
        this.entries = entries;
        this.exact = new Map(entries.map((e) => [(e.rgb[0] << 16) | (e.rgb[1] << 8) | e.rgb[2], e.reflectance]));
        this.unmatched = 0; // distinct colors that matched no entry (they map to clear sky)
    }

    colorValue(r, g, b, a = 255, { quiet = false } = {}) {
        if (a < 128) return 0;
        const key = (r << 16) | (g << 8) | b;
        let value = this.exact.get(key);
        if (value === undefined) {
            let best = Infinity;
            value = 0;
            for (const e of this.entries) {
                const d = Math.abs(e.rgb[0] - r) + Math.abs(e.rgb[1] - g) + Math.abs(e.rgb[2] - b);
                if (d < best) {
                    best = d;
                    value = e.reflectance;
                }
            }
            if (best > MATCH_TOLERANCE) {
                value = 0;
                if (!quiet && ++this.unmatched <= 10) {
                    console.warn(JSON.stringify({ event: 'unmatched_color', rgb: [r, g, b], note: 'not in the GIBS colormap; treated as clear sky' }));
                }
            }
            if (!quiet) this.exact.set(key, value); // remember, so each color is searched once
        }
        return value;
    }

    /**
     * Reflectance for each entry of a PNG palette (PLTE and optional tRNS chunks). Palettes
     * are often padded with unused entries, so colors that match nothing are not reported.
     */
    paletteValues(palette, transparency) {
        const lut = new Float32Array(256);
        const count = Math.min(256, Math.floor(palette.length / 3));
        for (let i = 0; i < count; i++) {
            const alpha = transparency && i < transparency.length ? transparency[i] : 255;
            lut[i] = this.colorValue(palette[3 * i], palette[3 * i + 1], palette[3 * i + 2], alpha, { quiet: true });
        }
        return lut;
    }
}

// Parsed colormaps, kept for the life of the isolate
const mappers = new Map();

/** Fetch and parse a colormap once per isolate. */
export function loadAlbedoMapper(url, { fetchImpl = fetch, signal } = {}) {
    let pending = mappers.get(url);
    if (!pending) {
        pending = (async () => {
            const { bytes } = await fetchBytes(url, { fetchImpl, signal, cacheTtl: 24 * 60 * 60 });
            const entries = parseColormap(new TextDecoder().decode(bytes));
            if (entries.filter((e) => e.reflectance > 0).length < 2) {
                throw new UpstreamError('The GIBS colormap has no usable optical thickness entries', { detail: url });
            }
            return new AlbedoMapper(entries);
        })();
        mappers.set(url, pending);
        pending.catch(() => mappers.delete(url)); // try again on the next request
    }
    return pending;
}
