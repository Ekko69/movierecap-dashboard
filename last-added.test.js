import { test } from 'node:test';
import assert from 'node:assert/strict';

import { youtubeWatchURL, youtubeThumbnailURL, formatRelativeTime, pickLastAdded, videoIdFromSourceURL } from './last-added.js';

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
    // Computed, not hardcoded: formatRelativeTime renders the viewer's LOCAL
    // calendar day, which is the right thing to show a user but makes a literal
    // 'Sep 13, 2026' fail east of UTC+12. npm test also pins TZ=UTC.
    const weekAgo = NOW - 7 * DAY;
    const expected = new Date(weekAgo).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
    });
    assert.equal(formatRelativeTime(weekAgo, NOW), expected);
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

test('pickLastAdded returns the movie with the greatest updatedAt', () => {
    const movies = [
        { id: 'a', title: 'Alpha', updatedAt: 100 },
        { id: 'c', title: 'Gamma', updatedAt: 300 },
        { id: 'b', title: 'Beta', updatedAt: 200 }
    ];
    assert.equal(pickLastAdded(movies).id, 'c');
});

test('pickLastAdded treats a missing updatedAt as oldest', () => {
    const movies = [
        { id: 'legacy', title: 'No timestamp' },
        { id: 'fresh', title: 'Timestamped', updatedAt: 1 }
    ];
    assert.equal(pickLastAdded(movies).id, 'fresh');
});

test('pickLastAdded still returns a movie when every record predates updatedAt', () => {
    const movies = [{ id: 'x', title: 'X' }, { id: 'y', title: 'Y' }];
    assert.equal(pickLastAdded(movies).id, 'x');
});

test('pickLastAdded returns null for nothing to pick', () => {
    assert.equal(pickLastAdded([]), null);
    assert.equal(pickLastAdded(null), null);
    assert.equal(pickLastAdded(undefined), null);
});

test('pickLastAdded keeps the earlier movie on a tie', () => {
    const movies = [
        { id: 'a', title: 'Alpha', updatedAt: 5 },
        { id: 'b', title: 'Beta', updatedAt: 5 }
    ];
    assert.equal(pickLastAdded(movies).id, 'a');
});

test('pickLastAdded returns null for a non-array', () => {
    // What a caller handing over snapshot.val() directly would pass.
    assert.equal(pickLastAdded({}), null);
});

test('pickLastAdded survives a null element', () => {
    const movies = [null, { id: 'real', title: 'Real', updatedAt: 1 }];
    assert.equal(pickLastAdded(movies).id, 'real');
});

test('youtubeThumbnailURL derives the original frame from a source URL', () => {
    assert.equal(
        youtubeThumbnailURL('https://www.youtube.com/watch?v=trjp0T-eW6Q'),
        'https://i.ytimg.com/vi/trjp0T-eW6Q/mqdefault.jpg'
    );
});

test('youtubeThumbnailURL ignores trailing parameters', () => {
    assert.equal(
        youtubeThumbnailURL('https://www.youtube.com/watch?v=trjp0T-eW6Q&t=42s'),
        'https://i.ytimg.com/vi/trjp0T-eW6Q/mqdefault.jpg'
    );
});

test('youtubeThumbnailURL returns null when there is no usable source', () => {
    // Movies added before sourceURL existed, and anything uploaded from disk.
    assert.equal(youtubeThumbnailURL(null), null);
    assert.equal(youtubeThumbnailURL(''), null);
    assert.equal(youtubeThumbnailURL(undefined), null);
    assert.equal(youtubeThumbnailURL('https://firebasestorage.googleapis.com/x.mp4'), null);
});

test('youtubeThumbnailURL refuses a non-https source', () => {
    // The result goes straight into an <img src>, so no javascript:/data: input.
    assert.equal(youtubeThumbnailURL('javascript:alert(1)//watch?v=trjp0T-eW6Q'), null);
});

test('videoIdFromSourceURL reads the id out of a stored source URL', () => {
    assert.equal(
        videoIdFromSourceURL('https://www.youtube.com/watch?v=trjp0T-eW6Q'),
        'trjp0T-eW6Q'
    );
});

test('videoIdFromSourceURL ignores trailing parameters', () => {
    assert.equal(
        videoIdFromSourceURL('https://www.youtube.com/watch?v=trjp0T-eW6Q&t=42s'),
        'trjp0T-eW6Q'
    );
});

test('videoIdFromSourceURL accepts the no-www form', () => {
    assert.equal(
        videoIdFromSourceURL('https://youtube.com/watch?v=trjp0T-eW6Q'),
        'trjp0T-eW6Q'
    );
});

test('videoIdFromSourceURL returns null for anything else', () => {
    assert.equal(videoIdFromSourceURL(null), null);
    assert.equal(videoIdFromSourceURL(''), null);
    assert.equal(videoIdFromSourceURL(undefined), null);
    assert.equal(videoIdFromSourceURL('https://firebasestorage.googleapis.com/x.mp4'), null);
    assert.equal(videoIdFromSourceURL('http://www.youtube.com/watch?v=trjp0T-eW6Q'), null);
});
