import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseRange, registeredParams, movieKeys, missingDimensions, buildReports, toBatches, parseRows, fillDaily, shapeAnalytics } from './_ga-reports.js';

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

// One GA report row: dimension strings, metric strings.
const row = (dims, values) => ({
    dimensionValues: dims.map((value) => ({ value })),
    metricValues: values.map((value) => ({ value: String(value) }))
});

test('parseRows turns GA rows into strings and numbers', () => {
    const report = { rows: [row(['Myanmar'], ['120']), row(['India'], ['7'])] };
    assert.deepEqual(parseRows(report), [
        { dims: ['Myanmar'], values: [120] },
        { dims: ['India'], values: [7] }
    ]);
});

test('parseRows survives an empty or malformed report', () => {
    assert.deepEqual(parseRows(undefined), []);
    assert.deepEqual(parseRows({}), []);
    assert.deepEqual(parseRows({ rows: [{}] }), [{ dims: [], values: [] }]);
    assert.deepEqual(parseRows({ rows: [row(['x'], ['not a number'])] }), [{ dims: ['x'], values: [0] }]);
});

test('fillDaily fills days GA left out, so the chart never joins across a gap', () => {
    const rows = [
        { dims: ['20260903'], values: [5] },
        { dims: ['20260901'], values: [3] }
    ];
    assert.deepEqual(fillDaily(rows), [
        { date: '2026-09-01', activeUsers: 3 },
        { date: '2026-09-02', activeUsers: 0 },
        { date: '2026-09-03', activeUsers: 5 }
    ]);
    assert.deepEqual(fillDaily([]), []);
});

test('fillDaily crosses month and year ends', () => {
    const filled = fillDaily([{ dims: ['20251231'], values: [1] }, { dims: ['20260102'], values: [2] }]);
    assert.deepEqual(filled.map((d) => d.date), ['2025-12-31', '2026-01-01', '2026-01-02']);
});

// Builds GA-shaped responses in the order buildReports produced the reports.
function responsesFor(reports, rowsByName, metadataByName = {}) {
    return reports.map((report) => ({
        rows: rowsByName[report.name] || [],
        metadata: metadataByName[report.name] || {}
    }));
}

test('shapeAnalytics assembles the full response', () => {
    const reports = buildReports(28, ALL);
    const responses = responsesFor(reports, {
        totals: [row([], [480, 120, 900, 43200])],
        daily: [row(['20260901'], [30]), row(['20260902'], [34])],
        countries: [row(['Myanmar'], [300]), row(['(not set)'], [4])],
        languages: [row(['Burmese'], [250])],
        osVersions: [row(['14'], [200])],
        appVersions: [row(['2.1'], [410])],
        plays: [
            row(['video_start', 'Terra Nova'], [40]),
            row(['video_complete', 'Terra Nova'], [18]),
            row(['video_start', '(not set)'], [9])
        ],
        clicks: [row(['Terra Nova'], [55]), row(['Luck Key'], [12])],
        categories: [row(['Action'], [70]), row(['(not set)'], [3])]
    });

    assert.deepEqual(shapeAnalytics({ days: 28, params: ALL, reports, responses }), {
        range: 28,
        audience: {
            activeUsers: 480, newUsers: 120, sessions: 900, engagementSeconds: 43200,
            daily: [{ date: '2026-09-01', activeUsers: 30 }, { date: '2026-09-02', activeUsers: 34 }]
        },
        where: {
            countries: [{ name: 'Myanmar', users: 300 }, { name: '(not set)', users: 4 }],
            languages: [{ name: 'Burmese', users: 250 }],
            osVersions: [{ name: '14', users: 200 }],
            appVersions: [{ name: '2.1', users: 410 }]
        },
        movies: {
            key: 'title',
            clicks: { 'Terra Nova': 55, 'Luck Key': 12 },
            plays: { 'Terra Nova': 40 },
            completes: { 'Terra Nova': 18 }
        },
        categories: [{ name: 'Action', views: 70 }],
        missingDimensions: [],
        notes: { thresholded: false, otherRow: false }
    });
});

test('shapeAnalytics drops "(not set)" from movie and category figures', () => {
    // Events logged before a dimension was registered come back as "(not set)".
    const reports = buildReports(28, ALL);
    const shaped = shapeAnalytics({ days: 28, params: ALL, reports, responses: responsesFor(reports, {
        plays: [row(['video_start', '(not set)'], [9]), row(['video_start', ''], [2])],
        categories: [row(['(not set)'], [3])]
    }) });
    assert.deepEqual(shaped.movies.plays, {});
    assert.deepEqual(shaped.categories, []);
});

test('shapeAnalytics leaves out what is not registered', () => {
    const params = new Set(['movie_title']);
    const reports = buildReports(28, params);
    const shaped = shapeAnalytics({ days: 28, params, reports, responses: responsesFor(reports, {}) });
    assert.equal(shaped.movies.clicks, null);
    assert.equal(shaped.categories, null);
    assert.deepEqual(shaped.missingDimensions, ['item_name', 'category_name']);

    const none = new Set();
    const bare = shapeAnalytics({ days: 7, params: none, reports: buildReports(7, none),
        responses: responsesFor(buildReports(7, none), {}) });
    assert.equal(bare.movies, null);
    assert.equal(bare.categories, null);
});

test('shapeAnalytics reports zeros, not undefined, for an empty property', () => {
    const reports = buildReports(28, new Set());
    const shaped = shapeAnalytics({ days: 28, params: new Set(), reports, responses: responsesFor(reports, {}) });
    assert.deepEqual(shaped.audience, { activeUsers: 0, newUsers: 0, sessions: 0, engagementSeconds: 0, daily: [] });
    assert.deepEqual(shaped.where.countries, []);
});

test('shapeAnalytics surfaces thresholding and the (other) row from any report', () => {
    const reports = buildReports(28, new Set());
    const shaped = shapeAnalytics({ days: 28, params: new Set(), reports, responses: responsesFor(reports, {}, {
        countries: { subjectToThresholding: true },
        languages: { dataLossFromOtherRow: true }
    }) });
    assert.deepEqual(shaped.notes, { thresholded: true, otherRow: true });
});
