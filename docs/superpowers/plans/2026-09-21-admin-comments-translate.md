# Admin Comments Section with Auto-Translate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Comments section to the dashboard where the admin reads every user comment, sees non-English ones translated automatically, replies in the commenter's language, and deletes comments.

**Architecture:** Pure logic goes in a new `comments.js` (imports nothing, unit-tested under `node --test`) because `app.js` cannot be loaded by Node — it imports Firebase over `https://` URLs and reads `window.CONFIG` at module load. `app.js` keeps Firebase wiring, DOM rendering and events. Translation runs through a new `api/translate.js` serverless function copying the OpenAI-primary/Claude-fallback structure of `api/ai-service.js`, with results cached in a new top-level `commentTranslations/` node so `comments/` — the consumer app's data — is never written to by translation.

**Tech Stack:** Vanilla ES modules (no build step), Firebase Realtime Database v10.7.1 via CDN, Vercel serverless functions, `node --test` for tests.

**Spec:** `docs/superpowers/specs/2026-09-21-admin-comments-translate-design.md`

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `comments.js` | Create | Pure helpers: script detection, translation gating, tree flattening, reply formatting. Imports nothing. |
| `comments.test.js` | Create | `node --test` coverage for every `comments.js` export. |
| `api/translate.js` | Create | Batch translation endpoint + exported `parseTranslationResponse` for tests. |
| `api/translate.test.js` | Create | Tests for `parseTranslationResponse` (no network). |
| `index.html` | Modify | Comments nav button + `#comments-view` section markup. |
| `style.css` | Modify | Comments inbox, thread and reply dialog styles. |
| `app.js` | Modify | View router, comments listener, render, translation orchestration, reply, delete. |
| `dev-server.js` | Modify | Startup log line only (handlers resolve dynamically). |

**Known data shape** (confirmed against the live database):

```
comments/{movieId}/{pushId}/   → movieId, text, timestamp, userName
                                  replies/{pushId}/ → text, timestamp, userName
```

274 comments, 169 movies, 20 with replies, 54KB total.

---

### Task 1: Script detection and translation gating

**Files:**
- Create: `comments.js`
- Create: `comments.test.js`

**Design note — script is not language.** `detectScript` names a *writing system*, never a language. Persian and Urdu are written in Arabic script; Ukrainian and Bulgarian in Cyrillic; Japanese in a mix of kana and han. Returning `'ar'` for Persian text would invite using it as a translation target and reply to a Persian speaker in Arabic, confidently and wrongly. The translation target always comes from the language the model detects and stores, never from this function.

- [ ] **Step 1: Write the failing test**

Create `comments.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectScript, needsTranslation, TARGET_LANG, ADMIN_NAME } from './comments.js';

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
    assert.equal(detectScript('\u0870'), 'arabic');  // Arabic Extended-B
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './comments.js'`

- [ ] **Step 3: Write minimal implementation**

Create `comments.js`. Note the declaration order: `needsTranslation` must come before `detectScript`, which calls it.

```js
// Pure helpers for the admin comments section.
//
// This module deliberately imports nothing. app.js cannot be loaded by Node —
// it imports Firebase over https:// URLs and reads window.CONFIG at module
// load — so any logic that deserves a unit test lives here instead. Same
// reasoning as last-added.js.

// The language the admin reads. One admin, one language: a selector can be
// added when there is a second reader who needs a different one.
export const TARGET_LANG = 'en';

// The display name admin replies are posted under, seen by users in the app.
export const ADMIN_NAME = 'Movie Recap';

// Whether this text carries words worth sending to a translator. Emoji,
// punctuation and bare digits carry no language, so they never leave the
// browser.
export function needsTranslation(text) {
    if (!text) return false;
    return /\p{L}/u.test(String(text));
}

// Writing systems, checked in order. These name the SCRIPT, never the
// language — Persian and Urdu are written in Arabic script, Ukrainian and
// Bulgarian in Cyrillic. Naming these 'ar' or 'ru' would invite using them as
// a translation target and answer a Persian speaker in Arabic. The real
// language is whatever the model detects and stores.
//
// Unicode script properties rather than hand-written codepoint ranges: a
// literal range has to be kept in step with every extended block, and getting
// it wrong is silent. \p{Script=Latin} already knows that Vietnamese's ệ and
// Yoruba's ṣ are Latin, that ὶ is Greek, and that × and ÷ are neither.
//
// Kana precedes han because Japanese mixes the two and han alone would report
// Japanese as han. Latin comes last so mixed text reports the script that
// actually needs translating.
const SCRIPT_PATTERNS = [
    ['myanmar', /\p{Script=Myanmar}/u],
    ['arabic', /\p{Script=Arabic}/u],
    ['thai', /\p{Script=Thai}/u],
    ['kana', /\p{Script=Hiragana}|\p{Script=Katakana}/u],
    ['hangul', /\p{Script=Hangul}/u],
    ['han', /\p{Script=Han}/u],
    ['devanagari', /\p{Script=Devanagari}/u],
    ['cyrillic', /\p{Script=Cyrillic}/u],
    ['greek', /\p{Script=Greek}/u],
    ['hebrew', /\p{Script=Hebrew}/u],
    ['latin', /\p{Script=Latin}/u]
];

// The writing system a comment uses. This drives a UI hint and nothing else.
//
// 'unknown' means real letters in a script not listed above, kept distinct
// from 'latin' so no caller can mistake an unrecognized script for text
// already in the admin's language and skip translating it.
export function detectScript(text) {
    const value = String(text ?? '');
    if (!value) return 'empty';

    for (const [script, pattern] of SCRIPT_PATTERNS) {
        if (pattern.test(value)) return script;
    }

    return needsTranslation(value) ? 'unknown' : 'empty';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — all 14 new tests pass, existing `last-added.test.js` tests still pass.

- [ ] **Step 5: Commit**

```bash
git add comments.js comments.test.js
git commit -m "feat: add script detection and translation gating for comments"
```

---

### Task 2: Flatten the comments tree into an inbox

**Files:**
- Modify: `comments.js`
- Modify: `comments.test.js`

- [ ] **Step 1: Write the failing test**

Append to `comments.test.js`:

```js
import { flattenComments } from './comments.js';

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
```


Also append these, covering the reply path and both comparator hazards:

```js
test('flattenComments normalizes a timestamp the database cannot be trusted to type', () => {
    // Schemaless database: another client version may have written a string.
    // NaN in a comparator silently scrambles order, so it is normalized away.
    const tree = { m: {
        'b-bad': { text: 'bad', timestamp: 'not-a-number' },
        'z-valid': { text: 'z', timestamp: 100 },
        'a-valid': { text: 'a', timestamp: 200 }
    } };
    const rows = flattenComments(tree);
    assert.deepEqual(rows.map(r => r.id), ['a-valid', 'z-valid', 'b-bad']);
    assert.equal(rows[2].timestamp, 0);
});

test('flattenComments accepts a numeric string timestamp', () => {
    assert.equal(flattenComments({ m: { c1: { text: 'x', timestamp: '1500' } } })[0].timestamp, 1500);
});

test('flattenComments orders tied ids by codepoint, as push ids expect', () => {
    // Codepoint order is '-'(45) < 'Z'(90) < '_'(95). localeCompare gives a
    // different, ICU- and locale-dependent answer.
    const tree = { m: {
        '_b': { text: 'b', timestamp: 7 },
        '-a': { text: 'a', timestamp: 7 },
        'Zc': { text: 'c', timestamp: 7 }
    } };
    assert.deepEqual(flattenComments(tree).map(r => r.id), ['-a', 'Zc', '_b']);
});

test('flattenComments orders tied replies by codepoint too', () => {
    const tree = { m: { c1: { text: 'p', timestamp: 1, replies: {
        '_b': { text: 'b', timestamp: 5 },
        '-a': { text: 'a', timestamp: 5 }
    } } } };
    assert.deepEqual(flattenComments(tree)[0].replies.map(r => r.id), ['-a', '_b']);
});

test('flattenComments defaults reply fields the way it defaults comment fields', () => {
    const [reply] = flattenComments({ m: { c1: { text: 'p', timestamp: 1, replies: { r1: {} } } } })[0].replies;
    assert.equal(reply.text, '');
    assert.equal(reply.userName, 'Anonymous');
    assert.equal(reply.timestamp, 0);
    assert.equal(reply.isAdmin, false);
});

test('flattenComments survives malformed replies', () => {
    const cases = [
        { c1: { text: 'p', timestamp: 1, replies: null } },
        { c1: { text: 'p', timestamp: 1, replies: 'nonsense' } },
        { c1: { text: 'p', timestamp: 1, replies: { r1: null } } }
    ];
    for (const comments of cases) {
        assert.deepEqual(flattenComments({ m: comments })[0].replies, []);
    }
});

test('flattenComments treats a non-boolean isAdmin as not admin', () => {
    // The database is unauthenticated, so isAdmin is whatever anyone wrote.
    const tree = { m: { c1: { text: 'x', timestamp: 1, isAdmin: 'true',
        replies: { r1: { text: 'y', timestamp: 2, isAdmin: 1 } } } } };
    const [row] = flattenComments(tree);
    assert.equal(row.isAdmin, false);
    assert.equal(row.replies[0].isAdmin, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `flattenComments is not a function` (the import is undefined).

- [ ] **Step 3: Write minimal implementation**

Append to `comments.js`:

```js
// Timestamps are normalized rather than trusted. The database is schemaless
// and another client version may have written a string; Number('x') is NaN,
// and a NaN in a comparator silently stops ordering anything — a single
// corrupted row would land at an arbitrary point in a newest-first list
// instead of sorting predictably to the bottom.
function toTimestamp(value) {
    return Number(value) || 0;
}

// Firebase push ids are built so codepoint order matches creation order, so a
// plain comparison is both correct and deterministic. localeCompare would
// apply ICU collation, which orders punctuation and case differently and can
// differ between the browser and the test runner — destroying the very
// stability this tie-break exists to provide.
function byId(a, b) {
    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
}

// A thread's replies, oldest first: a conversation reads top to bottom.
function flattenReplies(replies) {
    if (!replies || typeof replies !== 'object') return [];

    return Object.entries(replies)
        .filter(([, reply]) => reply && typeof reply === 'object')
        .map(([replyId, reply]) => ({
            id: replyId,
            text: reply.text || '',
            userName: reply.userName || 'Anonymous',
            timestamp: toTimestamp(reply.timestamp),
            isAdmin: reply.isAdmin === true
        }))
        .sort((a, b) => (a.timestamp - b.timestamp) || byId(a, b));
}

// The comments tree as a newest-first inbox, each row joined to its movie
// title. Replies ride along on their parent rather than becoming rows of their
// own — a reply read out of context means nothing.
//
// Timestamp ties break by id so the list does not reshuffle between renders;
// onValue re-fires on every write and an unstable sort would visibly jump.
export function flattenComments(tree, moviesById = new Map()) {
    if (!tree || typeof tree !== 'object') return [];

    const rows = [];

    for (const [movieId, comments] of Object.entries(tree)) {
        if (!comments || typeof comments !== 'object') continue;

        for (const [commentId, comment] of Object.entries(comments)) {
            if (!comment || typeof comment !== 'object') continue;

            rows.push({
                id: commentId,
                // The structural key, not comment.movieId. Both agree across all
                // 274 live records, but this is what the delete path writes back
                // to, so the tree's own shape is the safer source.
                movieId,
                movieTitle: moviesById.get(movieId)?.title || 'Unknown movie',
                text: comment.text || '',
                userName: comment.userName || 'Anonymous',
                timestamp: toTimestamp(comment.timestamp),
                // Strict: the database is unauthenticated, so this holds
                // whatever anyone wrote. A truthy non-boolean must not light up
                // an ADMIN badge.
                isAdmin: comment.isAdmin === true,
                replies: flattenReplies(comment.replies)
            });
        }
    }

    rows.sort((a, b) => (b.timestamp - a.timestamp) || byId(a, b));
    return rows;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — all 8 new tests pass.

- [ ] **Step 5: Commit**

```bash
git add comments.js comments.test.js
git commit -m "feat: flatten the comments tree into a newest-first inbox"
```

---

### Task 3: Translation batching and reply formatting

**Files:**
- Modify: `comments.js`
- Modify: `comments.test.js`

- [ ] **Step 1: Write the failing test**

Append to `comments.test.js`:

```js
import { collectTranslatable, batchItems, formatAdminReply } from './comments.js';

test('collectTranslatable skips emoji-only, admin and already-cached items', () => {
    const rows = [
        { id: 'c1', text: 'ဘာသာပြန်ပေးပါ', isAdmin: false, replies: [] },
        { id: 'c2', text: '💜', isAdmin: false, replies: [] },
        { id: 'c3', text: 'already done', isAdmin: false, replies: [] },
        { id: 'c4', text: 'posted by admin', isAdmin: true, replies: [] }
    ];
    const cache = { c3: { text: 'already done', lang: 'en' } };

    assert.deepEqual(collectTranslatable(rows, cache), [
        { id: 'c1', text: 'ဘာသာပြန်ပေးပါ' }
    ]);
});

test('collectTranslatable reaches into replies as well as comments', () => {
    const rows = [{
        id: 'c1', text: 'hi', isAdmin: false,
        replies: [
            { id: 'r1', text: 'สวัสดี', isAdmin: false },
            { id: 'r2', text: 'admin words', isAdmin: true }
        ]
    }];

    assert.deepEqual(collectTranslatable(rows, {}), [
        { id: 'c1', text: 'hi' },
        { id: 'r1', text: 'สวัสดี' }
    ]);
});

test('collectTranslatable returns nothing when everything is cached', () => {
    const rows = [{ id: 'c1', text: 'hi', isAdmin: false, replies: [] }];
    assert.deepEqual(collectTranslatable(rows, { c1: { text: 'hi', lang: 'en' } }), []);
    assert.deepEqual(collectTranslatable([], {}), []);
});

test('batchItems splits into fixed-size batches', () => {
    const items = Array.from({ length: 7 }, (_, i) => ({ id: `c${i}`, text: 'x' }));
    const batches = batchItems(items, 3);
    assert.equal(batches.length, 3);
    assert.deepEqual(batches.map(b => b.length), [3, 3, 1]);
});

test('batchItems handles an empty list and rejects a nonsense size', () => {
    assert.deepEqual(batchItems([], 25), []);
    assert.throws(() => batchItems([{ id: 'a', text: 'x' }], 0), /at least 1/);
});

test('batchItems rejects a size that is not a whole number', () => {
    const items = [{ id: 'a', text: 'x' }];
    // NaN slid past a `size < 1` guard and silently returned zero items.
    assert.throws(() => batchItems(items, NaN), /at least 1/);
    assert.throws(() => batchItems(items, 2.5), /at least 1/);
    assert.throws(() => batchItems(items, Infinity), /at least 1/);
});

test('batchItems handles a size of one', () => {
    const items = Array.from({ length: 3 }, (_, i) => ({ id: `c${i}`, text: 'x' }));
    assert.deepEqual(batchItems(items, 1).map(b => b.length), [1, 1, 1]);
});

test('collectTranslatable is not fooled by an id that names an Object method', () => {
    // cache is a plain object straight from Firebase, and cache['constructor']
    // is truthy on any object — which would silently skip this item.
    const rows = [{ id: 'constructor', text: 'hello', isAdmin: false, replies: [] }];
    assert.deepEqual(collectTranslatable(rows, {}), [{ id: 'constructor', text: 'hello' }]);
});

test('formatAdminReply puts the translation above the English original', () => {
    assert.equal(
        formatAdminReply('ဒေါင်းလုဒ်မရ', "Download isn't available yet."),
        "ဒေါင်းလုဒ်မရ\n—\nDownload isn't available yet."
    );
});

test('formatAdminReply posts the original alone when there is nothing to add', () => {
    // English-to-English: the translator echoed the input, so a separator and a
    // duplicate would be noise.
    assert.equal(formatAdminReply('Same text', 'Same text'), 'Same text');
    assert.equal(formatAdminReply('', 'Only English'), 'Only English');
    assert.equal(formatAdminReply(null, 'Only English'), 'Only English');
    assert.equal(formatAdminReply('  ', 'Only English'), 'Only English');
});

test('formatAdminReply trims surrounding whitespace', () => {
    assert.equal(formatAdminReply('  ABC  ', '  xyz  '), 'ABC\n—\nxyz');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `collectTranslatable is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `comments.js`:

```js
// Every comment and reply still needing a translation fetched.
//
// Admin-authored items are skipped: this dashboard wrote them, in TARGET_LANG
// already. Cached ids are skipped so each item costs one API call ever.
export function collectTranslatable(rows, cache = {}) {
    const pending = [];

    for (const row of rows) {
        for (const item of [row, ...(row.replies || [])]) {
            if (item.isAdmin) continue;
            if (!needsTranslation(item.text)) continue;
            // Object.hasOwn, not cache[id]: cache is a plain object from
            // Firebase, and cache['constructor'] is truthy on every object,
            // which would silently skip translating that item.
            if (Object.hasOwn(cache, item.id)) continue;
            pending.push({ id: item.id, text: item.text });
        }
    }

    return pending;
}

// Fixed-size batches for the translate endpoint. 25 keeps a request well
// inside the model's output budget while making the 274-comment backlog about
// a dozen calls rather than 274.
export function batchItems(items, size = 25) {
    // Number.isInteger rather than `size < 1`: NaN < 1 is false, so a NaN size
    // slipped through and returned a single empty batch — silently translating
    // nothing at all rather than failing loudly.
    if (!Number.isInteger(size) || size < 1) {
        throw new Error('batch size must be a whole number of at least 1');
    }

    const batches = [];
    for (let index = 0; index < items.length; index += size) {
        batches.push(items.slice(index, index + size));
    }
    return batches;
}

const REPLY_SEPARATOR = '\n—\n';

// The body posted for an admin reply: the reader's language first so they see
// it immediately, the English original beneath as a fallback for when the
// translation reads oddly.
export function formatAdminReply(translation, original) {
    const source = String(original ?? '').trim();
    const translated = String(translation ?? '').trim();

    if (!translated || translated === source) return source;
    return `${translated}${REPLY_SEPARATOR}${source}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — all 8 new tests pass.

- [ ] **Step 5: Commit**

```bash
git add comments.js comments.test.js
git commit -m "feat: add translation batching and admin reply formatting"
```

---

### Task 4: Parse the translator's response

**Files:**
- Create: `api/translate.js`
- Create: `api/translate.test.js`

Parsing is split out and exported so it can be tested without a network call or an API key.

- [ ] **Step 1: Write the failing test**

Create `api/translate.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseTranslationResponse } from './translate.js';

test('parseTranslationResponse reads a clean JSON object', () => {
    const raw = '{"items":[{"id":"c1","lang":"my","text":"Please translate it"}]}';
    assert.deepEqual(parseTranslationResponse(raw), [
        { id: 'c1', lang: 'my', text: 'Please translate it' }
    ]);
});

test('parseTranslationResponse strips a markdown code fence', () => {
    const raw = '```json\n{"items":[{"id":"c1","lang":"en","text":"hi"}]}\n```';
    assert.deepEqual(parseTranslationResponse(raw), [
        { id: 'c1', lang: 'en', text: 'hi' }
    ]);
});

test('parseTranslationResponse digs the object out of surrounding prose', () => {
    const raw = 'Sure! Here you go:\n{"items":[{"id":"c1","lang":"ar","text":"hello"}]}\nHope that helps.';
    assert.deepEqual(parseTranslationResponse(raw), [
        { id: 'c1', lang: 'ar', text: 'hello' }
    ]);
});

test('parseTranslationResponse drops entries with no usable id', () => {
    const raw = '{"items":[{"id":"c1","lang":"en","text":"ok"},{"lang":"en","text":"orphan"},null]}';
    assert.deepEqual(parseTranslationResponse(raw), [
        { id: 'c1', lang: 'en', text: 'ok' }
    ]);
});

test('parseTranslationResponse defaults missing lang and text', () => {
    const raw = '{"items":[{"id":"c1"}]}';
    assert.deepEqual(parseTranslationResponse(raw), [
        { id: 'c1', lang: 'unknown', text: '' }
    ]);
});

test('parseTranslationResponse throws a describable error on junk', () => {
    assert.throws(() => parseTranslationResponse(''), /empty response/);
    assert.throws(() => parseTranslationResponse('no json at all'), /no JSON object/);
    assert.throws(() => parseTranslationResponse('{"items": [oops}'), /invalid JSON/);
    assert.throws(() => parseTranslationResponse('{"nope":1}'), /no items array/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './translate.js'`

- [ ] **Step 3: Write minimal implementation**

Create `api/translate.js` with the parser only (the handler arrives in Task 5):

```js
// Batch translation of user comments into the admin's language.
//
// Separate from api/ai-service.js on purpose: that endpoint is hardwired to a
// movie-metadata system prompt and a one-prompt-one-completion shape, while
// this one batches, detects source languages and must return strict JSON.

// The model is asked for bare JSON but may still wrap it in a code fence or
// wrap prose around it. Everything here is defensive: a malformed response
// must raise a describable error, never crash the request or silently return
// half a batch.
export function parseTranslationResponse(content) {
    if (!content) throw new Error('Translator returned an empty response');

    const unfenced = String(content)
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/```$/, '')
        .trim();

    const start = unfenced.indexOf('{');
    const end = unfenced.lastIndexOf('}');
    if (start === -1 || end === -1) {
        throw new Error('Translator returned no JSON object');
    }

    let parsed;
    try {
        parsed = JSON.parse(unfenced.slice(start, end + 1));
    } catch (error) {
        throw new Error(`Translator returned invalid JSON: ${error.message}`);
    }

    if (!Array.isArray(parsed.items)) {
        throw new Error('Translator response has no items array');
    }

    return parsed.items
        .filter(item => item && typeof item.id === 'string')
        .map(item => ({
            id: item.id,
            lang: typeof item.lang === 'string' ? item.lang : 'unknown',
            text: typeof item.text === 'string' ? item.text : ''
        }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — all 6 new tests pass.

- [ ] **Step 5: Commit**

```bash
git add api/translate.js api/translate.test.js
git commit -m "feat: parse batched translator responses defensively"
```

---

### Task 5: The translate endpoint

**Files:**
- Modify: `api/translate.js`
- Modify: `dev-server.js:119` (startup log line)

No route registration is needed: `loadApiHandler` in dev-server.js resolves handlers dynamically with `import('./api/' + name + '.js')`, and Vercel maps `api/*.js` by filename.

- [ ] **Step 1: Add the handler**

Prepend the import and constants to the top of `api/translate.js`, above `parseTranslationResponse`:

```js
import Anthropic from '@anthropic-ai/sdk';

const OPENAI_MODEL = 'gpt-4o-mini';
const CLAUDE_MODEL = 'claude-opus-5';

const SYSTEM_PROMPT = `You translate short user comments from a movie app.
Reply with JSON only, in this exact shape:
{"items":[{"id":"<the id you were given>","lang":"<ISO 639-1 code of the ORIGINAL language>","text":"<translation>"}]}
Rules:
- Return exactly one entry for every id you were given.
- If a comment is already in the target language, copy it unchanged into "text" and set "lang" to that language's code.
- Translate meaning, not word for word. These are casual comments; keep them short and plain.
- Preserve emoji. Never add commentary, notes, apologies or extra keys.`;
```

Then append the handler to the bottom of `api/translate.js`:

```js
export default async function handler(req, res) {
    const requestId = `tr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { items, targetLang } = req.body || {};

    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'items must be a non-empty array' });
    }

    const target = targetLang || 'en';
    const prompt = buildPrompt(items, target);

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

    if (!OPENAI_API_KEY && !ANTHROPIC_API_KEY) {
        console.error('Translate: no provider key configured', { requestId });
        return res.status(500).json({
            error: 'No AI provider configured on server. Set OPENAI_API_KEY or ANTHROPIC_API_KEY.'
        });
    }

    // Primary: OpenAI. Any failure falls through to Claude rather than
    // surfacing an error, matching api/ai-service.js.
    if (OPENAI_API_KEY) {
        try {
            console.info('Translate request', { requestId, provider: 'openai', count: items.length });
            const content = await callOpenAI({ prompt, apiKey: OPENAI_API_KEY });
            return res.status(200).json({ items: parseTranslationResponse(content), provider: 'openai' });
        } catch (error) {
            console.error('Translate: OpenAI failed, falling back to Claude', {
                requestId, message: error.message
            });
            if (!ANTHROPIC_API_KEY) {
                return res.status(500).json({
                    error: `${error.message} (no ANTHROPIC_API_KEY configured for fallback)`,
                    requestId
                });
            }
        }
    }

    // Fallback: Claude
    try {
        console.info('Translate request', { requestId, provider: 'anthropic', count: items.length });
        const content = await callClaude({ prompt, apiKey: ANTHROPIC_API_KEY });
        return res.status(200).json({ items: parseTranslationResponse(content), provider: 'anthropic' });
    } catch (error) {
        console.error('Translate: Claude fallback also failed', { requestId, message: error.message });
        return res.status(500).json({ error: error.message, requestId });
    }
}

function buildPrompt(items, targetLang) {
    const payload = items.map(item => ({ id: item.id, text: item.text }));
    return `Target language: ${targetLang}\n\nComments:\n${JSON.stringify(payload, null, 1)}`;
}

async function callOpenAI({ prompt, apiKey }) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: OPENAI_MODEL,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: prompt }
            ],
            // Translating 25 comments needs real headroom; comments run long.
            max_tokens: 4096,
            temperature: 0.2,
            response_format: { type: 'json_object' }
        })
    });

    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.error?.message || `OpenAI API error ${response.status}`);
    }
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('OpenAI returned no completion content');
    return content;
}

async function callClaude({ prompt, apiKey }) {
    const anthropic = new Anthropic({ apiKey });

    const message = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        // Opus 5 counts thinking against max_tokens, so a batch of 25 needs
        // considerably more than the visible output will use. Temperature is
        // deliberately not sent — Opus 5 rejects sampling parameters with a 400.
        max_tokens: 8192,
        output_config: { effort: 'low' },
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }]
    });

    if (message.stop_reason === 'refusal') {
        const category = message.stop_details?.category || 'unspecified';
        throw new Error(`Claude declined the request (${category})`);
    }

    const content = message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
        .trim();

    if (!content) throw new Error('Claude returned no text content');
    return content;
}
```

- [ ] **Step 2: Update the dev-server startup log**

In `dev-server.js`, replace the route list line:

```js
    console.log('API routes: /api/youtube-info  /api/youtube-download  /api/ai-service  /api/generate-thumbnail');
```

with:

```js
    console.log('API routes: /api/youtube-info  /api/youtube-download  /api/ai-service  /api/generate-thumbnail  /api/translate');
```

- [ ] **Step 3: Verify the parser tests still pass**

Run: `npm test`
Expected: PASS — adding the handler must not disturb Task 4's tests. If the run now fails on a missing `@anthropic-ai/sdk`, run `npm install` first.

- [ ] **Step 4: Smoke-test the live endpoint**

Run in one terminal: `npm run dev`
Run in another:

```bash
curl -s -X POST http://localhost:3000/api/translate \
  -H 'Content-Type: application/json' \
  -d '{"items":[{"id":"c1","text":"ဘာသာပြန်ပေးပါ"},{"id":"c2","text":"hi"}],"targetLang":"en"}'
```

Expected: JSON with two items; `c1` has `lang: "my"` and English text near "please translate it", `c2` has `lang: "en"` and `text: "hi"` unchanged.

If it returns a 500 about provider keys: `.env` uses `CLAUDE_API_KEY`, but this handler and `api/ai-service.js` both read `ANTHROPIC_API_KEY`. Add `ANTHROPIC_API_KEY=<same value>` to `.env` and restart. Note `.env` currently has a space in `CLAUDE_API_KEY =`, which the dev-server's parser keeps in the key name — write the new line with no space.

- [ ] **Step 5: Commit**

```bash
git add api/translate.js dev-server.js
git commit -m "feat: add the batched comment translation endpoint"
```

---

### Task 6: Comments view markup

**Files:**
- Modify: `index.html:27` (nav), `index.html:453` (after the movies section)

- [ ] **Step 1: Add the nav button**

In `index.html`, inside `<nav class="nav-menu">`, insert a Comments button between the Movies and Settings buttons:

```html
                <button class="nav-item" id="nav-comments">
                    <span class="icon">💬</span> Comments
                </button>
```

- [ ] **Step 2: Add the comments view section**

Immediately after the closing `</section>` of `<section class="content-body">` and before `</main>`, add:

```html
            <!-- Comments inbox. A sibling view of .content-body; the router in
                 app.js shows exactly one of them at a time. -->
            <section id="comments-view" class="comments-view hidden">
                <div class="filter-bar">
                    <input type="text" id="comment-search" placeholder="Search comments, users or movies..." class="search-input">
                    <select id="comment-lang-filter" class="filter-select">
                        <option value="all">All languages</option>
                        <option value="translated">Translated only</option>
                        <option value="untranslated">Untranslated only</option>
                    </select>
                    <button type="button" id="comment-translate-all" class="btn btn-secondary btn-sm">🌐 Translate all</button>
                </div>

                <div id="comments-summary" class="comments-summary"></div>

                <div id="comments-container" class="comments-list">
                    <div class="loading-state">
                        <div class="spinner"></div>
                        <p>Loading comments...</p>
                    </div>
                </div>
            </section>
```

- [ ] **Step 3: Add the reply dialog**

Before the closing `</body>`, alongside the other overlays, add:

```html
    <!-- Reply composer. The preview is mandatory: it is the only thing between
         a bad machine translation and a user reading it. -->
    <section id="reply-modal" class="panel-overlay hidden">
        <div class="panel-content reply-panel">
            <div class="panel-header">
                <h2>Reply</h2>
                <button type="button" id="reply-close" class="btn btn-ghost">✕</button>
            </div>
            <div class="reply-body">
                <div class="reply-context">
                    <span id="reply-context-movie" class="reply-context-movie"></span>
                    <span id="reply-context-user" class="reply-context-user"></span>
                    <p id="reply-context-text" class="reply-context-text"></p>
                    <p id="reply-context-translation" class="reply-context-translation"></p>
                </div>

                <label class="form-label" for="reply-input">Your reply (English)</label>
                <textarea id="reply-input" class="reply-input" rows="3" placeholder="Type your reply..."></textarea>

                <div id="reply-preview" class="reply-preview hidden">
                    <span class="reply-preview-label">Will be posted as:</span>
                    <pre id="reply-preview-text" class="reply-preview-text"></pre>
                </div>

                <div class="modal-actions">
                    <button type="button" id="reply-cancel" class="btn btn-ghost">Cancel</button>
                    <button type="button" id="reply-translate" class="btn btn-secondary">🌐 Translate &amp; preview</button>
                    <button type="button" id="reply-post" class="btn btn-primary" disabled>Post reply</button>
                </div>
            </div>
        </div>
    </section>
```

- [ ] **Step 4: Verify the markup loads**

Run: `npm run dev`, open `http://localhost:3000`
Expected: the Comments nav button is visible in the sidebar. Clicking it does nothing yet (Task 8 wires the router). The movies grid is unaffected.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat: add comments view and reply dialog markup"
```

---

### Task 7: Comments styling

**Files:**
- Modify: `style.css` (append)

- [ ] **Step 1: Append the styles**

Append to `style.css`:

```css
/* ---------- Comments inbox ---------- */

.comments-view {
    padding: 20px 30px 60px;
}

.comments-summary {
    color: var(--text-secondary);
    font-size: 0.9rem;
    margin: 10px 0 18px;
}

.comments-list {
    display: flex;
    flex-direction: column;
    gap: 14px;
}

.comment-card {
    background: var(--bg-card);
    border-radius: var(--border-radius);
    padding: 16px 18px;
    border-left: 3px solid transparent;
    transition: border-color var(--transition);
}

.comment-card:hover {
    border-left-color: var(--color-accent);
}

.comment-head {
    display: flex;
    align-items: baseline;
    gap: 10px;
    flex-wrap: wrap;
    margin-bottom: 8px;
}

.comment-movie {
    color: var(--color-accent);
    font-weight: 600;
    cursor: pointer;
}

.comment-movie:hover {
    text-decoration: underline;
}

.comment-user {
    color: var(--text-primary);
    font-weight: 500;
}

.comment-time,
.comment-lang {
    color: var(--text-muted);
    font-size: 0.8rem;
}

.comment-lang {
    border: 1px solid var(--text-muted);
    border-radius: 20px;
    padding: 1px 8px;
    text-transform: uppercase;
}

.comment-text {
    color: var(--text-primary);
    margin: 0 0 6px;
    white-space: pre-wrap;
    word-break: break-word;
}

/* The translation is visibly secondary to the original: it is a machine's
   reading of the user's words, not the user's words. */
.comment-translation {
    color: var(--text-secondary);
    font-style: italic;
    margin: 0 0 8px;
    padding-left: 10px;
    border-left: 2px solid var(--color-accent-light);
    white-space: pre-wrap;
    word-break: break-word;
}

.comment-actions {
    display: flex;
    gap: 8px;
    margin-top: 8px;
}

.comment-replies {
    margin: 12px 0 0 18px;
    padding-left: 14px;
    border-left: 2px solid rgba(255, 255, 255, 0.08);
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.comment-reply .comment-text {
    font-size: 0.95rem;
}

.admin-badge {
    background: var(--color-accent);
    color: var(--text-primary);
    border-radius: 20px;
    padding: 1px 8px;
    font-size: 0.7rem;
    font-weight: 600;
}

.comments-empty {
    color: var(--text-secondary);
    text-align: center;
    padding: 60px 20px;
}

/* ---------- Reply dialog ---------- */

.reply-panel {
    max-width: 620px;
}

.reply-body {
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.reply-context {
    background: rgba(0, 0, 0, 0.25);
    border-radius: var(--border-radius);
    padding: 12px 14px;
}

.reply-context-movie {
    color: var(--color-accent);
    font-weight: 600;
    margin-right: 8px;
}

.reply-context-user {
    color: var(--text-secondary);
    font-size: 0.85rem;
}

.reply-context-text {
    color: var(--text-primary);
    margin: 8px 0 0;
    white-space: pre-wrap;
}

.reply-context-translation {
    color: var(--text-secondary);
    font-style: italic;
    margin: 6px 0 0;
    white-space: pre-wrap;
}

.reply-input {
    width: 100%;
    background: var(--bg-primary);
    color: var(--text-primary);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: var(--border-radius);
    padding: 12px;
    font-family: var(--font-family);
    font-size: 1rem;
    resize: vertical;
}

.reply-input:focus {
    outline: none;
    border-color: var(--color-accent);
}

.reply-preview {
    background: rgba(0, 0, 0, 0.25);
    border-radius: var(--border-radius);
    padding: 12px 14px;
}

.reply-preview-label {
    color: var(--text-muted);
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
}

.reply-preview-text {
    color: var(--text-primary);
    font-family: var(--font-family);
    font-size: 1rem;
    white-space: pre-wrap;
    word-break: break-word;
    margin: 8px 0 0;
}
```

- [ ] **Step 2: Verify the styles load**

Run: `npm run dev`, open `http://localhost:3000`
Expected: no visual change yet (the section is still `hidden`), and no console errors. The movies grid is unchanged.

- [ ] **Step 3: Commit**

```bash
git add style.css
git commit -m "style: add comments inbox and reply dialog styling"
```

---

### Task 8: View router and comments listener

**Files:**
- Modify: `app.js` (imports near line 19; movies listener at line 2169; new code at end of file before the final `Object.assign`)

- [ ] **Step 1: Import the helpers**

After the existing `last-added.js` import block in `app.js`, add:

```js
import {
    TARGET_LANG,
    ADMIN_NAME,
    detectScript,
    needsTranslation,
    flattenComments,
    collectTranslatable,
    batchItems,
    formatAdminReply
} from './comments.js';
```

- [ ] **Step 2: Build a movie lookup in the existing movies listener**

In the `onValue(moviesRef, ...)` handler around `app.js:2169`, after `existingMoviesByVideoId` is assigned and before `applyFiltersAndRender()`, add:

```js
    // Comment rows carry a movieId only; the inbox shows titles.
    moviesById = new Map(allMovies.map((movie) => [movie.id, movie]));
    renderComments();
```

Declare it alongside the other module-level caches (near `existingMoviesByKey`):

```js
let moviesById = new Map();
```

`renderComments()` is defined in Step 4. It must tolerate being called before comments have loaded.

- [ ] **Step 3: Add the view router**

Add near the end of `app.js`:

```js
// --- View routing ---
//
// The dashboard had no view switching before this: the Movies view was the
// whole page. This is the smallest thing that works — no hash routing, no
// history integration. #nav-settings stays deliberately unwired; wiring it is
// a two-line job whenever a Settings view exists.

const navDashboard = document.getElementById('nav-dashboard');
const navComments = document.getElementById('nav-comments');
const commentsView = document.getElementById('comments-view');
const moviesContentBody = document.querySelector('.content-body');
const pageTitle = document.querySelector('.page-title');
const headerButtons = document.querySelector('.header-button-group');

function showView(name) {
    const isComments = name === 'comments';

    moviesContentBody?.classList.toggle('hidden', isComments);
    commentsView?.classList.toggle('hidden', !isComments);

    // The last-added panel belongs to the Movies view. It has its own hidden
    // state (it stays hidden until a movie exists), so only ever hide it here
    // and let its own logic decide when to show it again.
    if (isComments) {
        lastAddedPanel?.classList.add('hidden');
    } else {
        renderLastAdded();
    }

    // "Add New Movie" and "Batch Upload" are meaningless while reading comments.
    headerButtons?.classList.toggle('hidden', isComments);

    navDashboard?.classList.toggle('active', !isComments);
    navComments?.classList.toggle('active', isComments);

    if (pageTitle) pageTitle.textContent = isComments ? 'Comments' : 'Dashboard';
}

navDashboard?.addEventListener('click', () => showView('movies'));
navComments?.addEventListener('click', () => showView('comments'));
```

**Before writing this, confirm the real name of the function that renders the last-added panel.** Run:

```bash
grep -n "lastAddedPanel" app.js
```

Use whatever function assigns its content; the plan assumes `renderLastAdded()`. If it is named differently, substitute the real name. If no such function exists and the panel is only populated inside the movies `onValue`, drop the `else` branch entirely and leave the panel hidden until the next data change.

- [ ] **Step 4: Add the comments listener and render**

Add after the router:

```js
// --- Comments ---

const commentsContainer = document.getElementById('comments-container');
const commentsSummary = document.getElementById('comments-summary');
const commentSearch = document.getElementById('comment-search');
const commentLangFilter = document.getElementById('comment-lang-filter');

let commentRows = [];
let translations = {};      // pushId -> { text, lang, at }
let commentsLoaded = false;

const commentsRef = ref(db, 'comments');
onValue(commentsRef, (snapshot) => {
    commentsLoaded = true;
    commentRows = flattenComments(snapshot.val(), moviesById);
    renderComments();
    translatePending();
});

const translationsRef = ref(db, 'commentTranslations');
onValue(translationsRef, (snapshot) => {
    translations = snapshot.val() || {};
    renderComments();
});

function visibleRows() {
    const term = (commentSearch?.value || '').trim().toLowerCase();
    const mode = commentLangFilter?.value || 'all';

    return commentRows.filter((row) => {
        if (term) {
            const haystack = `${row.text} ${row.userName} ${row.movieTitle}`.toLowerCase();
            const inReplies = row.replies.some(reply =>
                `${reply.text} ${reply.userName}`.toLowerCase().includes(term)
            );
            if (!haystack.includes(term) && !inReplies) return false;
        }

        if (mode === 'translated') return Boolean(translations[row.id]);
        if (mode === 'untranslated') return !translations[row.id];
        return true;
    });
}

function renderComments() {
    if (!commentsContainer) return;

    if (!commentsLoaded) return;   // keep the loading spinner

    const rows = visibleRows();

    if (commentsSummary) {
        const replyCount = commentRows.reduce((total, row) => total + row.replies.length, 0);
        commentsSummary.textContent =
            `${rows.length} of ${commentRows.length} comments · ${replyCount} replies`;
    }

    commentsContainer.textContent = '';

    if (rows.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'comments-empty';
        empty.textContent = commentRows.length === 0
            ? 'No comments yet.'
            : 'No comments match this filter.';
        commentsContainer.appendChild(empty);
        return;
    }

    for (const row of rows) {
        commentsContainer.appendChild(buildCommentCard(row));
    }
}

function buildCommentCard(row) {
    const card = document.createElement('div');
    card.className = 'comment-card';
    card.appendChild(buildCommentBody(row, row.movieTitle));

    if (row.replies.length > 0) {
        const thread = document.createElement('div');
        thread.className = 'comment-replies';
        for (const reply of row.replies) {
            const replyEl = buildCommentBody(reply, null);
            replyEl.classList.add('comment-reply');
            thread.appendChild(replyEl);
        }
        card.appendChild(thread);
    }

    return card;
}

// Shared by comments and replies. `movieTitle` is null for replies, which sit
// under a parent that already names the movie.
//
// Every user-authored string goes in through textContent, never innerHTML:
// this text is written by anonymous users straight into the database.
function buildCommentBody(item, movieTitle) {
    const wrapper = document.createElement('div');

    const head = document.createElement('div');
    head.className = 'comment-head';

    if (movieTitle) {
        const movie = document.createElement('span');
        movie.className = 'comment-movie';
        movie.textContent = `🎬 ${movieTitle}`;
        movie.addEventListener('click', () => openMovieFromComment(item.movieId));
        head.appendChild(movie);
    }

    const user = document.createElement('span');
    user.className = 'comment-user';
    user.textContent = item.userName;
    head.appendChild(user);

    if (item.isAdmin) {
        const badge = document.createElement('span');
        badge.className = 'admin-badge';
        badge.textContent = 'ADMIN';
        head.appendChild(badge);
    }

    const time = document.createElement('span');
    time.className = 'comment-time';
    time.textContent = formatRelativeTime(item.timestamp, Date.now());
    head.appendChild(time);

    // Prefer the language the model actually detected; fall back to the script
    // only as a hint while a translation is still pending.
    const cached = translations[item.id];
    const lang = cached?.lang || detectScript(item.text);
    if (lang && lang !== 'latin' && lang !== 'empty') {
        const tag = document.createElement('span');
        tag.className = 'comment-lang';
        tag.textContent = lang;
        head.appendChild(tag);
    }

    wrapper.appendChild(head);

    const text = document.createElement('p');
    text.className = 'comment-text';
    text.textContent = item.text;
    wrapper.appendChild(text);

    // Show a translation only when it says something the original does not.
    if (cached && cached.text && cached.text !== item.text) {
        const translated = document.createElement('p');
        translated.className = 'comment-translation';
        translated.textContent = `🌐 ${cached.text}`;
        wrapper.appendChild(translated);
    }

    wrapper.appendChild(buildActions(item, Boolean(movieTitle)));
    return wrapper;
}

function openMovieFromComment(movieId) {
    const movie = moviesById.get(movieId);
    if (!movie) {
        showToast('That movie has been deleted.');
        return;
    }
    showView('movies');
    editMovie(movie.id);
}
```

**Before writing `openMovieFromComment`, confirm the edit entry point.** Run:

```bash
grep -n "function editMovie\|editMovie(" app.js | head
```

Use the real function and its real signature (it may take the whole movie object rather than an id). If no single-argument entry point exists, replace the body with `showToast('Open it from the Movies list.')` and move on — this is a convenience, not a requirement.

`buildActions` is written in Task 9.

- [ ] **Step 5: Wire the filters**

```js
commentSearch?.addEventListener('input', renderComments);
commentLangFilter?.addEventListener('change', renderComments);
```

- [ ] **Step 6: Verify**

Run: `npm run dev`, open `http://localhost:3000`, click **💬 Comments**.
Expected: the movies grid hides, the comments inbox appears with 274 comments newest first, each showing its movie title, author and relative time, threads showing their replies indented. The summary reads `274 of 274 comments · 20 replies`. Typing in the search box filters. Clicking **🎬 Movies** returns to the grid unchanged.

Note: this task calls two functions Task 9 defines — `buildActions` and `translatePending` — so the page throws until Task 9 lands. To see this task in isolation first, stub both and delete the stubs in Task 9:

```js
function buildActions() { return document.createElement('div'); }
function translatePending() {}
```

- [ ] **Step 7: Commit**

```bash
git add app.js
git commit -m "feat: add the comments inbox view and its router"
```

---

### Task 9: Translation orchestration

**Files:**
- Modify: `app.js`

- [ ] **Step 1: Add the actions row**

Add to `app.js` near the other comment functions:

```js
function buildActions(item, isTopLevel) {
    const actions = document.createElement('div');
    actions.className = 'comment-actions';

    if (isTopLevel) {
        const replyBtn = document.createElement('button');
        replyBtn.type = 'button';
        replyBtn.className = 'btn btn-sm btn-secondary';
        replyBtn.textContent = 'Reply';
        replyBtn.addEventListener('click', () => openReplyDialog(item));
        actions.appendChild(replyBtn);
    }

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn btn-sm btn-ghost';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => deleteComment(item, isTopLevel));
    actions.appendChild(deleteBtn);

    return actions;
}
```

`openReplyDialog` comes in Task 10 and `deleteComment` in Task 11.

- [ ] **Step 2: Add the translation runner**

```js
// Translation is strictly additive: every failure path here leaves the comment
// rendered with its original text. Nothing in this function may prevent the
// inbox from displaying.

let translating = false;

async function translateItems(items) {
    const results = [];

    for (const batch of batchItems(items, 25)) {
        const response = await fetch('/api/translate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items: batch, targetLang: TARGET_LANG })
        });

        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `Translate failed (${response.status})`);

        results.push(...(data.items || []));
    }

    return results;
}

// Cached under a new top-level node, never inside comments/. Push ids are
// unique database-wide, so one flat node serves comments and replies alike.
async function cacheTranslations(results) {
    const writes = {};
    for (const result of results) {
        writes[result.id] = { text: result.text, lang: result.lang, at: Date.now() };
    }
    if (Object.keys(writes).length === 0) return;
    await update(ref(db, 'commentTranslations'), writes);
}

async function translatePending() {
    if (translating) return;

    const pending = collectTranslatable(commentRows, translations);
    if (pending.length === 0) return;

    translating = true;
    try {
        const results = await translateItems(pending);
        await cacheTranslations(results);
    } catch (error) {
        console.error('Comment translation failed:', error);
        showToast(`Translation unavailable: ${error.message}`);
    } finally {
        translating = false;
    }
}
```

The `onValue` on `commentTranslations` added in Task 8 re-renders automatically once the cache is written — no manual refresh needed.

- [ ] **Step 3: Wire the Translate-all button**

```js
document.getElementById('comment-translate-all')?.addEventListener('click', () => {
    const pending = collectTranslatable(commentRows, translations);
    if (pending.length === 0) {
        showToast('Everything is already translated.');
        return;
    }
    showToast(`Translating ${pending.length} comments...`);
    translatePending();
});
```

- [ ] **Step 4: Verify**

Run: `npm run dev`, open the Comments view.
Expected: on first load the backlog translates in the background over roughly a dozen requests (watch the dev-server console for `Translate request` lines). Burmese and Arabic comments gain an italic `🌐 ...` line beneath the original. The `💜` emoji-only comments are never sent and never gain a translation line. Reloading the page triggers **zero** new translate requests — everything is served from `commentTranslations/`.

Verify the cache landed:

```bash
curl -s "https://movie-recap-1306e-default-rtdb.firebaseio.com/commentTranslations.json?shallow=true" | head -c 300
```

Expected: a JSON object of push ids.

- [ ] **Step 5: Commit**

```bash
git add app.js
git commit -m "feat: auto-translate comments and cache the results"
```

---

### Task 10: Replying

**Files:**
- Modify: `app.js`

- [ ] **Step 1: Add the dialog logic**

```js
// --- Replying ---

const replyModal = document.getElementById('reply-modal');
const replyInput = document.getElementById('reply-input');
const replyPreview = document.getElementById('reply-preview');
const replyPreviewText = document.getElementById('reply-preview-text');
const replyPostBtn = document.getElementById('reply-post');
const replyTranslateBtn = document.getElementById('reply-translate');

let replyTarget = null;      // the comment being replied to
let replyBody = '';          // exactly what will be written to the database

function openReplyDialog(row) {
    replyTarget = row;
    replyBody = '';

    document.getElementById('reply-context-movie').textContent = `🎬 ${row.movieTitle}`;
    document.getElementById('reply-context-user').textContent =
        `${row.userName} · ${formatRelativeTime(row.timestamp, Date.now())}`;
    document.getElementById('reply-context-text').textContent = row.text;

    const cached = translations[row.id];
    document.getElementById('reply-context-translation').textContent =
        cached && cached.text !== row.text ? `🌐 ${cached.text}` : '';

    replyInput.value = '';
    replyPreviewText.textContent = '';
    replyPreview.classList.add('hidden');
    replyPostBtn.disabled = true;

    replyModal.classList.remove('hidden');
    replyInput.focus();
}

function closeReplyDialog() {
    replyModal.classList.add('hidden');
    replyTarget = null;
    replyBody = '';
}

document.getElementById('reply-cancel')?.addEventListener('click', closeReplyDialog);
document.getElementById('reply-close')?.addEventListener('click', closeReplyDialog);

// Editing after previewing invalidates the preview: posting must never send
// something the admin has not seen.
replyInput?.addEventListener('input', () => {
    replyBody = '';
    replyPreview.classList.add('hidden');
    replyPostBtn.disabled = true;
});
```

- [ ] **Step 2: Add translate-and-preview**

```js
replyTranslateBtn?.addEventListener('click', async () => {
    const original = replyInput.value.trim();
    if (!original) {
        showToast('Type a reply first.');
        return;
    }

    // The target is the language the MODEL detected, never one guessed from the
    // script. Persian is written in Arabic script and Ukrainian in Cyrillic, so
    // guessing would answer them in Arabic and Russian — confidently wrong.
    const cached = translations[replyTarget?.id];
    const targetLang = cached?.lang;

    // Either the commenter already writes the admin's language, or nothing
    // reliable is known yet. Preview the plain English rather than guess.
    if (!targetLang || targetLang === TARGET_LANG) {
        replyBody = original;
        showPreview(replyBody);

        if (!targetLang && needsTranslation(replyTarget?.text || '')) {
            showToast('Not translated yet, so the reply language is unknown — this will post in English.');
        }
        return;
    }

    replyTranslateBtn.disabled = true;
    replyTranslateBtn.textContent = 'Translating...';

    try {
        const response = await fetch('/api/translate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                items: [{ id: 'reply', text: original }],
                targetLang
            })
        });

        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `Translate failed (${response.status})`);

        replyBody = formatAdminReply(data.items?.[0]?.text || '', original);
        showPreview(replyBody);
    } catch (error) {
        console.error('Reply translation failed:', error);
        // Offer the untranslated reply rather than discarding what was typed.
        replyBody = original;
        showPreview(replyBody);
        showToast(`Translation failed — you can still post the English: ${error.message}`);
    } finally {
        replyTranslateBtn.disabled = false;
        replyTranslateBtn.textContent = '🌐 Translate & preview';
    }
});

function showPreview(body) {
    replyPreviewText.textContent = body;
    replyPreview.classList.remove('hidden');
    replyPostBtn.disabled = false;
}
```

- [ ] **Step 3: Add posting**

```js
replyPostBtn?.addEventListener('click', async () => {
    if (!replyTarget || !replyBody) return;

    replyPostBtn.disabled = true;
    replyPostBtn.textContent = 'Posting...';

    try {
        const repliesRef = ref(db, `comments/${replyTarget.movieId}/${replyTarget.id}/replies`);
        await push(repliesRef, {
            text: replyBody,
            timestamp: Date.now(),
            userName: ADMIN_NAME,
            // Inert in the consumer app today; lets a verified badge be added
            // later without backfilling old replies.
            isAdmin: true
        });

        showToast('Reply posted.');
        closeReplyDialog();
    } catch (error) {
        console.error('Posting reply failed:', error);
        showToast(`Could not post reply: ${error.message}`);
        replyPostBtn.disabled = false;
    } finally {
        replyPostBtn.textContent = 'Post reply';
    }
});
```

- [ ] **Step 4: Verify**

Run: `npm run dev`, open Comments, click **Reply** on the Burmese comment "ဘာသာပြန်ပေးပါ".
Expected: the dialog shows the original and its translation. Type "Download isn't available yet." and click **Translate & preview** — the preview shows Burmese, then `—`, then the English. **Post reply** is disabled until the preview exists, and editing the text disables it again. Posting makes the reply appear in the thread immediately with an `ADMIN` badge.

Then verify what actually landed in the database:

```bash
curl -s "https://movie-recap-1306e-default-rtdb.firebaseio.com/comments/06c0cd6f-91be-4f52-a8c6-c64cfef81eb8.json"
```

Expected: a `replies` entry with `userName: "Movie Recap"`, `isAdmin: true`, and the two-part body.

**Then open the consumer app and find that comment.** This is the `isAdmin` compatibility check the spec flags as a known risk: confirm the app renders the reply and does not crash on the unknown field. If it does crash, remove `isAdmin: true` from the `push` above and re-test — everything else works without it.

- [ ] **Step 5: Commit**

```bash
git add app.js
git commit -m "feat: reply to comments with a translated preview"
```

---

### Task 11: Deleting

**Files:**
- Modify: `app.js`

- [ ] **Step 1: Add the delete flow**

```js
// Native confirm(), matching confirmDelete at app.js:2293 — the pattern this
// codebase actually uses. (#delete-modal in index.html is unwired dead markup.)
async function deleteComment(item, isTopLevel) {
    const replyCount = isTopLevel ? (item.replies?.length || 0) : 0;

    // Deleting a parent takes its replies with it, which is invisible in the UI.
    const warning = replyCount > 0
        ? `\n\nThis also deletes ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}.`
        : '';

    const preview = item.text.length > 80 ? `${item.text.slice(0, 80)}...` : item.text;

    if (!confirm(`Delete this ${isTopLevel ? 'comment' : 'reply'} by ${item.userName}?\n\n"${preview}"${warning}\n\nThis cannot be undone.`)) {
        return;
    }

    try {
        if (isTopLevel) {
            await remove(ref(db, `comments/${item.movieId}/${item.id}`));
            // Drop cached translations for the comment and everything under it.
            await remove(ref(db, `commentTranslations/${item.id}`));
            for (const reply of item.replies || []) {
                await remove(ref(db, `commentTranslations/${reply.id}`));
            }
        } else {
            const parent = commentRows.find(row => row.replies.some(reply => reply.id === item.id));
            if (!parent) throw new Error('Could not locate the parent comment');
            await remove(ref(db, `comments/${parent.movieId}/${parent.id}/replies/${item.id}`));
            await remove(ref(db, `commentTranslations/${item.id}`));
        }

        showToast('Deleted.');
    } catch (error) {
        console.error('Deleting comment failed:', error);
        showToast(`Could not delete: ${error.message}`);
    }
}
```

Note the asymmetry: a top-level row carries its own `movieId`, but a flattened reply does not, so its parent is found by search. This is why `flattenReplies` need not duplicate `movieId`.

- [ ] **Step 2: Verify**

Run: `npm run dev`, open Comments.
Expected: **Delete** on a reply asks for confirmation naming its author, and the reply vanishes from the thread on confirm. **Delete** on a comment with replies warns how many replies go with it. Cancelling changes nothing. The list updates live without a reload.

Delete the test reply posted in Task 10 to leave the database as you found it.

- [ ] **Step 3: Commit**

```bash
git add app.js
git commit -m "feat: delete comments and replies with their cached translations"
```

---

### Task 12: Full verification

**Files:** none

- [ ] **Step 1: Run the whole test suite**

Run: `npm test`
Expected: every test passes — `comments.test.js`, `api/translate.test.js`, and the pre-existing `last-added.test.js`. Zero failures.

- [ ] **Step 2: Walk the feature end to end**

Run `npm run dev` and confirm each:

- [ ] Movies view loads and behaves exactly as before — search, filter, sort, pagination, add, edit, delete
- [ ] The last-added panel still appears on the Movies view
- [ ] Comments nav switches views; the page title changes; Add/Batch buttons hide
- [ ] All 274 comments render newest first, with movie titles, authors and relative times
- [ ] Replies appear indented under their parents, oldest first
- [ ] Search matches comment text, user names, movie titles and reply text
- [ ] The language filter narrows to translated / untranslated
- [ ] Clicking a movie title opens that movie on the Movies view
- [ ] A reload issues no new translate requests
- [ ] Emoji-only comments have no translation line
- [ ] Replying posts a translated body with the English beneath it
- [ ] Deleting a reply and a comment both work and update live
- [ ] The browser console is free of errors throughout

- [ ] **Step 3: Confirm translation degrades safely**

Stop the dev server, comment out both provider keys in `.env`, restart, and open the Comments view.
Expected: **all 274 comments still render in full** with their original text. A toast reports translation is unavailable. Nothing else about the section is broken — search, filter, reply-without-translation and delete all still work. Restore `.env` afterwards.

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix: address issues found in end-to-end verification"
```

---

## Notes for the implementer

**Do not write translations into `comments/`.** That node is the consumer app's data. Translations go to `commentTranslations/{pushId}` and nowhere else.

**Every user-authored string is rendered with `textContent`, never `innerHTML`.** This text comes from anonymous users writing straight into a world-readable database. The plan's code does this consistently; keep it that way.

**Two spots require checking a real name before writing the code** — Task 8 Step 3 (`renderLastAdded`) and Task 8 Step 4 (`editMovie`). Both include the `grep` to run and a fallback if the assumption is wrong.

**The `isAdmin` field is unverified against the consumer app.** Task 10 Step 4 is where that gets tested. If the app chokes on it, dropping the field is a one-line change.

**Out of scope, and deliberately so:** the database is world-readable without authentication, and `userName` is unauthenticated free text — anyone can post as "Movie Recap" with `isAdmin: true`. This feature neither worsens nor fixes that. It is separate work.
