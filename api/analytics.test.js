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
