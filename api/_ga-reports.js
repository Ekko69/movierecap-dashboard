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
