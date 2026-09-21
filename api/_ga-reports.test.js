import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseRange, registeredParams, movieKeys, missingDimensions } from './_ga-reports.js';

test('parseRange accepts only the three offered ranges', () => {
    assert.equal(parseRange('7'), 7);
    assert.equal(parseRange('28'), 28);
    assert.equal(parseRange(90), 90);
    for (const bad of ['0', '30', '-7', 'abc', '', undefined, null, '28days']) {
        assert.equal(parseRange(bad), null, `accepted ${JSON.stringify(bad)}`);
    }
});

test('registeredParams reads custom dimensions from the metadata', () => {
    const metadata = { dimensions: [
        { apiName: 'date' },
        { apiName: 'customEvent:movie_title' },
        { apiName: 'customEvent:category_name' },
        { apiName: 'customUser:plan' },
        { apiName: 42 },
        null
    ] };
    assert.deepEqual([...registeredParams(metadata)].sort(), ['category_name', 'movie_title']);
});

test('registeredParams survives empty or malformed metadata', () => {
    assert.equal(registeredParams(null).size, 0);
    assert.equal(registeredParams({}).size, 0);
    assert.equal(registeredParams({ dimensions: 'nope' }).size, 0);
});

test('movieKeys prefers titles, which carry history', () => {
    const params = new Set(['movie_title', 'item_name', 'movie_id', 'item_id']);
    assert.deepEqual(movieKeys(params), { key: 'title', plays: 'movie_title', clicks: 'item_name' });
});

test('movieKeys falls back to ids only without titles', () => {
    assert.deepEqual(movieKeys(new Set(['movie_id', 'item_id'])), { key: 'id', plays: 'movie_id', clicks: 'item_id' });
});

test('movieKeys never mixes a title key with id clicks', () => {
    // Clicks must share the plays key kind, or the two could never join.
    assert.deepEqual(movieKeys(new Set(['movie_title', 'item_id'])), { key: 'title', plays: 'movie_title', clicks: null });
    assert.deepEqual(movieKeys(new Set(['movie_id', 'item_name'])), { key: 'id', plays: 'movie_id', clicks: null });
});

test('movieKeys has no key without a plays dimension', () => {
    assert.deepEqual(movieKeys(new Set(['item_name'])), { key: null, plays: null, clicks: null });
});

test('missingDimensions names what to register, preferring titles', () => {
    assert.deepEqual(missingDimensions(new Set()), ['movie_title', 'item_name', 'category_name']);
    assert.deepEqual(missingDimensions(new Set(['movie_title'])), ['item_name', 'category_name']);
    assert.deepEqual(missingDimensions(new Set(['movie_id'])), ['item_id', 'category_name']);
    assert.deepEqual(missingDimensions(new Set(['item_name', 'category_name'])), ['movie_title']);
    assert.deepEqual(missingDimensions(new Set(['movie_title', 'item_name', 'category_name'])), []);
});
