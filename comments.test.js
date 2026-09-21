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
