# Analytics Section Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Analytics section to the dashboard that reads the Android app's Google Analytics data through the GA4 Data API and shows audience, per-title movie performance, categories and devices, matched to the movie library.

**Architecture:** A Vercel function, `api/analytics.js`, authenticates with a service account (`google-auth-library`), asks GA which custom dimensions exist, runs up to nine reports in two `batchRunReports` calls, and returns one JSON document. Pure logic lives in two tested modules — `api/_ga-reports.js` (report definitions and response parsing) and `analytics.js` (joining GA titles to the library) — while `analytics-view.js` only turns their output into DOM. The two-view router becomes a three-view router driven by one `data-view` attribute.

**Tech Stack:** Vanilla ES modules with no build step, Firebase Realtime Database, Vercel serverless functions, GA4 Data API v1beta over REST, `google-auth-library`, `node --test`.

**Spec:** `docs/superpowers/specs/2026-09-21-analytics-dashboard-design.md`

---

## Ground rules for every task

- **Never bind port 3000.** The user's own dev server runs there. Browser checks use the harness on :3055.
- **Every string from GA or the database goes into the DOM through `textContent`,** never `innerHTML`. Titles, country names and category names are untrusted.
- **`node --check app.js`** before saving an edit to it: the user's live server serves it from disk.
- **Commit messages end with** `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **Chart rules** (from the dataviz skill; the palette was validated): one series colour, `var(--color-accent)` (`#bd369e`), which passes every check on the card surface `#2f1e43`. Chart text uses `--text-secondary` (6.5:1 on the card) — never `--text-muted` (2.6:1, too faint for text). Bars are at most 24px thick with a 4px rounded end and a square base; lines are 2px; gridlines are 1px solid `rgba(255,255,255,0.08)`. Tile values use proportional figures; table columns use `tabular-nums`.

## File structure

| File | Status | Responsibility |
|---|---|---|
| `api/_ga-reports.js` | Create | Which reports to run for the registered dimensions, and turning GA's responses into the endpoint's JSON. Pure. |
| `api/_ga-reports.test.js` | Create | Tests for the above. |
| `api/analytics.js` | Create | The endpoint: config, auth, metadata cache, batching, status codes. Dependencies injected. |
| `api/analytics.test.js` | Create | The handler with a fake token and a stubbed `fetch`. |
| `analytics.js` | Create | Joining GA titles (or ids) to the library, shared titles, never played, comments in range, number formatting. Pure. |
| `analytics.test.js` | Create | Tests for the above. |
| `analytics-view.js` | Create | The Analytics view's DOM: states, tiles, line chart, bar lists, movie table. Browser only. |
| `index.html` | Modify | `data-view` on `<main>`, the nav item, the view's markup. |
| `style.css` | Modify | Three-view routing rules; analytics styles. |
| `app.js` | Modify | Generalized router; creates the analytics view and re-renders it when movies or comments change. |
| `dev-server.js` | Modify | Startup log line. |
| `package.json` | Modify | `google-auth-library`. |

---

### Task 1: Ranges and registered dimensions

**Files:**
- Create: `api/_ga-reports.js`
- Create: `api/_ga-reports.test.js`

- [ ] **Step 1: Write the failing test**

Create `api/_ga-reports.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './_ga-reports.js'`

- [ ] **Step 3: Write minimal implementation**

Create `api/_ga-reports.js`:

```js
// Which reports to run against the GA4 Data API, and how to turn what it sends
// back into the endpoint's JSON. No I/O, so every rule here is unit-tested.
//
// The leading underscore keeps Vercel from deploying this as an endpoint, the
// same convention as _ytdlp.js.

export const RANGES = [7, 28, 90];

// The range in days, or null for anything the picker cannot send.
export function parseRange(value) {
    if (value === null || value === undefined || value === '') return null;
    const days = Number(value);
    return RANGES.includes(days) ? days : null;
}

// Parameter names registered as event-scoped custom dimensions, read from the
// property's metadata: "customEvent:movie_title" becomes "movie_title".
export function registeredParams(metadata) {
    const params = new Set();
    const dimensions = Array.isArray(metadata?.dimensions) ? metadata.dimensions : [];
    for (const dimension of dimensions) {
        const name = dimension?.apiName;
        if (typeof name === 'string' && name.startsWith('customEvent:')) {
            params.add(name.slice('customEvent:'.length));
        }
    }
    return params;
}

// Which dimensions identify a movie. Titles win: they are what the admin
// registered and what has history — ids would only start from registration.
// Clicks use the same kind of key as plays, so the two always join.
export function movieKeys(params) {
    if (params.has('movie_title')) {
        return { key: 'title', plays: 'movie_title', clicks: params.has('item_name') ? 'item_name' : null };
    }
    if (params.has('movie_id')) {
        return { key: 'id', plays: 'movie_id', clicks: params.has('item_id') ? 'item_id' : null };
    }
    return { key: null, plays: null, clicks: null };
}

// What the admin should register, by the parameter name they type into GA4.
// Where a title or an id would do, the title is named.
export function missingDimensions(params) {
    const keys = movieKeys(params);
    const missing = [];

    if (!keys.plays) {
        missing.push('movie_title');
        if (!params.has('item_name') && !params.has('item_id')) missing.push('item_name');
    } else if (!keys.clicks) {
        missing.push(keys.key === 'title' ? 'item_name' : 'item_id');
    }

    if (!params.has('category_name')) missing.push('category_name');
    return missing;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — 8 new tests, 116 total, 0 failing.

- [ ] **Step 5: Commit**

```bash
git add api/_ga-reports.js api/_ga-reports.test.js
git commit -m "feat: work out which analytics dimensions are registered"
```

---

### Task 2: The report definitions

**Files:**
- Modify: `api/_ga-reports.js`
- Modify: `api/_ga-reports.test.js`

- [ ] **Step 1: Write the failing test**

Add `buildReports, toBatches` to the existing import in `api/_ga-reports.test.js`, then append:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `buildReports is not a function`

- [ ] **Step 3: Write minimal implementation**

Append to `api/_ga-reports.js`:

```js
// batchRunReports accepts at most five reports per request.
const BATCH_LIMIT = 5;

const eventIs = (name) => ({ filter: { fieldName: 'eventName', stringFilter: { value: name } } });
const eventIn = (names) => ({ filter: { fieldName: 'eventName', inListFilter: { values: names } } });

// Today is always incomplete in GA — it takes 24-48 hours to finish a day — so
// every range stops at yesterday rather than ending each trend in a false dip.
function dateRanges(days) {
    return [{ startDate: `${days}daysAgo`, endDate: 'yesterday' }];
}

// The reports to run, each named so its response can be found again. The
// movie and category reports are included only when their dimensions are
// registered: asking for an unregistered one fails the whole batch.
export function buildReports(days, params) {
    const range = dateRanges(days);
    const topTen = (dimension) => ({
        dateRanges: range,
        dimensions: [{ name: dimension }],
        metrics: [{ name: 'activeUsers' }],
        orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }],
        limit: 10
    });

    const reports = [
        { name: 'totals', request: {
            dateRanges: range,
            metrics: ['activeUsers', 'newUsers', 'sessions', 'userEngagementDuration'].map((name) => ({ name }))
        } },
        { name: 'daily', request: {
            dateRanges: range,
            dimensions: [{ name: 'date' }],
            metrics: [{ name: 'activeUsers' }],
            orderBys: [{ dimension: { dimensionName: 'date' } }]
        } },
        { name: 'countries', request: topTen('country') },
        { name: 'languages', request: topTen('language') },
        { name: 'osVersions', request: topTen('operatingSystemVersion') },
        { name: 'appVersions', request: topTen('appVersion') }
    ];

    // No limit on these: GA's default of 10,000 rows covers every title.
    const keys = movieKeys(params);
    if (keys.plays) {
        reports.push({ name: 'plays', request: {
            dateRanges: range,
            dimensions: [{ name: 'eventName' }, { name: `customEvent:${keys.plays}` }],
            metrics: [{ name: 'eventCount' }],
            dimensionFilter: eventIn(['video_start', 'video_complete'])
        } });
    }
    if (keys.clicks) {
        reports.push({ name: 'clicks', request: {
            dateRanges: range,
            dimensions: [{ name: `customEvent:${keys.clicks}` }],
            metrics: [{ name: 'eventCount' }],
            dimensionFilter: eventIs('select_content')
        } });
    }
    if (params.has('category_name')) {
        reports.push({ name: 'categories', request: {
            dateRanges: range,
            dimensions: [{ name: 'customEvent:category_name' }],
            metrics: [{ name: 'eventCount' }],
            dimensionFilter: eventIs('view_category'),
            orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }]
        } });
    }
    return reports;
}

export function toBatches(reports, size = BATCH_LIMIT) {
    const batches = [];
    for (let index = 0; index < reports.length; index += size) {
        batches.push(reports.slice(index, index + size));
    }
    return batches;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — 6 new tests, 122 total.

- [ ] **Step 5: Commit**

```bash
git add api/_ga-reports.js api/_ga-reports.test.js
git commit -m "feat: define the analytics reports for the registered dimensions"
```

---

### Task 3: Shaping GA's responses

**Files:**
- Modify: `api/_ga-reports.js`
- Modify: `api/_ga-reports.test.js`

GA sends each report as `{ rows: [{ dimensionValues: [{ value }], metricValues: [{ value }] }], metadata }`, with **every metric as a string**, and omits rows whose metrics are all zero.

- [ ] **Step 1: Write the failing test**

Add `parseRows, fillDaily, shapeAnalytics` to the import, then append:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `parseRows is not a function`

- [ ] **Step 3: Write minimal implementation**

Append to `api/_ga-reports.js`:

```js
// A report's rows as plain values. GA sends every metric as a string.
export function parseRows(report) {
    const rows = Array.isArray(report?.rows) ? report.rows : [];
    return rows.map((row) => ({
        dims: (row?.dimensionValues || []).map((value) => String(value?.value ?? '')),
        values: (row?.metricValues || []).map((value) => Number(value?.value) || 0)
    }));
}

const DAY_MS = 24 * 60 * 60 * 1000;

// "20260901" as a UTC timestamp, and back again as "2026-09-01".
const fromGaDate = (text) => Date.UTC(Number(text.slice(0, 4)), Number(text.slice(4, 6)) - 1, Number(text.slice(6, 8)));
const toIsoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

// Daily active users, one point per day. GA omits days with no rows, and a line
// drawn straight across a missing day shows activity that never happened, so
// every day between the first and last becomes a point.
export function fillDaily(rows) {
    const byDay = new Map();
    for (const row of rows) {
        const text = row.dims[0];
        if (/^\d{8}$/.test(text)) byDay.set(fromGaDate(text), row.values[0] || 0);
    }
    if (byDay.size === 0) return [];

    const days = [...byDay.keys()].sort((a, b) => a - b);
    const points = [];
    for (let day = days[0]; day <= days[days.length - 1]; day += DAY_MS) {
        points.push({ date: toIsoDate(day), activeUsers: byDay.get(day) || 0 });
    }
    return points;
}

// Rows with no usable value: events logged before a dimension was registered
// come back as "(not set)".
const isUnset = (value) => value === '' || value === '(not set)';

// {name: count} from single-dimension rows, summing any repeats.
function countBy(rows) {
    const counts = {};
    for (const row of rows) {
        const name = row.dims[0];
        if (isUnset(name)) continue;
        counts[name] = (counts[name] || 0) + (row.values[0] || 0);
    }
    return counts;
}

// {name: count} for one event, from rows of [eventName, key].
function countEvent(rows, eventName) {
    return countBy(rows.filter((row) => row.dims[0] === eventName).map((row) => ({
        dims: [row.dims[1]],
        values: row.values
    })));
}

const ranked = (rows, field) => rows.map((row) => ({ name: row.dims[0], [field]: row.values[0] || 0 }));

// The endpoint's response, from the reports buildReports made and the
// responses GA returned for them, in the same order.
export function shapeAnalytics({ days, params, reports, responses }) {
    const byName = new Map(reports.map((report, index) => [report.name, responses[index]]));
    const rows = (name) => parseRows(byName.get(name));
    const keys = movieKeys(params);

    const [totals = 0, newUsers = 0, sessions = 0, engagement = 0] = rows('totals')[0]?.values || [];
    const playRows = rows('plays');

    const metadata = [...byName.values()].map((response) => response?.metadata || {});

    return {
        range: days,
        audience: {
            activeUsers: totals,
            newUsers,
            sessions,
            engagementSeconds: engagement,
            daily: fillDaily(rows('daily'))
        },
        where: {
            countries: ranked(rows('countries'), 'users'),
            languages: ranked(rows('languages'), 'users'),
            osVersions: ranked(rows('osVersions'), 'users'),
            appVersions: ranked(rows('appVersions'), 'users')
        },
        movies: keys.plays ? {
            key: keys.key,
            clicks: keys.clicks ? countBy(rows('clicks')) : null,
            plays: countEvent(playRows, 'video_start'),
            completes: countEvent(playRows, 'video_complete')
        } : null,
        categories: params.has('category_name')
            ? ranked(rows('categories').filter((row) => !isUnset(row.dims[0])), 'views')
            : null,
        missingDimensions: missingDimensions(params),
        notes: {
            thresholded: metadata.some((entry) => entry.subjectToThresholding === true),
            otherRow: metadata.some((entry) => entry.dataLossFromOtherRow === true)
        }
    };
}
```

Note `(not set)` is kept in the `where` lists — an unknown country is still a real group of users — and dropped only from movie and category figures, where it names nothing.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — 9 new tests, 131 total.

- [ ] **Step 5: Commit**

```bash
git add api/_ga-reports.js api/_ga-reports.test.js
git commit -m "feat: shape GA report responses into the analytics payload"
```

---

### Task 4: The endpoint

**Files:**
- Create: `api/analytics.js`
- Create: `api/analytics.test.js`
- Modify: `package.json` (via `npm install`)
- Modify: `dev-server.js` (startup log line)

- [ ] **Step 1: Add the dependency**

Run: `npm install google-auth-library`
Expected: `package.json` gains `"google-auth-library"` under `dependencies`. Commit `package-lock.json` with it.

- [ ] **Step 2: Write the failing test**

Create `api/analytics.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHandler, readServiceAccount } from './analytics.js';

const EMAIL = 'dashboard-analytics@movie-recap-1306e.iam.gserviceaccount.com';
const KEY = Buffer.from(JSON.stringify({ client_email: EMAIL, private_key: 'fake-key' })).toString('base64');
const ENV = { GA_PROPERTY_ID: '123456789', GA_SERVICE_ACCOUNT_KEY: KEY };
const ALL_DIMS = ['customEvent:movie_title', 'customEvent:item_name', 'customEvent:category_name'];

// Vercel's response object, recording what the handler sent.
function fakeRes() {
    return {
        statusCode: 0, body: null, headers: {},
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
        setHeader(name, value) { this.headers[name.toLowerCase()] = value; }
    };
}

const row = (dims, values) => ({
    dimensionValues: dims.map((value) => ({ value })),
    metricValues: values.map((value) => ({ value: String(value) }))
});

// Stands in for GA: metadata listing `dimensions`, and batchRunReports
// answering each request by its first dimension. Records every call.
function fakeGa({ dimensions = ALL_DIMS, status = 200, error = null } = {}) {
    const calls = [];
    const fetch = async (url, init = {}) => {
        calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
        if (status !== 200) {
            return { ok: false, status, json: async () => ({ error }) };
        }
        if (url.endsWith('/metadata')) {
            return { ok: true, status: 200, json: async () => ({ dimensions: dimensions.map((apiName) => ({ apiName })) }) };
        }
        const reports = JSON.parse(init.body).requests.map((request) => {
            const first = request.dimensions?.[0]?.name;
            if (!first) return { rows: [row([], [480, 120, 900, 43200])] };
            if (first === 'date') return { rows: [row(['20260901'], [30])] };
            if (first === 'eventName') return { rows: [row(['video_start', 'Terra Nova'], [40])] };
            return { rows: [row(['Myanmar'], [300])] };
        });
        return { ok: true, status: 200, json: async () => ({ reports }) };
    };
    return { fetch, calls };
}

const getAccessToken = async () => 'fake-token';
const get = (range) => ({ method: 'GET', query: { range } });

test('readServiceAccount returns null when nothing is configured', () => {
    assert.equal(readServiceAccount({}), null);
    assert.equal(readServiceAccount({ GA_PROPERTY_ID: '1' }), null);
});

test('readServiceAccount decodes the base64 key', () => {
    assert.deepEqual(readServiceAccount(ENV), { propertyId: '123456789', email: EMAIL, privateKey: 'fake-key' });
});

test('readServiceAccount explains a measurement id given as the property id', () => {
    assert.throws(() => readServiceAccount({ ...ENV, GA_PROPERTY_ID: 'G-D03ZRJWX1F' }), /numeric property ID/);
});

test('readServiceAccount explains a key that is not base64 JSON', () => {
    assert.throws(() => readServiceAccount({ ...ENV, GA_SERVICE_ACCOUNT_KEY: 'not base64 json' }), /base64/);
    const noEmail = Buffer.from(JSON.stringify({ private_key: 'k' })).toString('base64');
    assert.throws(() => readServiceAccount({ ...ENV, GA_SERVICE_ACCOUNT_KEY: noEmail }), /client_email/);
});

test('handler rejects anything but GET', async () => {
    const res = fakeRes();
    await createHandler({ getAccessToken, fetch: fakeGa().fetch, env: ENV })({ method: 'POST', query: {} }, res);
    assert.equal(res.statusCode, 405);
});

test('handler rejects a range the picker cannot send', async () => {
    const res = fakeRes();
    await createHandler({ getAccessToken, fetch: fakeGa().fetch, env: ENV })(get('30'), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.headers['cache-control'], 'no-store');
});

test('handler says when it is not configured, without calling GA', async () => {
    const ga = fakeGa();
    const res = fakeRes();
    await createHandler({ getAccessToken, fetch: ga.fetch, env: {} })(get('28'), res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.error, 'not_configured');
    assert.equal(ga.calls.length, 0);
});

test('handler passes on why the configuration is wrong', async () => {
    const res = fakeRes();
    await createHandler({ getAccessToken, fetch: fakeGa().fetch, env: { ...ENV, GA_PROPERTY_ID: 'G-X' } })(get('28'), res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.error, 'not_configured');
    assert.match(res.body.detail, /numeric property ID/);
});

test('handler returns the analytics with a cache header', async () => {
    const ga = fakeGa();
    const res = fakeRes();
    await createHandler({ getAccessToken, fetch: ga.fetch, env: ENV })(get('28'), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['cache-control'], 's-maxage=900, stale-while-revalidate=3600');
    assert.equal(res.body.range, 28);
    assert.equal(res.body.audience.activeUsers, 480);
    assert.deepEqual(res.body.movies.plays, { 'Terra Nova': 40 });
    assert.deepEqual(res.body.missingDimensions, []);

    // One metadata call, then nine reports in batches of five and four.
    const batches = ga.calls.filter((call) => call.url.endsWith(':batchRunReports'));
    assert.equal(ga.calls[0].url, 'https://analyticsdata.googleapis.com/v1beta/properties/123456789/metadata');
    assert.deepEqual(batches.map((call) => call.body.requests.length), [5, 4]);
    assert.equal(batches[0].init.headers.Authorization, 'Bearer fake-token');
});

test('handler runs only the built-in reports when nothing is registered', async () => {
    const ga = fakeGa({ dimensions: [] });
    const res = fakeRes();
    await createHandler({ getAccessToken, fetch: ga.fetch, env: ENV })(get('7'), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.movies, null);
    assert.equal(res.body.categories, null);
    assert.deepEqual(res.body.missingDimensions, ['movie_title', 'item_name', 'category_name']);
    const batches = ga.calls.filter((call) => call.url.endsWith(':batchRunReports'));
    assert.deepEqual(batches.map((call) => call.body.requests.length), [5, 1]);
});

test('handler reads the metadata once and reuses it', async () => {
    const ga = fakeGa();
    const handler = createHandler({ getAccessToken, fetch: ga.fetch, env: ENV });
    await handler(get('28'), fakeRes());
    await handler(get('7'), fakeRes());
    assert.equal(ga.calls.filter((call) => call.url.endsWith('/metadata')).length, 1);
});

test('handler names the service account when GA denies access', async () => {
    // The fix is adding exactly this email in GA4, so the admin needs to see it.
    const ga = fakeGa({ status: 403, error: { code: 403, status: 'PERMISSION_DENIED', message: 'User does not have sufficient permissions' } });
    const res = fakeRes();
    await createHandler({ getAccessToken, fetch: ga.fetch, env: ENV })(get('28'), res);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { error: 'no_access', serviceAccount: EMAIL });
});

test('handler passes on any other GA failure', async () => {
    const ga = fakeGa({ status: 500, error: { code: 500, status: 'INTERNAL', message: 'Backend error' } });
    const res = fakeRes();
    await createHandler({ getAccessToken, fetch: ga.fetch, env: ENV })(get('28'), res);
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.error, 'ga_error');
    assert.match(res.body.detail, /Backend error/);
    assert.equal(res.headers['cache-control'], 'no-store');
});

test('handler reports a failure to get a token as a GA failure', async () => {
    const res = fakeRes();
    const failing = async () => { throw new Error('invalid_grant: Invalid JWT Signature.'); };
    await createHandler({ getAccessToken: failing, fetch: fakeGa().fetch, env: ENV })(get('28'), res);
    assert.equal(res.statusCode, 502);
    assert.match(res.body.detail, /invalid_grant/);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './analytics.js'`

- [ ] **Step 4: Write minimal implementation**

Create `api/analytics.js`:

```js
// Google Analytics for the dashboard: the Android app's GA4 data, read through
// the Data API with a service account and returned as one JSON document.
//
// Everything the handler touches outside itself — the access token and fetch —
// is passed in through createHandler, so the tests need neither credentials
// nor a network. The default export wires in the real ones.

import { JWT } from 'google-auth-library';
import { parseRange, registeredParams, buildReports, toBatches, shapeAnalytics } from './_ga-reports.js';

const API = 'https://analyticsdata.googleapis.com/v1beta/properties';
const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';

// Which dimensions are registered changes only when the admin registers one.
const METADATA_TTL_MS = 60 * 60 * 1000;

class GaError extends Error {
    constructor(status, gaStatus, message) {
        super(message || `Google Analytics error ${status}`);
        this.status = status;
        this.gaStatus = gaStatus;
    }
}

// The service account from the environment, or null if it is not set up.
// GA_SERVICE_ACCOUNT_KEY is the JSON key file base64-encoded on one line:
// dev-server.js reads .env a line at a time, and the key file spans many.
// A value that is set but wrong throws, with a message the admin can act on.
export function readServiceAccount(env) {
    const propertyId = env.GA_PROPERTY_ID;
    const encoded = env.GA_SERVICE_ACCOUNT_KEY;
    if (!propertyId || !encoded) return null;

    if (!/^\d+$/.test(propertyId)) {
        throw new Error('GA_PROPERTY_ID must be the numeric property ID from GA4 Admin → Property details, not the G-… measurement ID.');
    }

    let key;
    try {
        key = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    } catch {
        throw new Error('GA_SERVICE_ACCOUNT_KEY must be the service account JSON key, base64-encoded on one line.');
    }
    if (!key?.client_email || !key?.private_key) {
        throw new Error('GA_SERVICE_ACCOUNT_KEY is missing client_email or private_key — is it the right key file?');
    }
    return { propertyId, email: key.client_email, privateKey: key.private_key };
}

export function createHandler({ getAccessToken, fetch, env = process.env }) {
    let metadataCache = null;

    async function ga(path, token, init = {}) {
        const response = await fetch(`${API}/${path}`, {
            ...init,
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new GaError(response.status, data?.error?.status, data?.error?.message);
        }
        return data;
    }

    async function registered(account, token) {
        const cached = metadataCache;
        if (cached && cached.propertyId === account.propertyId && cached.expires > Date.now()) {
            return cached.params;
        }
        const params = registeredParams(await ga(`${account.propertyId}/metadata`, token));
        metadataCache = { propertyId: account.propertyId, params, expires: Date.now() + METADATA_TTL_MS };
        return params;
    }

    return async function handler(req, res) {
        const fail = (status, body) => {
            res.setHeader('Cache-Control', 'no-store');
            return res.status(status).json(body);
        };

        if (req.method !== 'GET') return fail(405, { error: 'Method not allowed' });

        const days = parseRange(req.query?.range);
        if (!days) return fail(400, { error: 'range must be 7, 28 or 90' });

        let account;
        try {
            account = readServiceAccount(env);
        } catch (error) {
            return fail(503, { error: 'not_configured', detail: error.message });
        }
        if (!account) return fail(503, { error: 'not_configured' });

        try {
            const token = await getAccessToken(account);
            const params = await registered(account, token);
            const reports = buildReports(days, params);

            // Two batches in parallel; GA returns each batch's reports in the
            // order they were asked for, and Promise.all keeps batch order.
            const results = await Promise.all(toBatches(reports).map((batch) =>
                ga(`${account.propertyId}:batchRunReports`, token, {
                    method: 'POST',
                    body: JSON.stringify({ requests: batch.map((report) => report.request) })
                })
            ));
            const responses = results.flatMap((result) => result.reports || []);

            // GA's numbers change daily at most; the edge serves repeats for 15
            // minutes without spending quota.
            res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=3600');
            return res.status(200).json(shapeAnalytics({ days, params, reports, responses }));
        } catch (error) {
            if (error instanceof GaError && (error.status === 403 || error.gaStatus === 'PERMISSION_DENIED')) {
                // The fix is adding exactly this email to the property.
                return fail(403, { error: 'no_access', serviceAccount: account.email });
            }
            console.error('Analytics: request failed', { message: error.message });
            return fail(502, { error: 'ga_error', detail: error.message });
        }
    };
}

// One client per warm instance; it caches its token until it expires.
let jwtClient = null;
let jwtEmail = null;

async function googleAccessToken(account) {
    if (!jwtClient || jwtEmail !== account.email) {
        jwtClient = new JWT({ email: account.email, key: account.privateKey, scopes: [SCOPE] });
        jwtEmail = account.email;
    }
    const { token } = await jwtClient.getAccessToken();
    if (!token) throw new Error('Google returned no access token');
    return token;
}

export default createHandler({
    getAccessToken: googleAccessToken,
    fetch: (...args) => globalThis.fetch(...args)
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test`
Expected: PASS — 14 new tests, 147 total.

- [ ] **Step 6: Update the dev-server log**

In `dev-server.js`, append `  /api/analytics` to the route list in the `server.listen` callback, after `/api/translate`.

- [ ] **Step 7: Check the unconfigured endpoint for real**

```bash
PORT=3055 node dev-server.js & PID=$!
curl -s --retry 10 --retry-connrefused --retry-delay 1 -w "  [HTTP %{http_code}]\n" "http://localhost:3055/api/analytics?range=28"
curl -s -w "  [HTTP %{http_code}]\n" "http://localhost:3055/api/analytics?range=30"
kill $PID
```

Expected: `{"error":"not_configured"}  [HTTP 503]` (while `.env` has no GA variables), then `{"error":"range must be 7, 28 or 90"}  [HTTP 400]`.

- [ ] **Step 8: Commit**

```bash
git add api/analytics.js api/analytics.test.js dev-server.js package.json package-lock.json
git commit -m "feat: add the analytics endpoint over the GA4 Data API"
```

---

### Task 5: Ranges, comment counts and number formatting

**Files:**
- Create: `analytics.js`
- Create: `analytics.test.js`

- [ ] **Step 1: Write the failing test**

Create `analytics.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './analytics.js'`

- [ ] **Step 3: Write minimal implementation**

Create `analytics.js`:

```js
// Pure logic for the analytics section: joining Google Analytics figures to
// the movie library, and formatting numbers for display.
//
// This module deliberately imports nothing, for the same reason as comments.js:
// app.js cannot be loaded by Node, so logic that deserves a test lives here.

// Titles are matched with surrounding spaces ignored. 8 library titles carry
// stray ones, and GA may hold a title both with and without them.
export function normalizeTitle(title) {
    return String(title ?? '').trim();
}

// The span a range covers, matching GA's "{N}daysAgo" to "yesterday": from
// local midnight N days ago up to local midnight today.
export function rangeBounds(days, now = Date.now()) {
    const end = new Date(now);
    end.setHours(0, 0, 0, 0);
    const start = new Date(end);
    start.setDate(start.getDate() - days);
    return { startMs: start.getTime(), endMs: end.getTime() };
}

// Top-level comments per movie id whose timestamp falls in [startMs, endMs).
export function commentsInRange(rows, startMs, endMs) {
    const counts = new Map();
    for (const row of rows || []) {
        const at = Number(row?.timestamp);
        if (!(at >= startMs && at < endMs)) continue;
        counts.set(row.movieId, (counts.get(row.movieId) || 0) + 1);
    }
    return counts;
}

const whole = new Intl.NumberFormat('en');
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

// Stat-tile values: exact below ten thousand (1,284), compact above (12.9K).
export function formatCompact(value) {
    const n = Number(value) || 0;
    return Math.abs(n) < 10000 ? whole.format(Math.round(n)) : compact.format(n);
}

// Table cells: always exact.
export function formatCount(value) {
    return whole.format(Math.round(Number(value) || 0));
}

// A ratio as a whole percentage, or "—" when there was nothing to divide by.
export function formatPercent(ratio) {
    return ratio !== null && Number.isFinite(ratio) ? `${Math.round(ratio * 100)}%` : '—';
}

// Engagement time: "45s", "2m 14s", "1h 3m".
export function formatDuration(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${secs}s`;
    return `${secs}s`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — 7 new tests, 154 total.

- [ ] **Step 5: Commit**

```bash
git add analytics.js analytics.test.js
git commit -m "feat: add range, comment-count and formatting helpers for analytics"
```

---

### Task 6: Joining GA's titles to the library

**Files:**
- Modify: `analytics.js`
- Modify: `analytics.test.js`

- [ ] **Step 1: Write the failing test**

Add `buildMovieRows` to the import in `analytics.test.js`, then append:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `buildMovieRows is not a function`

- [ ] **Step 3: Write minimal implementation**

Append to `analytics.js`:

```js
// GA's counts for one event, summed into normalized keys. The same title may
// arrive with and without stray spaces, and "(not set)" names nothing.
function normalizeCounts(counts, key) {
    const out = new Map();
    for (const [raw, value] of Object.entries(counts || {})) {
        const name = key === 'title' ? normalizeTitle(raw) : String(raw);
        if (!name || name === '(not set)') continue;
        out.set(name, (out.get(name) || 0) + (Number(value) || 0));
    }
    return out;
}

const byName = (a, b) => a.localeCompare(b);

// The movie table, from the endpoint's `movies` and the library.
//
// One row per title — or per id, if that is what GA is keyed by. GA records only
// the title, so two library copies sharing one have a single combined figure:
// the row takes a thumbnail from whichever copy has one and says how many
// copies there are, rather than inventing a split.
export function buildMovieRows(movies, library, commentCounts = new Map()) {
    const key = movies?.key === 'id' ? 'id' : 'title';
    const keyOf = (movie) => (key === 'title' ? normalizeTitle(movie?.title) : String(movie?.id ?? ''));

    const groups = new Map();
    for (const movie of library || []) {
        const name = keyOf(movie);
        if (!name) continue;
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push(movie);
    }

    const clicks = movies?.clicks ? normalizeCounts(movies.clicks, key) : null;
    const plays = normalizeCounts(movies?.plays, key);
    const completes = normalizeCounts(movies?.completes, key);

    const rows = [];
    const neverPlayed = [];
    for (const [name, copies] of groups) {
        const playCount = plays.get(name) || 0;
        const completeCount = completes.get(name) || 0;
        const clickCount = clicks ? (clicks.get(name) || 0) : null;
        const row = {
            key: name,
            title: normalizeTitle(copies[0].title) || name,
            thumbnail: copies.find((movie) => movie.thumbnail)?.thumbnail || null,
            copies: copies.length,
            clicks: clickCount,
            plays: playCount,
            completes: completeCount,
            completionRate: playCount > 0 ? completeCount / playCount : null,
            comments: copies.reduce((sum, movie) => sum + (commentCounts.get(movie.id) || 0), 0)
        };
        // Clicked but never played still earns a row: that gap is worth seeing.
        if (playCount > 0 || clickCount > 0) rows.push(row);
        if (playCount === 0) neverPlayed.push(row);
    }

    rows.sort((a, b) => (b.plays - a.plays) || ((b.clicks || 0) - (a.clicks || 0)) || byName(a.title, b.title));
    neverPlayed.sort((a, b) => byName(a.title, b.title));

    // Titles GA has that the library does not: renamed or removed movies.
    const reported = new Set([...plays.keys(), ...(clicks ? clicks.keys() : [])]);
    const notInLibrary = [...reported]
        .filter((name) => !groups.has(name))
        .map((name) => ({ key: name, plays: plays.get(name) || 0, clicks: clicks ? (clicks.get(name) || 0) : null }))
        .sort((a, b) => (b.plays - a.plays) || ((b.clicks || 0) - (a.clicks || 0)) || byName(a.key, b.key));

    return { rows, neverPlayed, notInLibrary };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — 11 new tests, 165 total.

- [ ] **Step 5: Commit**

```bash
git add analytics.js analytics.test.js
git commit -m "feat: join GA titles to the library, one row per title"
```

---

### Task 7: A router for three views

**Files:**
- Modify: `index.html` (`<main>`, nav, a new section)
- Modify: `style.css` (the "View switching" block)
- Modify: `app.js` (the `// --- View routing ---` block)

The Comments feature's router knows two views: one `is-comments-view` class and a boolean. A third view is the point to generalize it: `.main-content` carries a `data-view` attribute, and CSS hides the Movies view's parts whenever it is not `movies`.

- [ ] **Step 1: Mark up the new view**

In `index.html`:

1. Change `<main class="main-content">` to `<main class="main-content" data-view="movies">`. This matters: the CSS below hides the movies view whenever `data-view` is not `movies`, so without the attribute the page would load with the grid hidden.
2. After the Comments nav button (`id="nav-comments"`), before the Settings placeholder comment, add:

```html
                <button class="nav-item" id="nav-analytics">
                    <span class="icon">📊</span> Analytics
                </button>
```

3. After the closing `</section>` of `#comments-view`, before `</main>`, add:

```html
            <!-- Analytics. analytics-view.js fills #analytics-body the first
                 time the view is opened. -->
            <section id="analytics-view" class="analytics-view hidden">
                <div class="analytics-filters" role="group" aria-label="Date range">
                    <button type="button" class="range-btn" data-range="7" aria-pressed="false">Last 7 days</button>
                    <button type="button" class="range-btn" data-range="28" aria-pressed="true">Last 28 days</button>
                    <button type="button" class="range-btn" data-range="90" aria-pressed="false">Last 90 days</button>
                </div>
                <div id="analytics-body" class="analytics-body"></div>
            </section>
```

- [ ] **Step 2: Generalize the CSS**

In `style.css`, replace the whole "View switching" block — the comment and the `.main-content.is-comments-view …` rule — with:

```css
/* ---------- View switching ---------- */

/* .main-content's data-view says which view shows. Every view but Movies hides
   the Movies view's parts from this one place, so their own show/hide logic
   cannot leak through: the last-added panel re-shows itself on every movie
   write and on a one-minute timer. The movie form is a fixed overlay and is
   deliberately not listed — it opens over any view. */
.main-content:not([data-view="movies"]) .content-body,
.main-content:not([data-view="movies"]) .last-added,
.main-content:not([data-view="movies"]) .header-button-group {
    display: none !important;
}
```

- [ ] **Step 3: Generalize the router**

In `app.js`, replace everything from the `// --- View routing ---` comment through the line `navComments?.addEventListener('click', () => showView('comments'));` with:

```js
// --- View routing ---
//
// .main-content's data-view attribute decides which view shows (see "View
// switching" in style.css). The Movies view's own parts keep managing their own
// hidden state — the last-added panel re-shows itself on every movie write and
// on a one-minute timer — and the attribute overrides them without touching
// that logic. #nav-settings stays deliberately unwired.

const mainContent = document.querySelector('.main-content');
const pageTitle = document.querySelector('.page-title');

const VIEWS = {
    movies: { nav: document.getElementById('nav-dashboard'), section: null, title: 'Dashboard' },
    comments: { nav: document.getElementById('nav-comments'), section: document.getElementById('comments-view'), title: 'Comments' },
    analytics: { nav: document.getElementById('nav-analytics'), section: document.getElementById('analytics-view'), title: 'Analytics' }
};

function showView(name) {
    if (!VIEWS[name]) return;
    if (mainContent) mainContent.dataset.view = name;
    for (const [viewName, view] of Object.entries(VIEWS)) {
        view.nav?.classList.toggle('active', viewName === name);
        view.section?.classList.toggle('hidden', viewName !== name);
    }
    if (pageTitle) pageTitle.textContent = VIEWS[name].title;
}

for (const [name, view] of Object.entries(VIEWS)) {
    view.nav?.addEventListener('click', () => showView(name));
}
```

`navDashboard`, `navComments` and `commentsView` were used only inside the block being replaced; confirm with `grep -nE "navDashboard|navComments|commentsView\b" app.js`, which must print nothing afterwards.

- [ ] **Step 4: Check syntax and tests**

Run: `node --check app.js && npm test`
Expected: no syntax error; 165 passing.

- [ ] **Step 5: Check all three views in the browser**

With the harness at `…/scratchpad/ui-harness.mjs` (serves the project on :3055 and drives headless Chrome), check: on load the movie grid and last-added panel show and the title reads "Dashboard"; on Comments the inbox shows and the grid, last-added panel and header buttons are hidden; on Analytics the three range buttons show, the grid and the last-added panel are hidden, and the title reads "Analytics"; back on Movies everything returns. Also un-hide `#last-added` by hand while on Analytics — as its one-minute timer does — and confirm it stays invisible. Expect no page errors.

- [ ] **Step 6: Commit**

```bash
git add index.html style.css app.js
git commit -m "refactor: route between three views with one data-view attribute"
```

---

### Task 8: The view's states, its styles, and its wiring

**Files:**
- Create: `analytics-view.js`
- Modify: `style.css` (append)
- Modify: `app.js` (import, router hook, re-render hooks, creation)

This task builds the view's frame: fetching, the not-configured / no-access / error cards, GA's caveat line, and the audience stat tiles. Tasks 9–11 add the chart, the movie table and the bar lists into it. All the analytics CSS goes in now, since every class is known.

- [ ] **Step 1: Create the view module**

Create `analytics-view.js`:

```js
// The Analytics view's DOM. Browser only: the logic worth testing lives in
// analytics.js and api/_ga-reports.js, and this module turns their results
// into elements.
//
// Every string that came from GA or the database — titles, countries,
// languages, categories — goes in through textContent. They are untrusted.

import {
    rangeBounds, commentsInRange, buildMovieRows,
    formatCompact, formatCount, formatPercent, formatDuration
} from './analytics.js';

// Where each setup step is done, shown when the endpoint is not configured.
const SETUP_STEPS = [
    {
        text: 'Copy the numeric Property ID from GA4 → Admin → Property details (not the G-… measurement ID).',
        link: { label: 'Google Analytics', href: 'https://analytics.google.com/' }
    },
    {
        text: 'Enable the Google Analytics Data API in project movie-recap-1306e.',
        link: { label: 'Enable the API', href: 'https://console.cloud.google.com/apis/library/analyticsdata.googleapis.com?project=movie-recap-1306e' }
    },
    {
        text: 'Create a service account and download a JSON key for it.',
        link: { label: 'Service accounts', href: 'https://console.cloud.google.com/iam-admin/serviceaccounts?project=movie-recap-1306e' }
    },
    { text: "Add the service account's email in GA4 → Admin → Property access management, with the Viewer role." },
    { text: "Set GA_PROPERTY_ID and GA_SERVICE_ACCOUNT_KEY — the key file base64-encoded on one line: base64 -i key.json | tr -d '\\n' — in .env and in Vercel's environment variables, then restart the dev server." }
];

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
}

function spinner() {
    const box = el('div', 'loading-state');
    box.append(el('div', 'spinner'), el('p', null, 'Loading analytics...'));
    return box;
}

export function initAnalyticsView({ section, getMovies, getCommentRows }) {
    if (!section) return { show() {}, rerender() {} };

    const body = section.querySelector('#analytics-body');
    const rangeButtons = [...section.querySelectorAll('.range-btn')];

    let range = 28;
    let data = null;     // the response on screen
    let latest = 0;      // the newest request; answers to older ones are dropped
    let started = false;

    for (const button of rangeButtons) {
        button.addEventListener('click', () => {
            const next = Number(button.dataset.range);
            if (next === range) return;
            range = next;
            for (const other of rangeButtons) {
                other.setAttribute('aria-pressed', String(Number(other.dataset.range) === range));
            }
            load();
        });
    }

    async function load() {
        const request = ++latest;
        // A refetch keeps the previous figures on screen, dimmed: no skeleton
        // and no layout jump. Only the very first load shows a spinner.
        if (data) body.classList.add('is-refreshing');
        else body.replaceChildren(spinner());

        let status = 0;
        let payload = {};
        try {
            const response = await fetch(`/api/analytics?range=${range}`);
            status = response.status;
            payload = await response.json().catch(() => ({}));
        } catch (error) {
            payload = { error: 'network', detail: error.message };
        }

        // A range picked meanwhile has made this answer stale.
        if (request !== latest) return;
        body.classList.remove('is-refreshing');

        if (status === 200) {
            data = payload;
            render();
            return;
        }
        data = null;
        if (payload.error === 'not_configured') showSetup(payload.detail);
        else if (payload.error === 'no_access') showNoAccess(payload.serviceAccount);
        else showError(payload.detail || payload.error || `Analytics request failed (${status})`);
    }

    function render() {
        try {
            body.replaceChildren(...buildReport(data, getMovies() || [], getCommentRows() || []));
        } catch (error) {
            console.error('Rendering analytics failed:', error);
            showError(error.message);
        }
    }

    function retryButton(label) {
        const button = el('button', 'btn btn-secondary btn-sm', label);
        button.type = 'button';
        button.addEventListener('click', load);
        return button;
    }

    function showSetup(detail) {
        const card = el('div', 'analytics-card analytics-state');
        card.append(el('h3', null, 'Connect Google Analytics'));
        card.append(el('p', 'analytics-lead',
            "The dashboard reads the app's analytics through a Google service account. Set it up once:"));
        if (detail) card.append(el('p', 'analytics-problem', detail));

        const steps = el('ol', 'setup-steps');
        for (const step of SETUP_STEPS) {
            const item = el('li', null, step.text);
            if (step.link) {
                const link = el('a', null, step.link.label);
                link.href = step.link.href;
                link.target = '_blank';
                link.rel = 'noopener';
                item.append(' ', link);
            }
            steps.append(item);
        }
        card.append(steps, retryButton('Check again'));
        body.replaceChildren(card);
    }

    function showNoAccess(email) {
        const card = el('div', 'analytics-card analytics-state');
        card.append(el('h3', null, 'Google Analytics refused access'));
        card.append(el('p', 'analytics-lead',
            'Add this service account in GA4 → Admin → Property access management, with the Viewer role:'));
        card.append(el('code', 'analytics-email', email || 'unknown'));
        card.append(el('p'), retryButton('Check again'));
        body.replaceChildren(card);
    }

    function showError(detail) {
        const card = el('div', 'analytics-card analytics-state');
        card.append(el('h3', null, "Couldn't load analytics"));
        card.append(el('p', 'analytics-problem', detail));
        card.append(retryButton('Retry'));
        body.replaceChildren(card);
    }

    return {
        // The router calls this whenever the view opens. Only the first visit
        // fetches: GA's figures change at most daily, and the range buttons
        // refetch on demand.
        show() {
            if (started) return;
            started = true;
            load();
        },
        // Called when movies or comments change. The join is redone from the
        // figures already fetched; GA is not asked again.
        rerender() {
            if (data && !section.classList.contains('hidden')) render();
        }
    };
}

// GA's own caveats, stated rather than hidden: both make totals undercount.
function notesLine(notes) {
    const parts = [];
    if (notes?.thresholded) parts.push('Google withheld some small groups for privacy, so totals may undercount.');
    if (notes?.otherRow) parts.push('Some values were grouped into "(other)".');
    return parts.length ? el('p', 'analytics-notes', parts.join(' ')) : null;
}

function buildReport(data, movies, commentRows) {
    const parts = [];
    const notes = notesLine(data.notes);
    if (notes) parts.push(notes);
    parts.push(audienceSection(data.audience));
    return parts;
}

// Stat tiles: a sentence-case label and a compact value (1,284 / 12.9K).
function audienceSection(audience) {
    const section = el('section', 'analytics-section');
    section.append(el('h3', 'analytics-heading', 'Audience'));

    const perUser = audience.activeUsers > 0 ? audience.engagementSeconds / audience.activeUsers : 0;
    const tiles = el('div', 'stat-row');
    for (const [label, value] of [
        ['Active users', formatCompact(audience.activeUsers)],
        ['New users', formatCompact(audience.newUsers)],
        ['Sessions', formatCompact(audience.sessions)],
        ['Engagement per user', formatDuration(perUser)]
    ]) {
        const tile = el('div', 'stat-tile');
        tile.append(el('span', 'stat-label', label), el('span', 'stat-value', value));
        tiles.append(tile);
    }
    section.append(tiles);
    return section;
}
```

The imports of `rangeBounds`, `commentsInRange`, `buildMovieRows`, `formatCount` and `formatPercent` are unused until Tasks 9–10; importing them now saves editing the import line three times.

- [ ] **Step 2: Add the styles**

Append to `style.css`:

```css
/* ---------- Analytics ---------- */

/* Charts use one series colour, --color-accent (#bd369e), which passes every
   palette check on the card surface. Chart text uses --text-secondary (6.5:1 on
   the card); --text-muted is too faint for text there (2.6:1). */

.analytics-view {
    padding: 20px 30px 60px;
}

.analytics-filters {
    display: flex;
    gap: 8px;
    margin-bottom: 20px;
}

.range-btn {
    background: transparent;
    color: var(--text-secondary);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 20px;
    padding: 6px 14px;
    font-family: var(--font-family);
    cursor: pointer;
}

.range-btn[aria-pressed="true"] {
    color: var(--text-primary);
    border-color: var(--color-accent);
    background: rgba(189, 54, 158, 0.15);
    font-weight: 600;
}

/* A refetch keeps the previous figures on screen, dimmed. */
.analytics-body.is-refreshing {
    opacity: 0.45;
    pointer-events: none;
    transition: opacity var(--transition);
}

.analytics-section {
    margin-bottom: 28px;
}

.analytics-heading {
    color: var(--text-primary);
    font-size: 1.1rem;
    margin: 0 0 12px;
}

.analytics-card {
    background: var(--bg-card);
    border-radius: var(--border-radius);
    padding: 18px 20px;
}

.chart-title {
    color: var(--text-secondary);
    font-size: 0.85rem;
    font-weight: 500;
    margin: 0 0 12px;
}

.analytics-empty,
.analytics-notes,
.analytics-footnote {
    color: var(--text-secondary);
    font-size: 0.85rem;
}

.analytics-notes {
    margin: 0 0 16px;
}

.analytics-footnote {
    margin: 12px 0 0;
}

/* Setup, no-access and error cards. */
.analytics-state h3 {
    color: var(--text-primary);
    margin: 0 0 8px;
}

.analytics-lead {
    color: var(--text-secondary);
    margin: 0 0 12px;
}

.analytics-problem {
    color: var(--text-primary);
    border-left: 3px solid var(--color-accent);
    padding-left: 10px;
    margin: 0 0 14px;
}

.setup-steps {
    color: var(--text-primary);
    padding-left: 20px;
    line-height: 1.7;
    margin: 0 0 16px;
}

.setup-steps a {
    color: var(--color-accent-light);
}

.analytics-email,
.missing-params code {
    background: rgba(0, 0, 0, 0.3);
    color: var(--text-primary);
    padding: 2px 6px;
    border-radius: 4px;
    word-break: break-all;
}

.analytics-missing p {
    color: var(--text-secondary);
    margin: 0 0 8px;
}

.missing-params code {
    margin-right: 6px;
}

/* Stat tiles: proportional figures at display size. */
.stat-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 14px;
    margin-bottom: 14px;
}

.stat-tile {
    background: var(--bg-card);
    border-radius: var(--border-radius);
    padding: 16px 18px;
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.stat-label {
    color: var(--text-secondary);
    font-size: 0.85rem;
}

.stat-value {
    color: var(--text-primary);
    font-size: 1.9rem;
    font-weight: 600;
}

/* The line chart: a 2px line, a 10% wash, a ringed end dot, 1px solid grid. */
.line-chart {
    position: relative;
}

.line-chart svg {
    display: block;
    width: 100%;
    height: auto;
    overflow: visible;
}

.chart-grid {
    stroke: rgba(255, 255, 255, 0.08);
    stroke-width: 1;
}

.chart-tick {
    fill: var(--text-secondary);
    font-family: var(--font-family);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
}

.chart-line {
    fill: none;
    stroke: var(--color-accent);
    stroke-width: 2;
    stroke-linejoin: round;
    stroke-linecap: round;
}

.chart-area {
    fill: var(--color-accent);
    fill-opacity: 0.1;
}

.chart-dot {
    fill: var(--color-accent);
    stroke: var(--bg-card);
    stroke-width: 2;
}

.chart-end-label {
    fill: var(--text-primary);
    font-family: var(--font-family);
    font-size: 12px;
    font-weight: 600;
}

.chart-crosshair {
    stroke: var(--text-secondary);
    stroke-width: 1;
}

.chart-hit {
    fill: transparent;
    cursor: crosshair;
    outline: none;
}

.chart-hit:focus-visible {
    stroke: var(--color-accent-light);
    stroke-width: 1;
}

.chart-tooltip {
    position: absolute;
    transform: translate(-50%, calc(-100% - 12px));
    display: flex;
    gap: 6px;
    align-items: baseline;
    white-space: nowrap;
    pointer-events: none;
    background: var(--bg-base);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 8px;
    padding: 6px 10px;
    font-size: 0.85rem;
}

/* The tooltip sets its own display, which would otherwise override the hidden
   attribute and leave an empty pill on the chart. */
.chart-tooltip[hidden] {
    display: none;
}

.chart-tooltip strong {
    color: var(--text-primary);
}

.chart-tooltip span {
    color: var(--text-secondary);
}

/* Tables: numbers align, so tabular figures. */
.chart-table,
.title-list {
    margin-top: 12px;
    font-size: 0.85rem;
}

.chart-table summary,
.title-list summary {
    color: var(--text-secondary);
    cursor: pointer;
}

.data-table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 8px;
}

.data-table th,
.data-table td {
    text-align: left;
    padding: 8px 10px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.data-table th {
    color: var(--text-secondary);
    font-weight: 500;
    font-size: 0.8rem;
}

.data-table td {
    color: var(--text-primary);
}

.data-table .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
}

.data-table .strong {
    font-weight: 600;
}

.movie-stats-wrap {
    overflow-x: auto;
}

.movie-cell {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 220px;
}

/* A fixed slot whether or not the image exists or loads, so titles align. */
.movie-thumb {
    width: 56px;
    height: 32px;
    border-radius: 4px;
    flex-shrink: 0;
    overflow: hidden;
    background: rgba(255, 255, 255, 0.06);
}

.movie-thumb img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
}

.copies-badge {
    border: 1px solid var(--text-secondary);
    color: var(--text-secondary);
    border-radius: 20px;
    padding: 0 8px;
    font-size: 0.7rem;
    white-space: nowrap;
}

.title-list ul {
    color: var(--text-primary);
    margin: 8px 0 0;
    padding-left: 18px;
    columns: 2;
}

/* Ranked bars: one colour, at most 24px thick, a 4px rounded end, square at the
   base, the value at the tip. A row is its own hover and focus target. */
/* Four device lists as a 2×2 grid, one column on narrow screens. */
.bar-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px;
}

@media (max-width: 900px) {
    .bar-grid {
        grid-template-columns: 1fr;
    }
}

/* One grid for the whole list, so every bar starts on the same baseline while
   the name column fits the longest name. Each row joins it through subgrid and
   keeps its own box for the hover and focus lift. */
.bar-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: minmax(60px, max-content) minmax(80px, 1fr) auto;
    column-gap: 10px;
    row-gap: 6px;
}

.bar-row {
    grid-column: 1 / -1;
    display: grid;
    grid-template-columns: subgrid;
    align-items: center;
    padding: 4px 6px;
    border-radius: 6px;
    outline: none;
}

.bar-row:hover,
.bar-row:focus-visible {
    background: rgba(255, 255, 255, 0.05);
}

.bar-row:hover .bar-fill,
.bar-row:focus-visible .bar-fill {
    filter: brightness(1.2);
}

.bar-name {
    color: var(--text-primary);
    font-size: 0.85rem;
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.bar-track {
    height: 12px;
}

.bar-fill {
    display: block;
    height: 100%;
    min-width: 2px;
    background: var(--color-accent);
    border-radius: 0 4px 4px 0;
}

.bar-value {
    color: var(--text-secondary);
    font-size: 0.8rem;
    font-variant-numeric: tabular-nums;
}
```

- [ ] **Step 3: Wire it into `app.js`**

1. After the `} from './comments.js';` import block, add:

```js
import { initAnalyticsView } from './analytics-view.js';
```

2. At the end of `showView` (the Task 7 router), after the `pageTitle` line, add:

```js
    if (name === 'analytics') analyticsView.show();
```

3. In the movies `onValue` listener, inside the existing `try` that calls `rebuildComments();`, add a line after it:

```js
        analyticsView.rerender();
```

4. In the comments `onValue` listener, after `translatePending();`, add:

```js
    analyticsView.rerender();
```

   It goes after `translatePending()` so nothing in the analytics view could ever delay translation; `rerender` also catches its own errors.

5. At the very end of `app.js`, add:

```js

// --- Analytics ---
//
// The view reads movies and comments through getters, so every render joins
// against what is loaded at that moment.
const analyticsView = initAnalyticsView({
    section: document.getElementById('analytics-view'),
    getMovies: () => allMovies,
    getCommentRows: () => commentRows
});
```

- [ ] **Step 4: Check syntax and tests**

Run: `node --check app.js && node --check analytics-view.js && npm test`
Expected: no syntax errors; 165 passing.

- [ ] **Step 5: Check the not-configured state in the browser**

With `.env` holding no GA variables, open Analytics with the harness. Expect the "Connect Google Analytics" card with five numbered steps, three links, and a "Check again" button; no page errors. Clicking "Check again" re-requests and shows the same card.

- [ ] **Step 6: Check a rendered report with a fixture**

GA credentials may not exist yet, so drive the view with a fixture. Before navigation, inject a `fetch` override with the DevTools `Page.addScriptToEvaluateOnNewDocument` that answers `/api/analytics` with this payload (and passes every other URL to the real `fetch`):

```js
({
    range: 28,
    audience: {
        activeUsers: 4812, newUsers: 1203, sessions: 9940, engagementSeconds: 1443600,
        daily: Array.from({ length: 28 }, (_, i) => ({
            date: new Date(Date.UTC(2026, 7, 24 + i)).toISOString().slice(0, 10),
            activeUsers: 140 + Math.round(40 * Math.sin(i / 3)) + i * 2
        }))
    },
    where: {
        countries: [{ name: 'Myanmar', users: 2100 }, { name: 'Philippines', users: 640 }, { name: '(not set)', users: 12 }],
        languages: [{ name: 'Burmese', users: 1900 }, { name: 'English', users: 1400 }],
        osVersions: [{ name: '14', users: 2000 }, { name: '13', users: 1500 }],
        appVersions: [{ name: '2.1', users: 3800 }, { name: '2.0', users: 900 }]
    },
    movies: {
        key: 'title',
        clicks: { 'Terra Nova': 812, 'Luck Key': 530, 'The Night Clerk': 300 },
        plays: { 'Terra Nova': 640, 'Luck Key': 411, 'The Night Clerk': 120, 'Old Renamed Title': 44 },
        completes: { 'Terra Nova': 282, 'Luck Key': 156, 'The Night Clerk': 30 }
    },
    categories: [{ name: 'Action', views: 900 }, { name: 'Top Picks', views: 700 }, { name: 'Horror', views: 260 }],
    missingDimensions: [],
    notes: { thresholded: true, otherRow: false }
})
```

Expect the caveat line ("Google withheld some small groups…") and four tiles reading 4,812 · 1,203 · 9,940 · 5m 0s. No page errors.

- [ ] **Step 7: Commit**

```bash
git add analytics-view.js style.css app.js
git commit -m "feat: add the analytics view with setup, error and audience states"
```

---

### Task 9: The daily active users chart

**Files:**
- Modify: `analytics-view.js`

One series, so no legend: the card's title names it. The line is 2px over a 10% wash, ending in a ringed dot labelled with its value. The y axis has clean ticks (0, half, max). The whole plot is the hover target, with a crosshair that snaps to the nearest day, and the arrow keys do the same from the keyboard. A "Show as table" twin makes every value reachable without hovering.

- [ ] **Step 1: Add the chart**

In `analytics-view.js`, add after the `el` function:

```js
const SVG_NS = 'http://www.w3.org/2000/svg';

function svg(tag, attrs = {}) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
    return node;
}

// "2026-09-01" is a calendar date, so it is formatted in UTC: in a timezone west
// of UTC, local time would turn it into August 31.
const shortDateFormat = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const longDateFormat = new Intl.DateTimeFormat('en', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const asDate = (iso) => new Date(`${iso}T00:00:00Z`);
const shortDate = (iso) => shortDateFormat.format(asDate(iso));
const longDate = (iso) => longDateFormat.format(asDate(iso));

// The smallest clean maximum at or above the value, chosen so the middle tick
// (half of it) is a whole number too. Finer steps keep the line from using only
// half the plot: a peak of 228 gets 300, not 400. Below 10, a step of 3 would
// put the middle tick on 1.5, so small values use even steps only.
function niceMax(value) {
    const power = 10 ** Math.floor(Math.log10(Math.max(value, 1)));
    const steps = power >= 10 ? [1, 2, 3, 4, 5, 6, 8, 10] : [1, 2, 4, 6, 8, 10];
    for (const step of steps) {
        if (step * power >= value) return step * power;
    }
    return 10 * power;
}

function lineChart(points) {
    const W = 720;
    const H = 220;
    const pad = { top: 16, right: 56, bottom: 28, left: 44 };
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;

    const max = niceMax(Math.max(...points.map((point) => point.activeUsers), 1));
    const last = points.length - 1;
    const x = (i) => pad.left + (last === 0 ? plotW / 2 : (i / last) * plotW);
    const y = (value) => pad.top + plotH - (value / max) * plotH;

    const wrap = el('div', 'line-chart');
    const chart = svg('svg', {
        viewBox: `0 0 ${W} ${H}`,
        role: 'img',
        'aria-label': `Daily active users from ${longDate(points[0].date)} to ${longDate(points[last].date)}`
    });

    // Recessive 1px grid at clean ticks; a tick at half is skipped when max is 1.
    const ticks = max > 1 ? [0, max / 2, max] : [0, max];
    for (const tick of ticks) {
        chart.append(svg('line', { class: 'chart-grid', x1: pad.left, x2: pad.left + plotW, y1: y(tick), y2: y(tick) }));
        const label = svg('text', { class: 'chart-tick', x: pad.left - 8, y: y(tick) + 4, 'text-anchor': 'end' });
        label.textContent = formatCompact(tick);
        chart.append(label);
    }
    for (const [i, anchor] of [[0, 'start'], [last, 'end']]) {
        const label = svg('text', { class: 'chart-tick', x: x(i), y: H - 8, 'text-anchor': anchor });
        label.textContent = shortDate(points[i].date);
        chart.append(label);
    }

    const line = points.map((point, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(point.activeUsers).toFixed(1)}`).join(' ');
    chart.append(svg('path', { class: 'chart-area', d: `${line} L${x(last).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z` }));
    chart.append(svg('path', { class: 'chart-line', d: line }));

    // The end: a ringed dot and its value, the one label on the line.
    chart.append(svg('circle', { class: 'chart-dot', cx: x(last), cy: y(points[last].activeUsers), r: 4 }));
    const endLabel = svg('text', { class: 'chart-end-label', x: x(last) + 10, y: y(points[last].activeUsers) + 4 });
    endLabel.textContent = formatCompact(points[last].activeUsers);
    chart.append(endLabel);

    const crosshair = svg('line', { class: 'chart-crosshair', y1: pad.top, y2: pad.top + plotH, visibility: 'hidden' });
    const marker = svg('circle', { class: 'chart-dot', r: 4, visibility: 'hidden' });
    // The hit area is the whole plot, never the 2px line: readers aim at a day.
    const hit = svg('rect', {
        class: 'chart-hit', x: pad.left, y: pad.top, width: plotW, height: plotH, tabindex: 0,
        'aria-label': 'Daily active users. Use the left and right arrow keys to read each day.'
    });
    chart.append(crosshair, marker, hit);

    const tooltip = el('div', 'chart-tooltip');
    tooltip.hidden = true;
    wrap.append(chart, tooltip);

    let index = last;
    const showAt = (i) => {
        index = Math.max(0, Math.min(last, i));
        const px = x(index);
        const py = y(points[index].activeUsers);
        for (const [name, value] of [['x1', px], ['x2', px], ['visibility', 'visible']]) crosshair.setAttribute(name, String(value));
        for (const [name, value] of [['cx', px], ['cy', py], ['visibility', 'visible']]) marker.setAttribute(name, String(value));

        // Value first and strong; the date follows.
        tooltip.replaceChildren(
            el('strong', null, formatCount(points[index].activeUsers)),
            el('span', null, `users · ${longDate(points[index].date)}`)
        );
        tooltip.hidden = false;
        // The SVG scales with its container, so convert to CSS pixels.
        const scale = chart.getBoundingClientRect().width / W;
        tooltip.style.left = `${px * scale}px`;
        tooltip.style.top = `${py * scale}px`;
    };
    const hide = () => {
        crosshair.setAttribute('visibility', 'hidden');
        marker.setAttribute('visibility', 'hidden');
        tooltip.hidden = true;
    };

    hit.addEventListener('pointermove', (event) => {
        const box = chart.getBoundingClientRect();
        const svgX = (event.clientX - box.left) * (W / box.width);
        showAt(last === 0 ? 0 : Math.round(((svgX - pad.left) / plotW) * last));
    });
    hit.addEventListener('pointerleave', hide);
    hit.addEventListener('focus', () => showAt(index));
    hit.addEventListener('blur', hide);
    hit.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowLeft') showAt(index - 1);
        else if (event.key === 'ArrowRight') showAt(index + 1);
        else return;
        event.preventDefault();
    });

    return wrap;
}

// The chart's table-view twin: every value reachable without hovering.
function dailyTable(points) {
    const details = el('details', 'chart-table');
    details.append(el('summary', null, 'Show as table'));
    const table = el('table', 'data-table');
    const headRow = el('tr');
    headRow.append(el('th', null, 'Date'), el('th', 'num', 'Active users'));
    const head = el('thead');
    head.append(headRow);
    const rows = el('tbody');
    for (const point of points) {
        const row = el('tr');
        row.append(el('td', null, longDate(point.date)), el('td', 'num', formatCount(point.activeUsers)));
        rows.append(row);
    }
    table.append(head, rows);
    details.append(table);
    return details;
}
```

- [ ] **Step 2: Put the chart in the audience section**

In `audienceSection`, replace the final `section.append(tiles);\n    return section;` with:

```js
    section.append(tiles);

    const card = el('div', 'analytics-card');
    card.append(el('h4', 'chart-title', 'Daily active users'));
    if (audience.daily.length) {
        card.append(lineChart(audience.daily), dailyTable(audience.daily));
    } else {
        card.append(el('p', 'analytics-empty', 'No activity in this period.'));
    }
    section.append(card);
    return section;
```

- [ ] **Step 3: Check syntax and tests**

Run: `node --check analytics-view.js && npm test`
Expected: no syntax error; 165 passing.

- [ ] **Step 4: Check the chart in the browser with the fixture**

Using the Task 8 fixture: the chart renders a line, an area and an end dot labelled with the last value; the end label reads 210; y ticks read 0, 150 and 300; x ticks read "Aug 24" and "Sep 20". Moving the pointer across the plot shows the crosshair, the marker and a tooltip whose value matches that day. Focusing the plot and pressing ← moves back one day. "Show as table" lists 28 rows. No page errors. Take a screenshot and look at it for label collisions or clipping.

- [ ] **Step 5: Commit**

```bash
git add analytics-view.js
git commit -m "feat: chart daily active users with a crosshair and a table view"
```

---

### Task 10: The movie table

**Files:**
- Modify: `analytics-view.js`

- [ ] **Step 1: Add the movie section**

In `analytics-view.js`, add after `dailyTable`:

```js
const TABLE_PAGE = 25;

const plural = (count, word) => `${formatCount(count)} ${count === 1 ? word : `${word}s`}`;

// Only real web images: a thumbnail URL comes from the database, which anyone
// can write to.
const isSafeImage = (url) => typeof url === 'string' && /^https:\/\//.test(url);

// What to register in GA4 for a section to appear, and that GA does not fill in
// the past.
function missingNote(params, what) {
    const note = el('div', 'analytics-missing');
    note.append(el('p', null, `${what} need these custom dimensions registered in GA4 → Admin → Custom definitions, with scope Event:`));
    const list = el('p', 'missing-params');
    for (const param of params) list.append(el('code', null, param));
    note.append(list);
    note.append(el('p', 'analytics-footnote', 'Data starts from the day each one is registered; GA does not fill in the past.'));
    return note;
}

function titleList(summary, items) {
    const details = el('details', 'title-list');
    details.append(el('summary', null, summary));
    const list = el('ul');
    for (const item of items) list.append(el('li', null, item));
    details.append(list);
    return details;
}

function movieTable(rows, hasClicks) {
    const wrap = el('div', 'movie-stats-wrap');
    const table = el('table', 'data-table movie-stats');
    const headRow = el('tr');
    headRow.append(
        el('th', null, 'Movie'), el('th', 'num', 'Clicks'), el('th', 'num', 'Plays'),
        el('th', 'num', 'Completed'), el('th', 'num', 'Completion'), el('th', 'num', 'Comments')
    );
    const head = el('thead');
    head.append(headRow);
    const body = el('tbody');

    const fill = (count) => body.replaceChildren(...rows.slice(0, count).map((row) => {
        const tr = el('tr');
        const cell = el('td', 'movie-cell');
        const thumb = el('span', 'movie-thumb');
        if (isSafeImage(row.thumbnail)) {
            const img = el('img');
            img.src = row.thumbnail;
            img.alt = '';
            img.loading = 'lazy';
            // A broken image leaves the empty slot, so titles stay aligned.
            img.addEventListener('error', () => img.remove());
            thumb.append(img);
        }
        cell.append(thumb, el('span', 'movie-name', row.title));
        if (row.copies > 1) cell.append(el('span', 'copies-badge', `${row.copies} copies`));
        tr.append(
            cell,
            el('td', 'num', hasClicks ? formatCount(row.clicks) : '—'),
            el('td', 'num strong', formatCount(row.plays)),
            el('td', 'num', formatCount(row.completes)),
            el('td', 'num', formatPercent(row.completionRate)),
            el('td', 'num', formatCount(row.comments))
        );
        return tr;
    }));

    fill(TABLE_PAGE);
    table.append(head, body);
    wrap.append(table);

    if (rows.length > TABLE_PAGE) {
        const more = el('button', 'btn btn-ghost btn-sm', `Show all ${formatCount(rows.length)}`);
        more.type = 'button';
        more.addEventListener('click', () => {
            fill(rows.length);
            more.remove();
        });
        wrap.append(more);
    }
    return wrap;
}

function movieSection(data, library, commentRows) {
    const section = el('section', 'analytics-section');
    section.append(el('h3', 'analytics-heading', 'Movie performance'));
    const card = el('div', 'analytics-card');
    section.append(card);

    if (!data.movies) {
        card.append(missingNote(data.missingDimensions.filter((param) => param !== 'category_name'), 'Per-movie figures'));
        return section;
    }

    const { startMs, endMs } = rangeBounds(data.range);
    const comments = commentsInRange(commentRows, startMs, endMs);
    const { rows, neverPlayed, notInLibrary } = buildMovieRows(data.movies, library, comments);
    const hasClicks = data.movies.clicks !== null;

    if (!hasClicks) {
        const clickParams = data.missingDimensions.filter((param) => param === 'item_name' || param === 'item_id');
        if (clickParams.length) card.append(missingNote(clickParams, 'Clicks'));
    }

    card.append(rows.length ? movieTable(rows, hasClicks) : el('p', 'analytics-empty', 'No plays in this period.'));
    card.append(el('p', 'analytics-footnote',
        "Plays can count twice when a viewer switches to fullscreen — a quirk in the app's logging — which also pulls completion rates down."));

    if (neverPlayed.length) {
        card.append(titleList(
            `No plays in this period: ${plural(neverPlayed.length, 'title')}`,
            neverPlayed.map((row) => (row.copies > 1 ? `${row.title} (${row.copies} copies)` : row.title))
        ));
    }
    if (notInLibrary.length) {
        card.append(titleList(
            `Renamed or removed: ${plural(notInLibrary.length, 'title')} still in Google Analytics`,
            notInLibrary.map((row) => `${row.key} — ${plural(row.plays, 'play')}`)
        ));
    }
    return section;
}
```

- [ ] **Step 2: Add it to the report**

In `buildReport`, after `parts.push(audienceSection(data.audience));`, add:

```js
    parts.push(movieSection(data, movies, commentRows));
```

- [ ] **Step 3: Check syntax and tests**

Run: `node --check analytics-view.js && npm test`
Expected: no syntax error; 165 passing.

- [ ] **Step 4: Check the table in the browser with the fixture**

Using the Task 8 fixture against the real library: the table's first rows are Terra Nova, Luck Key and The Night Clerk in that order, and both Terra Nova and The Night Clerk show a "2 copies" badge — each really is duplicated in the library. Terra Nova's completion reads 44%. "Renamed or removed" lists "Old Renamed Title — 44 plays". "No plays in this period" counts the rest of the library. Thumbnails load. No page errors.

- [ ] **Step 5: Commit**

```bash
git add analytics-view.js
git commit -m "feat: show movie performance per title, joined to the library"
```

---

### Task 11: Categories and devices

**Files:**
- Modify: `analytics-view.js`

Ranked bars in the single series colour, not a darker-for-bigger ramp: countries, languages and categories are nominal, and a ramp would double-encode length. Each bar carries its value at the tip, so nothing is hover-only; hovering or focusing a row lifts it.

- [ ] **Step 1: Add the bar lists and both sections**

In `analytics-view.js`, add after `movieSection`:

```js
function barList(items, unit) {
    const max = Math.max(...items.map((item) => item.value), 1);
    const list = el('ol', 'bar-list');
    for (const item of items) {
        const row = el('li', 'bar-row');
        row.tabIndex = 0;
        row.setAttribute('aria-label', `${item.name}: ${formatCount(item.value)} ${unit}`);

        const name = el('span', 'bar-name', item.name);
        name.title = item.name;
        const track = el('span', 'bar-track');
        const fill = el('span', 'bar-fill');
        fill.style.width = `${(item.value / max) * 100}%`;
        track.append(fill);

        row.append(name, track, el('span', 'bar-value', formatCount(item.value)));
        list.append(row);
    }
    return list;
}

function categorySection(data) {
    const section = el('section', 'analytics-section');
    section.append(el('h3', 'analytics-heading', 'Categories'));
    const card = el('div', 'analytics-card');
    section.append(card);

    if (!data.categories) {
        card.append(missingNote(['category_name'], 'Category views'));
    } else if (!data.categories.length) {
        card.append(el('p', 'analytics-empty', 'No category views in this period.'));
    } else {
        card.append(el('h4', 'chart-title', 'Opened from the Home screen'));
        card.append(barList(data.categories.map((category) => ({ name: category.name, value: category.views })), 'views'));
    }
    return section;
}

// GA's "(not set)" is shown as "Unknown"; bare version numbers get a prefix,
// joined as given: "Android 14", "v2.1".
function displayName(name, prefix = '') {
    if (name === '(not set)' || name === '') return 'Unknown';
    return `${prefix}${name}`;
}

function whereSection(where) {
    const section = el('section', 'analytics-section');
    section.append(el('h3', 'analytics-heading', 'Where & devices'));
    const grid = el('div', 'bar-grid');

    for (const [title, items, prefix] of [
        ['Countries', where.countries, ''],
        ['Languages', where.languages, ''],
        ['Android versions', where.osVersions, 'Android '],
        ['App versions', where.appVersions, 'v']
    ]) {
        const card = el('div', 'analytics-card');
        card.append(el('h4', 'chart-title', `${title} · active users`));
        card.append(items.length
            ? barList(items.map((item) => ({ name: displayName(item.name, prefix), value: item.users })), 'active users')
            : el('p', 'analytics-empty', 'No data in this period.'));
        grid.append(card);
    }
    section.append(grid);
    return section;
}
```

- [ ] **Step 2: Add them to the report**

In `buildReport`, after the `movieSection` line, add:

```js
    parts.push(categorySection(data));
    parts.push(whereSection(data.where));
```

- [ ] **Step 3: Check syntax and tests**

Run: `node --check analytics-view.js && npm test`
Expected: no syntax error; 165 passing.

- [ ] **Step 4: Check the bars in the browser with the fixture**

Using the Task 8 fixture: Categories shows three bars, Action longest. Where & devices shows four cards; Countries lists "Unknown" for `(not set)`; Android versions read "Android 14" and "Android 13"; app versions read "v2.1" and "v2.0". Every bar shows its value; Tab moves focus through the rows and the focused row lifts. No page errors. Screenshot and check for truncated names or overflow.

- [ ] **Step 5: Commit**

```bash
git add analytics-view.js
git commit -m "feat: show categories and devices as ranked bars"
```

---

### Task 12: Full verification

**Files:** none

- [ ] **Step 1: Run the whole suite**

Run: `npm test`
Expected: 165 passing, 0 failing.

- [ ] **Step 2: Walk the section with the fixture**

With the harness and the Task 8 fixture, confirm each:

- [ ] Movies and Comments views behave exactly as before; the last-added panel stays hidden on Analytics even when forced visible
- [ ] Analytics opens with the caveat line, four tiles, the chart, the movie table, categories and four device lists
- [ ] Switching to "Last 7 days" dims the current figures, requests `range=7`, and replaces them — no spinner, no layout jump
- [ ] Clicking two ranges quickly shows the second one's figures, never the first's
- [ ] Opening Analytics a second time does not refetch
- [ ] The browser console is free of errors throughout

- [ ] **Step 3: Check the partial states with fixture variants**

- `movies: null, categories: null, missingDimensions: ['movie_title', 'item_name', 'category_name']` → the tiles and device lists render; Movie performance and Categories each show the dimensions to register.
- `movies: { key: 'title', clicks: null, … }, missingDimensions: ['item_name']` → the table renders with "—" under Clicks, and a note names `item_name`.
- A 403 `{ error: 'no_access', serviceAccount: 'x@y.iam.gserviceaccount.com' }` → the refused-access card shows the email.
- A 502 `{ error: 'ga_error', detail: 'Backend error' }` → the error card shows "Backend error" and a Retry button that re-requests.

- [ ] **Step 4: Check against the real property (once credentials exist)**

This step waits for the user's setup (spec §6). It only reads GA, so it is safe to run against real data. Put `GA_PROPERTY_ID` and `GA_SERVICE_ACCOUNT_KEY` in `.env`, then:

```bash
PORT=3055 node dev-server.js & PID=$!
curl -s --retry 10 --retry-connrefused --retry-delay 1 "http://localhost:3055/api/analytics?range=28" | head -c 1500; echo
kill $PID
```

Expected: a 200 whose `movies.key` is `"title"`, whose `plays` names real library titles, and whose `missingDimensions` lists only what is truly unregistered. Then open Analytics in the harness against the real endpoint and confirm the figures render with no page errors. Compare one number — active users for the last 28 days — against the GA4 web interface to confirm the two agree.

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix: address issues found in analytics verification"
```

---

## Notes for the implementer

**Nothing here writes anywhere.** The endpoint only reads GA, and the view only reads the library and comments already in memory. Unlike the reply and delete flows, every path can be exercised against real data.

**The service account key is a credential.** It lives in `.env` (gitignored) and in Vercel's environment variables, never in the repository. The endpoint never returns it; the one thing it echoes is the service account's email, which is what the admin needs to grant access.

**Titles, not ids, are the join key** because the title dimensions are what the admin registered and what carries history. That is also why the 35 duplicated titles get one combined row: GA holds one figure for both copies.

**Out of scope:** `/api/analytics` has no authentication, like the rest of the dashboard. Per-install watch history needs GA's BigQuery export and is a separate spec.
