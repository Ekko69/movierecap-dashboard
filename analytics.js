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
