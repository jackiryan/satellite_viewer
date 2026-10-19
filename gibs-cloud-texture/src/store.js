/* store.js - finished textures kept in R2.
 *
 * R2 keeps objects until they are deleted and serves them from anywhere, unlike the Cache API,
 * which holds entries per data center and drops ones that go unused (and does nothing on
 * workers.dev). With little traffic most cache entries were gone by the next visit; textures in
 * R2 are still there.
 *
 * Objects are only written once a texture has been produced in full: the PNG is streamed into
 * a multipart upload that is completed at the end and aborted if anything fails, so a cut-short
 * texture is never stored.
 */

// Everything this Worker stores is under this folder, so the bucket can also hold other data:
// the scheduled clean-up (prewarm.js) only ever lists and deletes objects under it.
export const STORE_NAMESPACE = 'cloud-texture/';

// Bump to set aside every stored texture after changing how textures are made. Objects under
// other versions are deleted by the scheduled clean-up.
export const STORE_VERSION = '3';

// R2 multipart parts must all be the same size (at least 5 MiB) except the last one
const PART_SIZE = 8 * 1024 * 1024;

export function storePrefix(config) {
    return `${STORE_NAMESPACE}v${STORE_VERSION}/${config.layer}/${config.tileMatrixSet}/`;
}

export function textureKey(config, { date, tileMatrix, outputRes, product }) {
    return `${storePrefix(config)}${product}/tm${tileMatrix}/${outputRes}/${date}.png`;
}

/**
 * Write a stream to R2 under `key`. Small results are written with a single put; larger
 * ones go up in PART_SIZE parts as they arrive, so at most one part is held in memory.
 * If the stream errors, nothing is stored and the error is rethrown.
 */
export async function storeStream(bucket, key, stream, options = {}, partSize = PART_SIZE) {
    const reader = stream.getReader();
    let buffer = new Uint8Array(partSize);
    let filled = 0;
    let upload = null;
    const parts = [];
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            for (let offset = 0; offset < value.length;) {
                const count = Math.min(value.length - offset, partSize - filled);
                buffer.set(value.subarray(offset, offset + count), filled);
                filled += count;
                offset += count;
                if (filled === partSize) {
                    upload ??= await bucket.createMultipartUpload(key, options);
                    parts.push(await upload.uploadPart(parts.length + 1, buffer));
                    buffer = new Uint8Array(partSize);
                    filled = 0;
                }
            }
        }
        if (!upload) return await bucket.put(key, buffer.subarray(0, filled), options);
        if (filled > 0) parts.push(await upload.uploadPart(parts.length + 1, buffer.subarray(0, filled)));
        return await upload.complete(parts);
    } catch (error) {
        reader.cancel(error).catch(() => {});
        if (upload) await upload.abort().catch(() => {});
        throw error;
    }
}

/** R2 metadata for a finished texture: what it shows, and when it was made. */
export function textureMetadata({ date, tileMatrix, outputRes, product }, texture, now = Date.now()) {
    return {
        httpMetadata: { contentType: 'image/png' },
        customMetadata: {
            sourceDate: date,
            tileMatrix: String(tileMatrix),
            outputRes,
            product,
            sourceSize: `${texture.grid.width}x${texture.grid.height}`,
            textureSize: `${texture.width}x${texture.height}`,
            generatedAt: new Date(now).toISOString()
        }
    };
}
