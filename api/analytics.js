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
