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
