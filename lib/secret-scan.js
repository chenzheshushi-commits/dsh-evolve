/**
 * High-precision, zero-LLM secret scanner for persisted evolve data.
 *
 * Strong prefixes only. Words such as "password", "token" and "密钥" are NOT
 * secrets by themselves; scanning them would make normal security knowledge
 * impossible to remember. Keep descriptors in one table so every new vendor is
 * testable and the returned reason can name what matched without returning it.
 */
import { createHash } from 'node:crypto';

export const MAX_SECRET_SCAN_CHARS = 24_000;

export const SECRET_PATTERNS = Object.freeze([
  { name: 'github-pat', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
  { name: 'github-fine', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: 'aws-akid', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'openai-project', re: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'anthropic', re: /\bsk-ant-(?:api\d{2}-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: 'anthropic-alt', re: /\bas_sk_[A-Za-z0-9]{20,}\b/g },
  { name: 'openai-legacy', re: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { name: 'pem-private', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: 'slack', re: /\bxox[bpsa]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._-]{30,}\b/gi },
  // Future sk-<vendor>-<high entropy tail> formats. More specific descriptors
  // come first so the incident names the vendor format when we know it.
  { name: 'generic-sk', re: /\bsk-[A-Za-z0-9_-]+-[A-Za-z0-9_-]{20,}\b/g },
]);

function clip(value, maxChars = MAX_SECRET_SCAN_CHARS) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text.slice(0, Math.max(0, maxChars));
}

/** Return safe match metadata; NEVER returns the matching secret. */
export function scanSecrets(value, opts = {}) {
  const text = clip(value, opts.maxChars);
  const hits = [];
  for (const pattern of SECRET_PATTERNS) {
    pattern.re.lastIndex = 0;
    for (let m = pattern.re.exec(text); m; m = pattern.re.exec(text)) {
      const raw = m[0];
      hits.push({
        patternName: pattern.name,
        start: m.index,
        end: m.index + raw.length,
        length: raw.length,
        sha256: createHash('sha256').update(raw).digest('hex'),
      });
      if (m[0].length === 0) pattern.re.lastIndex += 1;
    }
  }
  // Specific patterns may overlap the generic fallback. Keep the first hit for
  // each exact range: descriptor order makes the specific name win.
  const seen = new Set();
  return hits.filter((h) => {
    const key = `${h.start}:${h.end}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * Redact every recognised secret while preserving surrounding context. The raw
 * match never appears in output; the pattern name is enough for explanation.
 */
export function redactSecrets(value, opts = {}) {
  const text = clip(value, opts.maxChars);
  const hits = scanSecrets(text, { maxChars: text.length });
  if (hits.length === 0) return { text, hits: [], truncated: String(value ?? '').length > text.length };
  let out = '';
  let pos = 0;
  for (const h of hits) {
    if (h.start < pos) continue;
    out += text.slice(pos, h.start);
    out += `***[REDACTED:${h.patternName}]***`;
    pos = h.end;
  }
  out += text.slice(pos);
  return {
    text: out,
    hits,
    truncated: String(value ?? '').length > text.length,
  };
}

export function firstSecretReason(value, opts = {}) {
  const hit = scanSecrets(value, opts)[0];
  return hit ? `refused: looks like a secret (${hit.patternName})` : null;
}

/** Safe, irreversible incident metadata. */
export function secretIncident(value, extra = {}) {
  const text = clip(value);
  const hit = scanSecrets(text, { maxChars: text.length })[0];
  if (!hit) return null;
  const redacted = redactSecrets(text, { maxChars: text.length }).text;
  return {
    incidentId: `secret_${createHash('sha256').update(`${Date.now()}:${hit.sha256}`).digest('hex').slice(0, 20)}`,
    patternName: hit.patternName,
    contentSha256: createHash('sha256').update(text).digest('hex'),
    maskedSnippet: redacted.slice(Math.max(0, hit.start - 80), Math.min(redacted.length, hit.start + 160)),
    at: new Date().toISOString(),
    ...extra,
  };
}
