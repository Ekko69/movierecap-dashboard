import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectScript, needsTranslation, TARGET_LANG, ADMIN_NAME } from './comments.js';

test('detectScript identifies the scripts present in the live data', () => {
    assert.equal(detectScript('ဘာသာပြန်ပေးပါ'), 'my');
    assert.equal(detectScript('انشئ لي فيلم مغربي'), 'ar');
    assert.equal(detectScript('สวัสดี'), 'th');
    assert.equal(detectScript('how can download this video?'), 'latin');
});

test('detectScript prefers kana over han for Japanese text', () => {
    // Japanese mixes kana with han characters; kana is the deciding signal.
    assert.equal(detectScript('これは映画です'), 'ja');
    assert.equal(detectScript('电影'), 'zh');
});

test('detectScript reports empty for text with nothing in it', () => {
    assert.equal(detectScript(''), 'empty');
    assert.equal(detectScript(null), 'empty');
    assert.equal(detectScript(undefined), 'empty');
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
});

test('module constants are the values the spec fixed', () => {
    assert.equal(TARGET_LANG, 'en');
    assert.equal(ADMIN_NAME, 'Movie Recap');
});
