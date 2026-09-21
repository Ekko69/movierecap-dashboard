import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectScript, needsTranslation, TARGET_LANG, ADMIN_NAME, flattenComments } from './comments.js';

test('detectScript names the scripts present in the live data', () => {
    assert.equal(detectScript('ဘာသာပြန်ပေးပါ'), 'myanmar');
    assert.equal(detectScript('انشئ لي فيلم مغربي'), 'arabic');
    assert.equal(detectScript('สวัสดี'), 'thai');
    assert.equal(detectScript('how can download this video?'), 'latin');
});

test('detectScript covers the remaining listed scripts', () => {
    // Every branch is exercised: a swapped or typo'd range would otherwise
    // reach production unnoticed.
    assert.equal(detectScript('안녕하세요'), 'hangul');
    assert.equal(detectScript('नमस्ते'), 'devanagari');
    assert.equal(detectScript('Привет'), 'cyrillic');
    assert.equal(detectScript('Καλημέρα'), 'greek');
    assert.equal(detectScript('שלום'), 'hebrew');
});

test('detectScript prefers kana over han for Japanese text', () => {
    // Japanese mixes kana with han characters; kana is the deciding signal,
    // so this only passes while kana is checked first.
    assert.equal(detectScript('これは映画です'), 'kana');
    assert.equal(detectScript('电影'), 'han');
});

test('detectScript names the script, never the language', () => {
    // Persian is written in Arabic script and Ukrainian in Cyrillic. Reporting
    // 'arabic' and 'cyrillic' keeps callers from treating these as language
    // codes and translating a reply into the wrong language entirely.
    assert.equal(detectScript('سلام خوبی'), 'arabic');
    assert.equal(detectScript('Привіт, як справи?'), 'cyrillic');
});

test('detectScript prefers a non-latin script in mixed text', () => {
    // The part that needs translating decides.
    assert.equal(detectScript('ok ဘာသာပြန်ပေးပါ'), 'myanmar');
});

test('detectScript distinguishes an unrecognized script from latin', () => {
    // Real letters in a script not listed. It must NOT come back as 'latin',
    // or a caller would read it as "already in the admin's language".
    assert.equal(detectScript('አማርኛ'), 'unknown');      // Amharic
    assert.equal(detectScript('ქართული'), 'unknown');    // Georgian
});

test('detectScript handles Latin scripts beyond the basic range', () => {
    // Vietnamese and Yoruba stack diacritics into Latin Extended Additional.
    // A hand-rolled A-Z range reported these as an unrecognized script.
    assert.equal(detectScript('ạệộ'), 'latin');
    assert.equal(detectScript('ẹọṣ'), 'latin');
    assert.equal(detectScript('không có gì'), 'latin');
});

test('detectScript covers the extended blocks of listed scripts', () => {
    assert.equal(detectScript('ὶ'), 'greek');        // Greek Extended, polytonic
    assert.equal(detectScript('ࡰ'), 'arabic');  // Arabic Extended-B
});

test('detectScript treats mathematical symbols as no language', () => {
    // × and ÷ sit inside the Latin-1 range but are symbols, not letters.
    assert.equal(detectScript('5×3'), 'empty');
    assert.equal(detectScript('÷'), 'empty');
});

test('detectScript reports empty when there is no language present', () => {
    assert.equal(detectScript(''), 'empty');
    assert.equal(detectScript(null), 'empty');
    assert.equal(detectScript(undefined), 'empty');
    assert.equal(detectScript('💜'), 'empty');
    assert.equal(detectScript('!!!'), 'empty');
    assert.equal(detectScript('123'), 'empty');
});

test('detectScript and needsTranslation agree on non-string input', () => {
    // Firebase should never hand these back, but the two functions must not
    // disagree about the same value.
    assert.equal(detectScript([]), 'empty');
    assert.equal(needsTranslation([]), false);
    assert.equal(detectScript(42), 'empty');
    assert.equal(needsTranslation(42), false);
});

test('needsTranslation is false for text carrying no letters', () => {
    // 10 comments in the live data are emoji only. They must never be sent.
    assert.equal(needsTranslation('💜'), false);
    assert.equal(needsTranslation('!!!'), false);
    assert.equal(needsTranslation('123'), false);
    assert.equal(needsTranslation('   '), false);
    assert.equal(needsTranslation(''), false);
    assert.equal(needsTranslation(null), false);
});

test('needsTranslation is true for any text containing letters', () => {
    assert.equal(needsTranslation('hi'), true);
    assert.equal(needsTranslation('ဘာသာပြန်ပေးပါ'), true);
    assert.equal(needsTranslation('good 👍'), true);
    assert.equal(needsTranslation('Καλημέρα'), true);
});

test('module constants are the values the spec fixed', () => {
    assert.equal(TARGET_LANG, 'en');
    assert.equal(ADMIN_NAME, 'Movie Recap');
});

const MOVIES = new Map([
    ['movie-a', { id: 'movie-a', title: 'Terra Nova' }],
    ['movie-b', { id: 'movie-b', title: 'Deep Water' }]
]);

const TREE = {
    'movie-a': {
        'c-old': { movieId: 'movie-a', text: 'first', userName: 'Kind Panda', timestamp: 1000 },
        'c-new': {
            movieId: 'movie-a',
            text: 'ဘာသာပြန်ပေးပါ',
            userName: 'Fancy Lion',
            timestamp: 3000,
            replies: {
                'r-2': { text: 'second reply', userName: 'Calm Raptor', timestamp: 5000 },
                'r-1': { text: 'first reply', userName: 'Movie Recap', timestamp: 4000, isAdmin: true }
            }
        }
    },
    'movie-b': {
        'c-mid': { movieId: 'movie-b', text: 'hi', userName: 'Witty Dog', timestamp: 2000 }
    }
};

test('flattenComments returns every comment newest first', () => {
    const rows = flattenComments(TREE, MOVIES);
    assert.deepEqual(rows.map(r => r.id), ['c-new', 'c-mid', 'c-old']);
});

test('flattenComments joins each row to its movie title', () => {
    const rows = flattenComments(TREE, MOVIES);
    assert.equal(rows[0].movieTitle, 'Terra Nova');
    assert.equal(rows[1].movieTitle, 'Deep Water');
});

test('flattenComments labels a comment whose movie is gone', () => {
    // A movie deleted after being commented on. The live data has none today,
    // but deleting a movie does not delete its comments.
    const rows = flattenComments({ 'ghost': { 'c1': { text: 'x', timestamp: 1 } } }, MOVIES);
    assert.equal(rows[0].movieTitle, 'Unknown movie');
    assert.equal(rows[0].movieId, 'ghost');
});

test('flattenComments attaches replies oldest first under their parent', () => {
    const rows = flattenComments(TREE, MOVIES);
    const threaded = rows.find(r => r.id === 'c-new');
    assert.deepEqual(threaded.replies.map(r => r.id), ['r-1', 'r-2']);
    assert.equal(threaded.replies[0].isAdmin, true);
    assert.equal(threaded.replies[1].isAdmin, false);
    // Replies never become rows of their own.
    assert.equal(rows.length, 3);
});

test('flattenComments breaks timestamp ties by id so renders are stable', () => {
    const tied = { 'm': { 'b': { text: 'b', timestamp: 7 }, 'a': { text: 'a', timestamp: 7 } } };
    assert.deepEqual(flattenComments(tied, MOVIES).map(r => r.id), ['a', 'b']);
});

test('flattenComments fills in missing fields rather than emitting undefined', () => {
    const sparse = { 'movie-a': { 'c1': {} } };
    const [row] = flattenComments(sparse, MOVIES);
    assert.equal(row.text, '');
    assert.equal(row.userName, 'Anonymous');
    assert.equal(row.timestamp, 0);
    assert.deepEqual(row.replies, []);
});

test('flattenComments survives empty and malformed trees', () => {
    assert.deepEqual(flattenComments(null, MOVIES), []);
    assert.deepEqual(flattenComments({}, MOVIES), []);
    assert.deepEqual(flattenComments({ 'movie-a': null }, MOVIES), []);
    assert.deepEqual(flattenComments({ 'movie-a': { 'c1': null } }, MOVIES), []);
});

test('flattenComments works with no movie map supplied', () => {
    const rows = flattenComments({ 'movie-a': { 'c1': { text: 'x', timestamp: 1 } } });
    assert.equal(rows[0].movieTitle, 'Unknown movie');
});
