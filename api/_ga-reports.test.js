import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseRange, registeredParams, movieKeys, missingDimensions, buildReports, toBatches } from './_ga-reports.js';

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

const ALL = new Set(['movie_title', 'item_name', 'category_name']);

test('buildReports runs the six built-in reports whatever is registered', () => {
    const names = buildReports(28, new Set()).map((report) => report.name);
    assert.deepEqual(names, ['totals', 'daily', 'countries', 'languages', 'osVersions', 'appVersions']);
});

test('buildReports adds movie and category reports only for registered dimensions', () => {
    // Asking GA for an unregistered dimension fails the whole batch.
    assert.deepEqual(buildReports(28, ALL).slice(6).map((r) => r.name), ['plays', 'clicks', 'categories']);
    assert.deepEqual(buildReports(28, new Set(['movie_title'])).slice(6).map((r) => r.name), ['plays']);
    assert.deepEqual(buildReports(28, new Set(['category_name'])).slice(6).map((r) => r.name), ['categories']);
});

test('buildReports uses the range from N days ago through yesterday', () => {
    for (const report of buildReports(7, ALL)) {
        assert.deepEqual(report.request.dateRanges, [{ startDate: '7daysAgo', endDate: 'yesterday' }], report.name);
    }
});

test('buildReports asks for the right fields', () => {
    const byName = Object.fromEntries(buildReports(28, ALL).map((r) => [r.name, r.request]));

    assert.deepEqual(byName.totals.metrics.map((m) => m.name),
        ['activeUsers', 'newUsers', 'sessions', 'userEngagementDuration']);
    assert.equal(byName.totals.dimensions, undefined);

    assert.deepEqual(byName.daily.dimensions, [{ name: 'date' }]);

    assert.deepEqual(byName.countries.dimensions, [{ name: 'country' }]);
    assert.equal(byName.countries.limit, 10);
    assert.deepEqual(byName.countries.orderBys, [{ metric: { metricName: 'activeUsers' }, desc: true }]);

    assert.deepEqual(byName.plays.dimensions, [{ name: 'eventName' }, { name: 'customEvent:movie_title' }]);
    assert.deepEqual(byName.plays.dimensionFilter,
        { filter: { fieldName: 'eventName', inListFilter: { values: ['video_start', 'video_complete'] } } });
    assert.equal(byName.plays.limit, undefined, 'movie reports return every row');

    assert.deepEqual(byName.clicks.dimensions, [{ name: 'customEvent:item_name' }]);
    assert.deepEqual(byName.clicks.dimensionFilter,
        { filter: { fieldName: 'eventName', stringFilter: { value: 'select_content' } } });

    assert.deepEqual(byName.categories.dimensions, [{ name: 'customEvent:category_name' }]);
    assert.deepEqual(byName.categories.dimensionFilter,
        { filter: { fieldName: 'eventName', stringFilter: { value: 'view_category' } } });
});

test('buildReports keys movies by id when only ids are registered', () => {
    const byName = Object.fromEntries(buildReports(28, new Set(['movie_id', 'item_id'])).map((r) => [r.name, r.request]));
    assert.deepEqual(byName.plays.dimensions, [{ name: 'eventName' }, { name: 'customEvent:movie_id' }]);
    assert.deepEqual(byName.clicks.dimensions, [{ name: 'customEvent:item_id' }]);
});

test('toBatches splits into groups of at most five', () => {
    // batchRunReports accepts at most 5 requests.
    const reports = buildReports(28, ALL);
    assert.deepEqual(toBatches(reports).map((batch) => batch.length), [5, 4]);
    assert.deepEqual(toBatches(buildReports(28, new Set())).map((b) => b.length), [5, 1]);
    assert.deepEqual(toBatches([]), []);
});
