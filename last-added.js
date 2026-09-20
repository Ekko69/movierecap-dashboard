// Pure helpers for the "last added movie" panel.
//
// This module deliberately imports nothing. app.js cannot be loaded by Node —
// it imports Firebase over https:// URLs and reads window.CONFIG at module
// load — so any logic that deserves a unit test lives here instead.

// Canonical watch URL for a YouTube video id, or null when there is no id.
export function youtubeWatchURL(videoId) {
    if (!videoId) return null;
    return `https://www.youtube.com/watch?v=${videoId}`;
}

// Canonical watch URL for a pasted string, or null when it holds no video id.
// extractVideoId is injected (app.js owns the real one) to keep this module
// import-free.
export function buildSourceURL(input, extractVideoId) {
    if (!input) return null;
    const trimmed = String(input).trim();
    if (!trimmed) return null;
    return youtubeWatchURL(extractVideoId(trimmed));
}
