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
