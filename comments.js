// Helpers for the admin comments section. All pure except
// createTranslationScheduler, which keeps state but reaches the outside world
// only through the functions it is given.
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

// Text and names are made strings rather than trusted, for the same reason as
// timestamps below. They are shown to the admin and sent to the translator:
// a number keeps its digits, and anything else — an object, an array — is
// dropped rather than rendered as "[object Object]" or sent as JSON.
function toText(value) {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return '';
}

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
            text: toText(reply.text),
            userName: toText(reply.userName) || 'Anonymous',
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
                text: toText(comment.text),
                userName: toText(comment.userName) || 'Anonymous',
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

// The translate endpoint's per-item cap: MAX_TEXT_CHARS in api/translate.js, and
// a test keeps the two equal. The endpoint rejects a whole batch over a single
// oversized item, and batches form in the same order on every load, so one
// long comment would otherwise stop its 24 neighbours from ever translating.
export const MAX_TRANSLATE_CHARS = 500;

// Text cut to at most `limit` UTF-16 units — the unit the endpoint and
// String#length both count — and never through the middle of an emoji, whose
// two halves would otherwise leave a lone, unprintable surrogate.
export function clipText(text, limit) {
    if (text.length <= limit) return text;
    const clipped = text.slice(0, limit);
    return /[\uD800-\uDBFF]$/.test(clipped) ? clipped.slice(0, -1) : clipped;
}

// Text cut to what the translate endpoint accepts.
export function clipForTranslation(text) {
    return clipText(text, MAX_TRANSLATE_CHARS);
}

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
            pending.push({ id: item.id, text: clipForTranslation(item.text) });
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

// Codes that name no language: the model's 'unknown', and the ISO codes for
// undetermined, no linguistic content, and multiple languages.
const NOT_A_LANGUAGE = new Set(['unknown', 'und', 'zxx', 'mul']);

// The language to translate an admin reply into, or null to post it as
// written. Only ever the language the model detected for the comment — never
// one guessed from its script, which would answer Persian in Arabic.
export function replyLanguage(detectedLang) {
    if (!detectedLang || detectedLang === TARGET_LANG || NOT_A_LANGUAGE.has(detectedLang)) return null;
    return detectedLang;
}

// Realtime Database keys are never empty and never contain these characters,
// but they are checked, not assumed: they come from an unauthenticated
// database, and Firebase silently drops empty path segments, so a blank key
// would turn "comments/m/c" into "comments/m" — every comment on the movie.
function isSafeKey(key) {
    return typeof key === 'string' && key.length > 0 && !/[\/.#$[\]]/.test(key);
}

// The multi-path write that deletes a comment or a reply together with every
// cached translation that belonged to it. `row` is the top-level comment;
// `item` is that comment itself or one of its replies.
export function deletionWrites(item, row) {
    const isComment = item === row;
    const replies = isComment ? row.replies : [];
    const keys = [row.movieId, row.id, item.id, ...replies.map((reply) => reply.id)];
    if (!keys.every(isSafeKey)) {
        throw new Error('Refusing to delete: a key in its path is malformed');
    }

    const path = isComment
        ? `comments/${row.movieId}/${row.id}`
        : `comments/${row.movieId}/${row.id}/replies/${item.id}`;

    const writes = { [path]: null, [`commentTranslations/${item.id}`]: null };
    for (const reply of replies) writes[`commentTranslations/${reply.id}`] = null;
    return writes;
}

// Runs translation for whatever is pending, one batch at a time, never two
// passes at once. Everything it touches is passed in, so these rules — each
// one learned from a bug — can be tested without a browser:
//
//  - Nothing runs until isReady() says comments and the cache have both
//    loaded; running before the cache arrives re-pays for every comment.
//  - An item is marked attempted only as its batch is sent, so a failure
//    part-way leaves the unsent batches free for the next run.
//  - Each item is sent at most once until clearAttempts(). Every cache write
//    re-triggers a run, so a comment the model keeps dropping would otherwise
//    be re-sent in a loop.
//  - A call that arrives mid-run is not dropped: one more pass follows, so a
//    comment posted during the backlog is picked up. Not after a failure,
//    though — that pass would most likely fail the same way.
export function createTranslationScheduler({
    isReady,
    collectPending,
    translateBatch,
    cache,
    onError,
    batchSize = 25
}) {
    const attempted = new Set();
    let running = false;
    let rerun = false;

    async function run() {
        if (!isReady()) return;
        if (running) {
            rerun = true;
            return;
        }

        running = true;
        let failed = false;
        try {
            const pending = collectPending().filter((item) => !attempted.has(item.id));
            for (const batch of batchItems(pending, batchSize)) {
                batch.forEach((item) => attempted.add(item.id));
                await cache(await translateBatch(batch));
            }
        } catch (error) {
            failed = true;
            try {
                onError(error);
            } catch {
                // A broken error handler must not take the scheduler with it.
            }
        } finally {
            running = false;
        }

        const again = rerun && !failed;
        rerun = false;
        if (again) await run();
    }

    return {
        run,
        clearAttempts: () => attempted.clear(),
        isRunning: () => running
    };
}
