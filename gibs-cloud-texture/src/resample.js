/* resample.js - separable image resampling for equirectangular textures.
 *
 * Uses a triangle filter widened by the shrink factor (the same scheme as Pillow's
 * BILINEAR resize): plain bilinear interpolation when enlarging, and an antialiased,
 * area-weighted average when shrinking, so a 1k texture made from level 3 tiles averages
 * every source pixel instead of skipping four out of five.
 *
 * Horizontally the image wraps at the antimeridian (column -1 is the last column), so the
 * seam at longitude +/-180 blends like any other column. Vertically, samples beyond the
 * poles are dropped and the remaining weights renormalised.
 */

/**
 * Precompute filter taps for resizing `inSize` pixels to `outSize`. The taps for output
 * pixel o are entries offsets[o] .. offsets[o + 1] - 1 of `index` (source pixel) and
 * `weight`; their source pixels are contiguous and in increasing order before wrapping.
 */
export function filterTaps(inSize, outSize, { wrap }) {
    const scale = inSize / outSize;           // source pixels per output pixel
    const radius = Math.max(scale, 1);        // triangle half-width, in source pixels
    const offsets = new Int32Array(outSize + 1);
    const index = [];
    const weight = [];
    let maxTaps = 0;

    for (let o = 0; o < outSize; o++) {
        const center = (o + 0.5) * scale;     // in source pixel coordinates
        const first = Math.floor(center - radius - 0.5);
        const last = Math.ceil(center + radius - 0.5);
        const start = index.length;
        let sum = 0;
        for (let i = first; i <= last; i++) {
            const w = 1 - Math.abs(i + 0.5 - center) / radius;
            if (w <= 0) continue;
            let src = i;
            if (wrap) {
                src = ((i % inSize) + inSize) % inSize;
            } else if (i < 0 || i >= inSize) {
                continue;
            }
            index.push(src);
            weight.push(w);
            sum += w;
        }
        for (let k = start; k < weight.length; k++) weight[k] /= sum;
        offsets[o + 1] = index.length;
        maxTaps = Math.max(maxTaps, index.length - start);
    }

    return {
        offsets,
        index: Int32Array.from(index),
        weight: Float32Array.from(weight),
        maxTaps
    };
}

/** Resample one row of RGBA floats (`src`, 4 values per pixel) into `dst` with `taps`. */
export function resampleRow(src, dst, taps) {
    const { offsets, index, weight } = taps;
    const outSize = offsets.length - 1;
    for (let o = 0, d = 0; o < outSize; o++, d += 4) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let k = offsets[o], end = offsets[o + 1]; k < end; k++) {
            const s = index[k] * 4;
            const w = weight[k];
            r += src[s] * w;
            g += src[s + 1] * w;
            b += src[s + 2] * w;
            a += src[s + 3] * w;
        }
        dst[d] = r;
        dst[d + 1] = g;
        dst[d + 2] = b;
        dst[d + 3] = a;
    }
}

/**
 * Blend horizontally resampled rows into one output row and convert it to straight-alpha
 * 8-bit RGBA. `rows[k]` is the row for tap k and `weights[k]` its weight. Rows hold
 * premultiplied floats (color already multiplied by alpha/255, everything on a 0-255
 * scale). `out` should be a Uint8ClampedArray, so values are rounded and clamped on
 * assignment. Pixels whose alpha rounds to 0 become 0,0,0,0.
 */
export function blendRows(rows, weights, out) {
    const taps = rows.length;
    const n = out.length;
    if (taps === 2) { // the common case when enlarging; worth its own loop
        const r0 = rows[0], r1 = rows[1], w0 = weights[0], w1 = weights[1];
        for (let i = 0; i < n; i += 4) {
            const a = r0[i + 3] * w0 + r1[i + 3] * w1;
            if (a < 0.5) {
                out[i] = out[i + 1] = out[i + 2] = out[i + 3] = 0;
                continue;
            }
            const s = 255 / a;
            out[i] = (r0[i] * w0 + r1[i] * w1) * s;
            out[i + 1] = (r0[i + 1] * w0 + r1[i + 1] * w1) * s;
            out[i + 2] = (r0[i + 2] * w0 + r1[i + 2] * w1) * s;
            out[i + 3] = a;
        }
        return;
    }
    for (let i = 0; i < n; i += 4) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let k = 0; k < taps; k++) {
            const row = rows[k], w = weights[k];
            r += row[i] * w;
            g += row[i + 1] * w;
            b += row[i + 2] * w;
            a += row[i + 3] * w;
        }
        if (a < 0.5) {
            out[i] = out[i + 1] = out[i + 2] = out[i + 3] = 0;
            continue;
        }
        const s = 255 / a;
        out[i] = r * s;
        out[i + 1] = g * s;
        out[i + 2] = b * s;
        out[i + 3] = a;
    }
}

/* ------------------------------------------------------------ single-channel versions */

/** resampleRow for one float per pixel. */
export function resampleValues(src, dst, taps) {
    const { offsets, index, weight } = taps;
    const outSize = offsets.length - 1;
    for (let o = 0; o < outSize; o++) {
        let v = 0;
        for (let k = offsets[o], end = offsets[o + 1]; k < end; k++) v += src[index[k]] * weight[k];
        dst[o] = v;
    }
}

/**
 * blendRows for one float per pixel holding a value in 0-1 (reflectance). Writes it to 8 bits
 * as sqrt(value) * 255, which spends more of the 256 levels on thin clouds; decode with
 * v * v. `out` should be a Uint8ClampedArray.
 */
export function blendValues(rows, weights, out) {
    const taps = rows.length;
    const n = out.length;
    if (taps === 2) {
        const r0 = rows[0], r1 = rows[1], w0 = weights[0], w1 = weights[1];
        for (let i = 0; i < n; i++) {
            const v = r0[i] * w0 + r1[i] * w1;
            out[i] = v > 0 ? Math.sqrt(v) * 255 : 0;
        }
        return;
    }
    for (let i = 0; i < n; i++) {
        let v = 0;
        for (let k = 0; k < taps; k++) v += rows[k][i] * weights[k];
        out[i] = v > 0 ? Math.sqrt(v) * 255 : 0;
    }
}
