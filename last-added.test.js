import { test } from 'node:test';
import assert from 'node:assert/strict';

import { youtubeWatchURL, buildSourceURL, formatRelativeTime } from './last-added.js';

test('youtubeWatchURL builds a canonical watch URL', () => {
    assert.equal(
        youtubeWatchURL('dQw4w9WgXcQ'),
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    );
});

test('youtubeWatchURL returns null for a missing id', () => {
    assert.equal(youtubeWatchURL(null), null);
    assert.equal(youtubeWatchURL(''), null);
    assert.equal(youtubeWatchURL(undefined), null);
});

// A stand-in for app.js's extractYouTubeVideoId, with the same contract:
// returns an 11-character id or null.
const fakeExtract = (url) => {
    const m = String(url).match(/[?&]v=([a-zA-Z0-9_-]{11})/);
    return m ? m[1] : null;
};

test('buildSourceURL strips playlist and timestamp parameters', () => {
    assert.equal(
        buildSourceURL(
            'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&t=42s',
            fakeExtract
        ),
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    );
});

test('buildSourceURL tolerates surrounding whitespace', () => {
    assert.equal(
        buildSourceURL('  https://www.youtube.com/watch?v=dQw4w9WgXcQ  ', fakeExtract),
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    );
});

test('buildSourceURL returns null when there is no video id', () => {
    assert.equal(buildSourceURL('https://example.com/nope', fakeExtract), null);
    assert.equal(buildSourceURL('', fakeExtract), null);
    assert.equal(buildSourceURL(null, fakeExtract), null);
});

// Fixed reference point so these assertions never depend on the wall clock.
const NOW = Date.UTC(2026, 8, 20, 12, 0, 0); // 2026-09-20T12:00:00Z
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test('formatRelativeTime describes the recent past', () => {
    assert.equal(formatRelativeTime(NOW - 5 * SEC, NOW), 'just now');
    assert.equal(formatRelativeTime(NOW - 59 * SEC, NOW), 'just now');
    assert.equal(formatRelativeTime(NOW - 1 * MIN, NOW), '1 min ago');
    assert.equal(formatRelativeTime(NOW - 59 * MIN, NOW), '59 min ago');
    assert.equal(formatRelativeTime(NOW - 1 * HOUR, NOW), '1 hr ago');
    assert.equal(formatRelativeTime(NOW - 23 * HOUR, NOW), '23 hr ago');
    assert.equal(formatRelativeTime(NOW - 1 * DAY, NOW), '1 day ago');
    assert.equal(formatRelativeTime(NOW - 6 * DAY, NOW), '6 days ago');
});

test('formatRelativeTime falls back to an absolute date past a week', () => {
    assert.equal(formatRelativeTime(NOW - 7 * DAY, NOW), 'Sep 13, 2026');
});

test('formatRelativeTime treats a future timestamp as just now', () => {
    // Clock skew between the browser and Firebase must not render "-3 min ago".
    assert.equal(formatRelativeTime(NOW + 3 * MIN, NOW), 'just now');
});

test('formatRelativeTime handles a missing timestamp', () => {
    assert.equal(formatRelativeTime(0, NOW), 'unknown');
    assert.equal(formatRelativeTime(null, NOW), 'unknown');
    assert.equal(formatRelativeTime(undefined, NOW), 'unknown');
});
