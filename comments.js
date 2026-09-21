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

// A thread's replies, oldest first: a conversation reads top to bottom.
function flattenReplies(replies) {
    if (!replies || typeof replies !== 'object') return [];

    return Object.entries(replies)
        .filter(([, reply]) => reply && typeof reply === 'object')
        .map(([replyId, reply]) => ({
            id: replyId,
            text: reply.text || '',
            userName: reply.userName || 'Anonymous',
            timestamp: reply.timestamp || 0,
            isAdmin: reply.isAdmin === true
        }))
        .sort((a, b) => (a.timestamp - b.timestamp) || a.id.localeCompare(b.id));
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
                movieId,
                movieTitle: moviesById.get(movieId)?.title || 'Unknown movie',
                text: comment.text || '',
                userName: comment.userName || 'Anonymous',
                timestamp: comment.timestamp || 0,
                isAdmin: comment.isAdmin === true,
                replies: flattenReplies(comment.replies)
            });
        }
    }

    rows.sort((a, b) => (b.timestamp - a.timestamp) || a.id.localeCompare(b.id));
    return rows;
}
