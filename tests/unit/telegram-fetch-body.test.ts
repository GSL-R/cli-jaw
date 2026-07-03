import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { requiresNativeFetchBody } from '../../src/telegram/fetch-body.js';

test('multipart and streaming bodies bypass the JSON-only IPv4 adapter', () => {
    class MultipartReadable extends Readable {
        _read() {
            this.push('image');
            this.push(null);
        }
    }

    assert.equal(requiresNativeFetchBody(new FormData()), true);
    assert.equal(requiresNativeFetchBody(new Blob(['image'])), true);
    assert.equal(requiresNativeFetchBody(Readable.from(['image'])), true);
    assert.equal(requiresNativeFetchBody(new MultipartReadable()), true);
    assert.equal(requiresNativeFetchBody({ pipe() {} }), true);
    assert.equal(requiresNativeFetchBody(new ReadableStream()), false);
});

test('plain JSON-compatible bodies keep using the IPv4 adapter', () => {
    assert.equal(requiresNativeFetchBody({ message: 'hello' }), false);
    assert.equal(requiresNativeFetchBody('text'), false);
    assert.equal(requiresNativeFetchBody(null), false);
});
