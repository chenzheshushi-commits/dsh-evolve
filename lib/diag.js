/** Privacy-preserving retrieval diagnostics for tidy quality comparisons. */
import { createHash } from 'node:crypto';
import { tokenize } from './search.js';

export function classifyScript(text) {
  let cjk = 0; let latin = 0; let other = 0;
  for (const ch of String(text ?? '')) {
    const cp = ch.codePointAt(0);
    if ((cp >= 0x3400 && cp <= 0x9fff) || (cp >= 0x20000 && cp <= 0x323af)) cjk += 1;
    else if (/[A-Za-z0-9]/.test(ch)) latin += 1;
    else if (!/\s/.test(ch)) other += 1;
  }
  if (cjk > 0 && latin > 0) return 'mixed-cjk-latin';
  if (cjk > 0) return 'cjk';
  if (latin > 0) return 'latin';
  return other > 0 ? 'other' : 'empty';
}

/** Never returns the raw query or any reversible preview. */
export function buildRecallDiag(query, { hits = 0, ms = 0, path = 'unknown', source = 'unknown' } = {}) {
  const raw = String(query ?? '');
  return {
    event: 'recall',
    source,
    queryHash: createHash('sha256').update(raw, 'utf8').digest('hex'),
    queryLen: raw.length,
    tokenCount: tokenize(raw).length,
    scriptClass: classifyScript(raw),
    hits: Number(hits) || 0,
    ms: Math.max(0, Number(ms) || 0),
    path,
  };
}
