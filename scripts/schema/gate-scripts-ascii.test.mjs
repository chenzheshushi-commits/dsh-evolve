/**
 * The Python contract gates must be runnable on a Windows console.
 *
 * scripts/schema/test_tree_hash_regression.py printed a U+2B50 star in one PASS
 * label. Every gate passed, then the script died in print():
 *
 *   UnicodeEncodeError: 'charmap' codec can't encode character '\u2b50'
 *
 * Windows Python uses the console's ANSI code page (cp1252 on the GitHub runner)
 * for stdout, not UTF-8, so a single decorative glyph turns a green gate red on
 * one platform only -- and the failure names an encoding, not the property under
 * test, which sends the next reader looking in the wrong place entirely.
 *
 * Restricting these files to ASCII is the cheap, total fix. It applies ONLY to
 * scripts/schema/*.py (the gates CI executes): lib/search.js keeps its Chinese
 * stopword table, and .mjs tests keep their Chinese fixtures, because Node's
 * stdout is UTF-8 on every platform.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('.', import.meta.url));

test('the Python contract gates are ASCII-only, so a Windows console can print them', () => {
  const files = readdirSync(dir).filter((f) => f.endsWith('.py'));
  assert.ok(files.length >= 5, `expected the gate scripts to be here (found ${files.length})`);
  const offenders = [];
  for (const f of files) {
    const text = readFileSync(`${dir}${f}`, 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      for (const ch of lines[i]) {
        const cp = ch.codePointAt(0);
        if (cp > 0x7f) {
          offenders.push(`${f}:${i + 1} U+${cp.toString(16).toUpperCase().padStart(4, '0')} (${ch})`);
          break;
        }
      }
    }
  }
  assert.deepEqual(offenders, [],
    'non-ASCII in a gate script will raise UnicodeEncodeError on a Windows console '
    + `and fail the gate for an encoding reason:\n  ${offenders.join('\n  ')}`);
});
