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
