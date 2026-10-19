import test from 'node:test';
import assert from 'node:assert/strict';
import { storeStream } from '../src/store.js';
import { fakeR2 } from './helpers.js';

function streamOf(chunks, { failAfter } = {}) {
    let i = 0;
    return new ReadableStream({
        pull(controller) {
            if (failAfter !== undefined && i === failAfter) return controller.error(new Error('texture failed'));
            if (i === chunks.length) return controller.close();
            controller.enqueue(new Uint8Array(chunks[i++]));
        }
    });
}

const bytes = (n, start = 0) => Array.from({ length: n }, (_, i) => (start + i) & 255);

test('small results are written with a single put', async () => {
    const r2 = fakeR2();
    await storeStream(r2, 'k', streamOf([bytes(4), bytes(3, 4)]), { customMetadata: { a: '1' } }, 10);
    assert.deepEqual(r2.ops.map((o) => o[0]), ['put']);
    assert.deepEqual([...r2.objects.get('k').body], bytes(7));
    assert.equal(r2.objects.get('k').customMetadata.a, '1');
});

test('larger results go up in equal parts as they arrive, then the remainder', async () => {
    const r2 = fakeR2();
    const chunks = [bytes(7), bytes(13, 7), bytes(1, 20), bytes(14, 21)]; // 35 bytes, uneven chunks
    await storeStream(r2, 'k', streamOf(chunks), {}, 10);
    const parts = r2.ops.filter((o) => o[0] === 'part').map((o) => o[3]);
    assert.deepEqual(parts, [10, 10, 10, 5]);
    assert.deepEqual([...r2.objects.get('k').body], bytes(35));
    // an exact multiple of the part size has no short final part
    await storeStream(r2, 'j', streamOf([bytes(20)]), {}, 10);
    assert.deepEqual([...r2.objects.get('j').body], bytes(20));
});

test('a stream that fails stores nothing and aborts the upload', async () => {
    const r2 = fakeR2();
    await assert.rejects(storeStream(r2, 'k', streamOf([bytes(10), bytes(10), bytes(10)], { failAfter: 2 }), {}, 10),
        /texture failed/);
    assert.equal(r2.objects.has('k'), false);
    assert.ok(r2.ops.some((o) => o[0] === 'abort'));
    await assert.rejects(storeStream(r2, 'm', streamOf([bytes(3)], { failAfter: 1 }), {}, 10), /texture failed/);
    assert.equal(r2.objects.has('m'), false);
});
