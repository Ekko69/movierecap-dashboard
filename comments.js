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

// Kana is checked before han because Japanese mixes the two, and han alone
// would misreport Japanese as Chinese. Ordered by what the live data contains.
const SCRIPT_RANGES = [
    ['my', /[က-႟]/],   // Burmese — 65 comments
    ['ar', /[؀-ۿ]/],   // Arabic — 7 comments
    ['th', /[฀-๿]/],   // Thai — 1 comment
    ['ja', /[぀-ヿ]/],   // Hiragana + katakana
    ['ko', /[가-힯]/],   // Hangul
    ['zh', /[一-鿿]/],   // Han
    ['hi', /[ऀ-ॿ]/],   // Devanagari
    ['ru', /[Ѐ-ӿ]/]    // Cyrillic
];

// The script a comment is written in, as a hint only. Latin-script text still
// goes to the model, because romanized Burmese and Tagalog are
// indistinguishable from English by regex.
export function detectScript(text) {
    if (!text) return 'empty';
    for (const [code, pattern] of SCRIPT_RANGES) {
        if (pattern.test(text)) return code;
    }
    return 'latin';
}

// Whether this text carries words worth sending to a translator. Emoji,
// punctuation and bare digits carry no language, so they never leave the
// browser.
export function needsTranslation(text) {
    if (!text) return false;
    return /\p{L}/u.test(String(text));
}
