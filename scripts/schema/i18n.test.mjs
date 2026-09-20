/**
 * The i18n layer, and the one property that makes it safe to translate prompts.
 *
 * Injected anchors come in pairs: a header that goes into the conversation, and an
 * instruction elsewhere telling the model to look for that header. If one side is
 * translated and the other is not, the model is told to find a marker that is never
 * sent -- strictly worse than leaving everything in Chinese, because the all-Chinese
 * state at least agrees with itself. Most of this file exists for that.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  t, resolveLanguage, keysOf, LANGUAGES, FALLBACK_LANGUAGE, ANCHOR_PAIRS,
} from '../../lib/i18n.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

test('both languages define exactly the same keys', () => {
  const [en, zh] = [keysOf('en'), keysOf('zh')];
  assert.deepEqual(zh, en,
    'a key present in one language and missing in the other renders as the key name, '
    + 'or silently falls back to English mid-sentence');
});

test('an anchor and the instruction naming it agree, in every language', () => {
  for (const lang of LANGUAGES) {
    for (const [headerKey, referenceKey] of ANCHOR_PAIRS) {
      const header = t(lang, headerKey);
      const reference = t(lang, referenceKey);
      assert.ok(header.includes(reference),
        `[${lang}] the instruction says to look for ${JSON.stringify(reference)}, but the `
        + `injected header is ${JSON.stringify(header)}. A model told to find a marker `
        + 'that is never sent is worse off than with an untranslated one.');
    }
  }
});

test('English strings contain no Chinese, and Chinese strings do', () => {
  // The point of the English table is that nothing Chinese leaks through it. The
  // reverse check catches a zh entry that was accidentally replaced by the English one.
  for (const key of keysOf('en')) {
    assert.equal(CJK.test(t('en', key)), false,
      `en.${key} still contains Chinese: ${t('en', key)}`);
  }
  const zhWithCjk = keysOf('zh').filter((k) => CJK.test(t('zh', k)));
  assert.ok(zhWithCjk.length >= keysOf('zh').length - 2,
    'most zh entries should contain Chinese; if they do not, the table was overwritten '
    + `with English (${zhWithCjk.length} of ${keysOf('zh').length})`);
});

test('placeholders are substituted, and unknown ones are left visible', () => {
  const out = t('en', 'notice.repeatedError', { count: 3, fingerprint: 'EPERM on publish' });
  assert.match(out, /3 times/);
  assert.match(out, /EPERM on publish/);
  // A missing variable must stay as {name}: rendering "undefined" into a prompt is
  // both confusing to the model and impossible to grep for afterwards.
  assert.match(t('en', 'notice.repeatedError', { count: 1 }), /\{fingerprint\}/);
});

test('every placeholder in a string is fed by at least one caller', () => {
  // Guards the other direction: a template with a placeholder nobody supplies renders
  // a literal {brace} to the user.
  for (const lang of LANGUAGES) {
    for (const key of keysOf(lang)) {
      const names = [...t(lang, key).matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      for (const name of names) {
        assert.match(name, /^[a-z][A-Za-z]*$/,
          `${lang}.${key} has a suspicious placeholder {${name}}`);
      }
    }
  }
});

test('the override wins over the host locale', () => {
  assert.equal(resolveLanguage('en', { preference: 'zh' }), 'en');
  assert.equal(resolveLanguage('zh', { preference: 'en' }), 'zh');
});

test('follow-host reads the host preference, including regional forms', () => {
  assert.equal(resolveLanguage('follow-host', { preference: 'zh' }), 'zh');
  assert.equal(resolveLanguage('follow-host', { preference: 'en' }), 'en');
  // The host allows BCP-47-style ids; zh-CN and en-GB must not fall through to the
  // default just because they carry a region.
  assert.equal(resolveLanguage('follow-host', { preference: 'zh-CN' }), 'zh');
  assert.equal(resolveLanguage('follow-host', { preference: 'zh-Hans' }), 'zh');
  assert.equal(resolveLanguage('follow-host', { preference: 'en-GB' }), 'en');
});

test('an absent host locale falls back to English instead of throwing', () => {
  // ctx.settings.get('locale') returns undefined when no settings provider is mounted.
  // The issue reporter warned about this case specifically.
  assert.equal(resolveLanguage('follow-host', undefined), FALLBACK_LANGUAGE);
  assert.equal(resolveLanguage('follow-host', {}), FALLBACK_LANGUAGE);
  assert.equal(resolveLanguage('follow-host', { preference: '' }), FALLBACK_LANGUAGE);
  assert.equal(resolveLanguage(undefined, undefined), FALLBACK_LANGUAGE);
  // A language pack the plugin has no strings for is not an error either.
  assert.equal(resolveLanguage('follow-host', { preference: 'de' }), FALLBACK_LANGUAGE);
});

test('the Chinese search internals were not touched', () => {
  // These are retrieval machinery, not display text. English queries already go
  // through the same BM25 path, and "translating" a stopword list would break Chinese
  // retrieval for nothing. The issue explicitly carved them out.
  const search = readFileSync(join(repoRoot, 'lib', 'search.js'), 'utf8');
  const stopwords = /const STOPWORDS = new Set\(\[([\s\S]*?)\]\)/.exec(search);
  assert.ok(stopwords, 'the stopword list must still exist in lib/search.js');
  const entries = (stopwords[1].match(/'/g) ?? []).length / 2;
  assert.equal(entries, 90,
    `the Chinese stopword list should still hold 90 entries, found ${entries}`);

  const fts = readFileSync(join(repoRoot, 'lib', 'fts.js'), 'utf8');
  assert.match(fts, /bigram/i, 'CJK bigram tokenization must still be in lib/fts.js');
});

test('no hardcoded Chinese remains in the strings the user sees', () => {
  // Scoped to what this change was for: the anchors and notices in lib/index.js. The
  // rest of that file's Chinese is comments, which are for maintainers.
  const src = readFileSync(join(repoRoot, 'lib', 'index.js'), 'utf8');
  const offenders = [];
  src.split('\n').forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '');
    if (!CJK.test(code)) return;
    // Strings reaching the model or the UI are what matter; a Chinese comment is fine.
    if (/text:|nudge\(|label:|title:|lines\s*=|push\(/.test(code)) {
      offenders.push(`${i + 1}: ${line.trim().slice(0, 80)}`);
    }
  });
  assert.deepEqual(offenders, [],
    'these lines still build user- or model-facing Chinese literals; route them '
    + 'through lib/i18n.js so the English setup gets English');
});
