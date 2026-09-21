import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    normalizeTitle, rangeBounds, commentsInRange,
    formatCompact, formatCount, formatPercent, formatDuration, buildMovieRows
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

const LIBRARY = [
    { id: 'm1', title: 'Terra Nova', thumbnail: 'https://img/1.jpg' },
    { id: 'm2', title: 'Luck Key', thumbnail: 'https://img/2.jpg' },
    { id: 'm3', title: 'The Night Clerk', thumbnail: 'https://img/3a.jpg' },
    { id: 'm4', title: 'The Night Clerk', thumbnail: 'https://img/3b.jpg' },
    { id: 'm5', title: ' Lockout ', thumbnail: null },
    { id: 'm6', title: 'Quiet Film', thumbnail: null }
];

const titles = (list) => list.map((row) => row.title);

test('buildMovieRows ranks titles by plays, then clicks, then name', () => {
    const { rows } = buildMovieRows({
        key: 'title',
        clicks: { 'Luck Key': 90, 'Terra Nova': 10, 'Lockout': 5 },
        plays: { 'Terra Nova': 40, 'Luck Key': 40, 'Lockout': 3 },
        completes: { 'Terra Nova': 18 }
    }, LIBRARY);
    assert.deepEqual(titles(rows), ['Luck Key', 'Terra Nova', 'Lockout']);
    assert.deepEqual(rows[1], {
        key: 'Terra Nova', title: 'Terra Nova', thumbnail: 'https://img/1.jpg', copies: 1,
        clicks: 10, plays: 40, completes: 18, completionRate: 0.45, comments: 0
    });
});

test('buildMovieRows gives a shared title one row with combined figures', () => {
    // GA records only the title, so it cannot say which copy was watched.
    const comments = new Map([['m3', 2], ['m4', 1]]);
    const { rows } = buildMovieRows({ key: 'title', clicks: null, plays: { 'The Night Clerk': 12 }, completes: {} }, LIBRARY, comments);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].copies, 2);
    assert.equal(rows[0].thumbnail, 'https://img/3a.jpg');
    assert.equal(rows[0].plays, 12);
    assert.equal(rows[0].comments, 3, "both copies' comments count");
});

test('buildMovieRows matches titles with stray spaces on either side', () => {
    const { rows, notInLibrary } = buildMovieRows({
        key: 'title', clicks: null,
        plays: { 'Lockout': 4, 'Lockout ': 1, ' Terra Nova': 2 },
        completes: {}
    }, LIBRARY);
    assert.deepEqual(rows.map((row) => [row.title, row.plays]), [['Lockout', 5], ['Terra Nova', 2]]);
    assert.deepEqual(notInLibrary, []);
});

test('buildMovieRows shows no completion rate without plays', () => {
    const { rows } = buildMovieRows({ key: 'title', clicks: { 'Luck Key': 7 }, plays: {}, completes: {} }, LIBRARY);
    // Clicked but never played still earns a row: that gap is worth seeing.
    assert.equal(rows[0].title, 'Luck Key');
    assert.equal(rows[0].plays, 0);
    assert.equal(rows[0].completionRate, null);
});

test('buildMovieRows lists titles with no plays, alphabetically', () => {
    const { neverPlayed } = buildMovieRows({
        key: 'title', clicks: { 'Luck Key': 7 }, plays: { 'Terra Nova': 1 }, completes: {}
    }, LIBRARY);
    assert.deepEqual(titles(neverPlayed), ['Lockout', 'Luck Key', 'Quiet Film', 'The Night Clerk']);
    assert.equal(neverPlayed.find((row) => row.title === 'The Night Clerk').copies, 2);
});

test('buildMovieRows lists titles GA has but the library does not', () => {
    // Renamed or removed movies keep their history in GA.
    const { notInLibrary } = buildMovieRows({
        key: 'title',
        clicks: { 'Old Name': 4, 'Gone Movie': 9 },
        plays: { 'Old Name': 20, 'Terra Nova': 3 },
        completes: {}
    }, LIBRARY);
    assert.deepEqual(notInLibrary, [
        { key: 'Old Name', plays: 20, clicks: 4 },
        { key: 'Gone Movie', plays: 0, clicks: 9 }
    ]);
});

test('buildMovieRows ignores "(not set)" and empty keys', () => {
    const { rows, notInLibrary } = buildMovieRows({
        key: 'title', clicks: null, plays: { '(not set)': 50, '': 3, 'Terra Nova': 1 }, completes: {}
    }, LIBRARY);
    assert.deepEqual(titles(rows), ['Terra Nova']);
    assert.deepEqual(notInLibrary, []);
});

test('buildMovieRows reports clicks as null when they are not registered', () => {
    const { rows } = buildMovieRows({ key: 'title', clicks: null, plays: { 'Terra Nova': 2 }, completes: {} }, LIBRARY);
    assert.equal(rows[0].clicks, null);
});

test('buildMovieRows joins by id when GA is keyed by id', () => {
    const { rows, notInLibrary } = buildMovieRows({
        key: 'id', clicks: null, plays: { m3: 5, m4: 2, gone: 1 }, completes: { m3: 5 }
    }, LIBRARY);
    // By id the two Night Clerk copies are told apart.
    assert.deepEqual(rows.map((row) => [row.key, row.plays, row.copies]), [['m3', 5, 1], ['m4', 2, 1]]);
    assert.equal(rows[0].title, 'The Night Clerk');
    assert.deepEqual(notInLibrary, [{ key: 'gone', plays: 1, clicks: null }]);
});

test('buildMovieRows takes the thumbnail from whichever copy has one', () => {
    const library = [
        { id: 'a', title: 'Twin', thumbnail: null },
        { id: 'b', title: 'Twin', thumbnail: 'https://img/b.jpg' }
    ];
    const { rows } = buildMovieRows({ key: 'title', clicks: null, plays: { Twin: 1 }, completes: {} }, library);
    assert.equal(rows[0].thumbnail, 'https://img/b.jpg');
});

test('buildMovieRows survives empty input', () => {
    assert.deepEqual(buildMovieRows({ key: 'title', clicks: null, plays: {}, completes: {} }, []),
        { rows: [], neverPlayed: [], notInLibrary: [] });
    assert.deepEqual(buildMovieRows(null, null).rows, []);
});
