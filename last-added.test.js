import { test } from 'node:test';
import assert from 'node:assert/strict';

import { youtubeWatchURL, buildSourceURL } from './last-added.js';

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
