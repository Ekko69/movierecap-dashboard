import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectScript, needsTranslation, TARGET_LANG, ADMIN_NAME, flattenComments, collectTranslatable, batchItems, formatAdminReply, createTranslationScheduler,
    MAX_TRANSLATE_CHARS, clipForTranslation, replyLanguage, deletionWrites } from './comments.js';

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

test('collectTranslatable tolerates a row with no replies array', () => {
    // flattenComments always supplies one, but this must not throw if a caller
    // hands over a bare object.
    assert.deepEqual(collectTranslatable([{ id: 'c1', text: 'hi', isAdmin: false }], {}), [
        { id: 'c1', text: 'hi' }
    ]);
});

test('batchItems splits into fixed-size batches', () => {
    const items = Array.from({ length: 7 }, (_, i) => ({ id: `c${i}`, text: 'x' }));
    const batches = batchItems(items, 3);
    assert.equal(batches.length, 3);
    assert.deepEqual(batches.map(b => b.length), [3, 3, 1]);
    // Nothing lost or duplicated in the split.
    assert.deepEqual(batches.flat().map(b => b.id), items.map(i => i.id));
});

test('batchItems handles an empty list and rejects a nonsense size', () => {
    assert.deepEqual(batchItems([], 25), []);
    assert.throws(() => batchItems([{ id: 'a', text: 'x' }], 0), /at least 1/);
    assert.throws(() => batchItems([{ id: 'a', text: 'x' }], -1), /at least 1/);
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

// A fake world for the scheduler. `pending` is what still needs translating;
// caching an item removes it from there, as the real cache does. Every batch
// sent is recorded, and the `failOn`-th call (1-based) throws.
function fakeScheduler({ pending, failOn = 0, ready = () => true, onCache = async () => {} }) {
    const sent = [];
    const errors = [];
    let calls = 0;
    const scheduler = createTranslationScheduler({
        isReady: ready,
        collectPending: () => pending.filter((item) => !item.cached),
        translateBatch: async (batch) => {
            calls += 1;
            if (calls === failOn) throw new Error('rate limited');
            sent.push(batch.map((item) => item.id));
            return batch.map((item) => ({ id: item.id, lang: 'my', text: 't' }));
        },
        cache: async (results) => {
            for (const result of results) pending.find((item) => item.id === result.id).cached = true;
            await onCache();
        },
        onError: (error) => errors.push(error.message),
        batchSize: 2
    });
    return { scheduler, sent, errors };
}

const pendingItems = (count) => Array.from({ length: count }, (_, i) => ({ id: `c${i}`, text: 'x' }));

test('scheduler sends nothing until both halves have loaded', async () => {
    // Running before the cache arrives would re-pay for every comment.
    let ready = false;
    const { scheduler, sent } = fakeScheduler({ pending: pendingItems(3), ready: () => ready });
    await scheduler.run();
    assert.deepEqual(sent, []);

    ready = true;
    await scheduler.run();
    assert.deepEqual(sent, [['c0', 'c1'], ['c2']]);
});

test('scheduler keeps unsent batches eligible after a failure part-way', async () => {
    // A transient error on batch two must not strand batch three, which was
    // never sent. Batch two was sent, so it has had its one attempt.
    const { scheduler, sent, errors } = fakeScheduler({ pending: pendingItems(6), failOn: 2 });
    await scheduler.run();
    assert.deepEqual(sent, [['c0', 'c1']]);
    assert.deepEqual(errors, ['rate limited']);

    await scheduler.run();
    assert.deepEqual(sent, [['c0', 'c1'], ['c4', 'c5']]);
});

test('scheduler sends an item once even if it never gets cached', async () => {
    // Every cache write re-triggers a run; a comment the model keeps dropping
    // would otherwise be re-sent in a loop.
    const sent = [];
    const scheduler = createTranslationScheduler({
        isReady: () => true,
        collectPending: () => pendingItems(2),
        translateBatch: async (batch) => { sent.push(batch.map((item) => item.id)); return []; },
        cache: async () => {},
        onError: () => {}
    });
    await scheduler.run();
    await scheduler.run();
    assert.deepEqual(sent, [['c0', 'c1']]);
});

test('scheduler picks up work that arrives mid-run', async () => {
    // A comment posted while the backlog translates fires its listener, which
    // calls run() mid-pass. That call must not simply be dropped.
    const pending = pendingItems(2);
    let arrived = false;
    const { scheduler, sent } = fakeScheduler({
        pending,
        onCache: async () => {
            if (arrived) return;
            arrived = true;
            pending.push({ id: 'late', text: 'x' });
            await scheduler.run();
        }
    });
    await scheduler.run();
    assert.deepEqual(sent, [['c0', 'c1'], ['late']]);
});

test('scheduler takes no extra pass straight after a failure', async () => {
    // That pass would most likely fail the same way and double the error.
    // Six items, so a never-sent batch (c4, c5) remains after the failure:
    // with only four, an extra pass would find nothing to send, and this test
    // would pass whether or not the rule held.
    let triggered = false;
    const { scheduler, sent, errors } = fakeScheduler({
        pending: pendingItems(6),
        failOn: 2,
        onCache: async () => {
            if (triggered) return;
            triggered = true;
            await scheduler.run();
        }
    });
    await scheduler.run();
    assert.deepEqual(sent, [['c0', 'c1']]);
    assert.equal(errors.length, 1);
});

test('scheduler never runs two passes at once', async () => {
    let inFlight = 0;
    let most = 0;
    const scheduler = createTranslationScheduler({
        isReady: () => true,
        collectPending: () => pendingItems(4),
        translateBatch: async () => {
            inFlight += 1;
            most = Math.max(most, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 5));
            inFlight -= 1;
            return [];
        },
        cache: async () => {},
        onError: () => {},
        batchSize: 2
    });
    await Promise.all([scheduler.run(), scheduler.run(), scheduler.run()]);
    assert.equal(most, 1);
    assert.equal(scheduler.isRunning(), false);
});

test('scheduler sends items again after clearAttempts', async () => {
    // "Translate all" is the admin's way to retry what the model dropped.
    const sent = [];
    const scheduler = createTranslationScheduler({
        isReady: () => true,
        collectPending: () => pendingItems(1),
        translateBatch: async (batch) => { sent.push(batch.map((item) => item.id)); return []; },
        cache: async () => {},
        onError: () => {}
    });
    await scheduler.run();
    scheduler.clearAttempts();
    await scheduler.run();
    assert.deepEqual(sent, [['c0'], ['c0']]);
});

test('scheduler survives an error handler that throws', async () => {
    // run() is called without awaiting, so a rejection here would go unhandled.
    const scheduler = createTranslationScheduler({
        isReady: () => true,
        collectPending: () => pendingItems(1),
        translateBatch: async () => { throw new Error('rate limited'); },
        cache: async () => {},
        onError: () => { throw new Error('toast failed'); }
    });
    await scheduler.run();
    assert.equal(scheduler.isRunning(), false);
});

test('flattenComments makes text and names strings whatever the database holds', () => {
    // Schemaless and unauthenticated: any client can write any shape here.
    const tree = { m: { c1: {
        text: { nested: true }, userName: 42, timestamp: 1,
        replies: { r1: { text: 7, userName: ['x'], timestamp: 2 } }
    } } };
    const [row] = flattenComments(tree);
    assert.equal(row.text, '');
    assert.equal(row.userName, '42');
    assert.equal(row.replies[0].text, '7');
    assert.equal(row.replies[0].userName, 'Anonymous');
});

test('collectTranslatable clips text the endpoint would reject whole', () => {
    // One over-long comment used to fail its entire batch of 25, on every load.
    const long = 'ab'.repeat(400);
    const [item] = collectTranslatable([{ id: 'c1', text: long, isAdmin: false, replies: [] }], {});
    assert.equal(item.text, long.slice(0, MAX_TRANSLATE_CHARS));
});

test('clipForTranslation leaves text within the cap alone', () => {
    const exact = 'x'.repeat(MAX_TRANSLATE_CHARS);
    assert.equal(clipForTranslation(exact), exact);
    assert.equal(clipForTranslation('hi'), 'hi');
});

test('clipForTranslation never cuts an emoji in half', () => {
    // The emoji's two UTF-16 halves straddle the cap; half an emoji is not text.
    const text = 'a'.repeat(MAX_TRANSLATE_CHARS - 1) + '💜tail';
    assert.equal(clipForTranslation(text), 'a'.repeat(MAX_TRANSLATE_CHARS - 1));
});

test('replyLanguage uses only a real language other than the admin\'s', () => {
    assert.equal(replyLanguage('my'), 'my');
    assert.equal(replyLanguage('ar'), 'ar');
    for (const code of [undefined, '', 'en', 'unknown', 'und', 'zxx', 'mul']) {
        assert.equal(replyLanguage(code), null, `translated a reply into ${JSON.stringify(code)}`);
    }
});

test('deletionWrites removes a comment and every translation under it', () => {
    const row = { id: 'c1', movieId: 'm1', replies: [{ id: 'r1' }, { id: 'r2' }] };
    assert.deepEqual(deletionWrites(row, row), {
        'comments/m1/c1': null,
        'commentTranslations/c1': null,
        'commentTranslations/r1': null,
        'commentTranslations/r2': null
    });
});

test('deletionWrites removes only the one reply', () => {
    const reply = { id: 'r2' };
    const row = { id: 'c1', movieId: 'm1', replies: [{ id: 'r1' }, reply] };
    assert.deepEqual(deletionWrites(reply, row), {
        'comments/m1/c1/replies/r2': null,
        'commentTranslations/r2': null
    });
});

test('deletionWrites refuses any key that could widen the delete', () => {
    // Firebase drops empty path segments: a blank comment id would make this
    // one comment's path the whole movie's.
    const ok = { id: 'c1', movieId: 'm1', replies: [] };
    for (const bad of [
        { ...ok, id: '' },
        { ...ok, movieId: '' },
        { ...ok, id: 'a/b' },
        { ...ok, id: 'a.b' },
        { ...ok, id: 42 }
    ]) {
        assert.throws(() => deletionWrites(bad, bad), /malformed/, JSON.stringify(bad));
    }
    const withBlankReply = { ...ok, replies: [{ id: '' }] };
    assert.throws(() => deletionWrites(withBlankReply, withBlankReply), /malformed/);
    const blankReply = { id: '' };
    assert.throws(() => deletionWrites(blankReply, { ...ok, replies: [blankReply] }), /malformed/);
});
