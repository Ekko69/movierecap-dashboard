// Pure helpers for the "last added movie" panel.
//
// This module deliberately imports nothing. app.js cannot be loaded by Node —
// it imports Firebase over https:// URLs and reads window.CONFIG at module
// load — so any logic that deserves a unit test lives here instead.

// Canonical watch URL for a YouTube video id, or null when there is no id.
export function youtubeWatchURL(videoId) {
    if (!videoId) return null;
    return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// Human-readable age of a timestamp. `now` is a parameter, not Date.now(), so
// this stays deterministic under test.
export function formatRelativeTime(timestamp, now = Date.now()) {
    if (!timestamp) return 'unknown';

    const elapsed = now - timestamp;

    // A timestamp in the future means clock skew between this browser and
    // whichever client wrote the record. "just now" is the honest reading;
    // a negative duration is not.
    if (elapsed < MINUTE_MS) return 'just now';

    if (elapsed < HOUR_MS) {
        return `${Math.floor(elapsed / MINUTE_MS)} min ago`;
    }
    if (elapsed < DAY_MS) {
        return `${Math.floor(elapsed / HOUR_MS)} hr ago`;
    }
    if (elapsed < 7 * DAY_MS) {
        const days = Math.floor(elapsed / DAY_MS);
        return `${days} day${days === 1 ? '' : 's'} ago`;
    }

    return new Date(Number(timestamp)).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
    });
}

// The most recently added movie. updatedAt is stamped only on creation (never
// on edit), so the greatest value is genuinely the last one added.
// Ties keep the earlier element.
export function pickLastAdded(movies) {
    if (!Array.isArray(movies) || movies.length === 0) return null;

    return movies.reduce((best, movie) => (
        (movie?.updatedAt || 0) > (best?.updatedAt || 0) ? movie : best
    ));
}
