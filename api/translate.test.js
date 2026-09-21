import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseTranslationResponse } from './translate.js';

test('parseTranslationResponse reads a clean JSON object', () => {
    const raw = '{"items":[{"id":"c1","lang":"my","text":"Please translate it"}]}';
    assert.deepEqual(parseTranslationResponse(raw), [
        { id: 'c1', lang: 'my', text: 'Please translate it' }
    ]);
});

test('parseTranslationResponse strips a markdown code fence', () => {
    const raw = '```json\n{"items":[{"id":"c1","lang":"en","text":"hi"}]}\n```';
    assert.deepEqual(parseTranslationResponse(raw), [
        { id: 'c1', lang: 'en', text: 'hi' }
    ]);
});

test('parseTranslationResponse digs the object out of surrounding prose', () => {
    const raw = 'Sure! Here you go:\n{"items":[{"id":"c1","lang":"ar","text":"hello"}]}\nHope that helps.';
    assert.deepEqual(parseTranslationResponse(raw), [
        { id: 'c1', lang: 'ar', text: 'hello' }
    ]);
});

test('parseTranslationResponse drops entries with no usable id', () => {
    const raw = '{"items":[{"id":"c1","lang":"en","text":"ok"},{"lang":"en","text":"orphan"},null]}';
    assert.deepEqual(parseTranslationResponse(raw), [
        { id: 'c1', lang: 'en', text: 'ok' }
    ]);
});

test('parseTranslationResponse defaults missing lang and text', () => {
    const raw = '{"items":[{"id":"c1"}]}';
    assert.deepEqual(parseTranslationResponse(raw), [
        { id: 'c1', lang: 'unknown', text: '' }
    ]);
});

test('parseTranslationResponse preserves non-Latin text intact', () => {
    // The whole point of the endpoint: the text must survive JSON round-trip.
    const raw = JSON.stringify({ items: [{ id: 'c1', lang: 'en', text: 'ဘာသာပြန်ပေးပါ 💜' }] });
    assert.equal(parseTranslationResponse(raw)[0].text, 'ဘာသာပြန်ပေးပါ 💜');
});

test('parseTranslationResponse handles an empty items array', () => {
    assert.deepEqual(parseTranslationResponse('{"items":[]}'), []);
});

test('parseTranslationResponse throws a describable error on junk', () => {
    assert.throws(() => parseTranslationResponse(''), /empty response/);
    assert.throws(() => parseTranslationResponse(null), /empty response/);
    assert.throws(() => parseTranslationResponse('no json at all'), /no JSON object/);
    assert.throws(() => parseTranslationResponse('{"items": [oops}'), /invalid JSON/);
    assert.throws(() => parseTranslationResponse('{"nope":1}'), /no items array/);
});
