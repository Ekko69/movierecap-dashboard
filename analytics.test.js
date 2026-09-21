import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    normalizeTitle, rangeBounds, commentsInRange,
    formatCompact, formatCount, formatPercent, formatDuration
} from './analytics.js';

test('normalizeTitle ignores surrounding spaces', () => {
    // 8 library titles carry stray leading or trailing spaces.
    assert.equal(normalizeTitle('  Terra Nova '), 'Terra Nova');
    assert.equal(normalizeTitle('Terra Nova'), 'Terra Nova');
    assert.equal(normalizeTitle(null), '');
    assert.equal(normalizeTitle(undefined), '');
    assert.equal(normalizeTitle(1917), '1917');
});

test('rangeBounds covers N whole days ending at the start of today', () => {
    // npm test runs with TZ=UTC, so local midnight is UTC midnight here.
    const now = Date.UTC(2026, 8, 21, 15, 30);
    assert.deepEqual(rangeBounds(28, now), {
        startMs: Date.UTC(2026, 7, 24),
        endMs: Date.UTC(2026, 8, 21)
    });
    assert.deepEqual(rangeBounds(7, now), {
        startMs: Date.UTC(2026, 8, 14),
        endMs: Date.UTC(2026, 8, 21)
    });
});

test('commentsInRange counts per movie inside the range only', () => {
    const start = 1000;
    const end = 2000;
    const rows = [
        { movieId: 'a', timestamp: 999 },     // before
        { movieId: 'a', timestamp: 1000 },    // first instant counts
        { movieId: 'a', timestamp: 1500 },
        { movieId: 'b', timestamp: 1999 },
        { movieId: 'b', timestamp: 2000 },    // end is exclusive: that is today
        { movieId: 'c', timestamp: 'junk' }
    ];
    const counts = commentsInRange(rows, start, end);
    assert.equal(counts.get('a'), 2);
    assert.equal(counts.get('b'), 1);
    assert.equal(counts.has('c'), false);
    assert.equal(commentsInRange(null, start, end).size, 0);
});

test('formatCompact is exact below ten thousand and compact above', () => {
    assert.equal(formatCompact(0), '0');
    assert.equal(formatCompact(1284), '1,284');
    assert.equal(formatCompact(9999), '9,999');
    assert.equal(formatCompact(12900), '12.9K');
    assert.equal(formatCompact(4200000), '4.2M');
    assert.equal(formatCompact(undefined), '0');
});

test('formatCount groups thousands', () => {
    assert.equal(formatCount(1234567), '1,234,567');
    assert.equal(formatCount(3.6), '4');
    assert.equal(formatCount(null), '0');
});

test('formatPercent shows a dash when there is nothing to divide by', () => {
    assert.equal(formatPercent(0.4166), '42%');
    assert.equal(formatPercent(0), '0%');
    assert.equal(formatPercent(null), '—');
    assert.equal(formatPercent(NaN), '—');
});

test('formatDuration reads as seconds, minutes or hours', () => {
    assert.equal(formatDuration(45), '45s');
    assert.equal(formatDuration(134), '2m 14s');
    assert.equal(formatDuration(3780), '1h 3m');
    assert.equal(formatDuration(0), '0s');
    assert.equal(formatDuration(-5), '0s');
    assert.equal(formatDuration(undefined), '0s');
});
