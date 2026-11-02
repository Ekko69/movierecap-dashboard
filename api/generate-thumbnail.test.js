import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import handler from './generate-thumbnail.js';

const realFetch = globalThis.fetch;
const realKey = process.env.OPENAI_API_KEY;

function fakeRes() {
    return {
        statusCode: 200,
        body: undefined,
        setHeader() {},
        status(code) { this.statusCode = code; return this; },
        json(data) { this.body = data; return this; },
        end() { return this; }
    };
}

function jsonResponse(status, data) {
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const post = (body) => ({ method: 'POST', body });
const vision = () => jsonResponse(200, { choices: [{ message: { content: 'A man on a roof' } }] });

beforeEach(() => { process.env.OPENAI_API_KEY = 'test-key'; });
afterEach(() => {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = realKey;
});

test('generates with gpt-image-2.5-flare and returns a jpeg data URL', async () => {
    const calls = [];
    globalThis.fetch = async (url, init) => {
        calls.push({ url, init });
        if (url.endsWith('/chat/completions')) return vision();
        return jsonResponse(200, { data: [{ b64_json: 'QUJD' }] });
    };

    const res = fakeRes();
    await handler(post({ thumbnailUrl: 'https://img.test/a.jpg' }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { imageUrl: 'data:image/jpeg;base64,QUJD' });

    assert.deepEqual(calls.map(c => c.url), [
        'https://api.openai.com/v1/chat/completions',
        'https://api.openai.com/v1/images/generations'
    ]);
    const sent = JSON.parse(calls[1].init.body);
    assert.equal(sent.model, 'gpt-image-2.5-flare');
    assert.equal(sent.size, '2048x1152');
    assert.equal(sent.output_format, 'jpeg');
    assert.match(sent.prompt, /A man on a roof/);
    assert.match(sent.prompt, /master photorealistic image renderer/);
});

test('needs no fal key', async () => {
    const saved = process.env.FAL_API_KEY;
    delete process.env.FAL_API_KEY;
    globalThis.fetch = async (url) => url.endsWith('/chat/completions')
        ? vision()
        : jsonResponse(200, { data: [{ b64_json: 'QUJD' }] });

    const res = fakeRes();
    await handler(post({ thumbnailUrl: 'https://img.test/a.jpg' }), res);
    if (saved !== undefined) process.env.FAL_API_KEY = saved;

    assert.equal(res.statusCode, 200);
});

test('surfaces the OpenAI error message', async () => {
    globalThis.fetch = async (url) => url.endsWith('/chat/completions')
        ? vision()
        : jsonResponse(403, { error: { message: 'Your organization must be verified' } });

    const res = fakeRes();
    await handler(post({ thumbnailUrl: 'https://img.test/a.jpg' }), res);

    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error, 'Your organization must be verified');
});

test('fails clearly when no image comes back', async () => {
    globalThis.fetch = async (url) => url.endsWith('/chat/completions')
        ? vision()
        : jsonResponse(200, { data: [] });

    const res = fakeRes();
    await handler(post({ thumbnailUrl: 'https://img.test/a.jpg' }), res);

    assert.equal(res.statusCode, 500);
    assert.match(res.body.error, /No image returned/);
});
