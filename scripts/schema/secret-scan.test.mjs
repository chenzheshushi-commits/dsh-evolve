/** Secret persistence safety: all seven faces, no raw token in diagnostics. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SECRET_PATTERNS, scanSecrets, redactSecrets, secretIncident } from '../../lib/secret-scan.js';
import { MemoryStore } from '../../lib/store.js';
import { applySkillMutation } from '../../lib/skill-mutation.js';
import { appendAudit } from '../../lib/prune-plan.js';

const OWNER = 'a'.repeat(32);
const fixtures = {
  'github-pat': 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456',
  'github-fine': 'github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ_123456',
  'aws-akid': 'AKIAABCDEFGHIJKLMNOP',
  'openai-legacy': 'sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456',
  'openai-project': 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ_123456',
  anthropic: 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ_123456',
  'anthropic-alt': 'as_sk_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456',
  'pem-private': '-----BEGIN RSA PRIVATE KEY-----',
  slack: 'xoxb-ABCDEFGHIJKLMN123456',
  bearer: 'Bearer ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890',
};

function table() {
  const m = new Map();
  return {
    entries: () => m.entries(), get: async (k) => m.get(k),
    put: async (k, v) => { m.set(k, v); }, delete: async (k) => m.delete(k),
    update: async (k, fn) => { m.set(k, fn(m.get(k))); }, get size() { return m.size; },
    _map: m,
  };
}
function storeAt(root) {
  return new MemoryStore(table(), {
    workspaceDir: root,
    config: { maxContentChars: 40000, maxPendingQueue: 50, mergeSimilarity: 0.82,
      auditMaxRuns: 50, approvalMode: 'manual' },
    logger: { warn() {}, info() {} },
  });
}

test('descriptor fixtures all match their named pattern', () => {
  assert.ok(SECRET_PATTERNS.length >= 10, 'maintainable descriptor table, not scattered regexes');
  for (const [name, value] of Object.entries(fixtures)) {
    const names = scanSecrets(`before ${value} after`).map((h) => h.patternName);
    assert.ok(names.includes(name), `${name} must be detected; got ${names.join(',')}`);
  }
});

test('normal security prose is not a secret', () => {
  const normal = [
    '密码不要写进仓库', 'rotate the token after use', '密钥应存入 vault',
    'Authorization: Bearer <your-token>', 'OpenAI keys start with sk- and should be masked',
  ];
  for (const text of normal) assert.deepEqual(scanSecrets(text), [], text);
});

test('redaction preserves context but never the raw match', () => {
  for (const [name, raw] of Object.entries(fixtures)) {
    const out = redactSecrets(`prefix ${raw} suffix`).text;
    assert.match(out, /prefix/); assert.match(out, /suffix/);
    assert.ok(!out.includes(raw), `${name}: raw value must be gone`);
    assert.match(out, new RegExp(`REDACTED:${name}`));
  }
});

test('incident metadata is irreversible and raw-free', () => {
  const raw = fixtures['github-pat'];
  const inc = secretIncident(`prefix ${raw} suffix`, { sourceIds: ['m1'] });
  assert.equal(inc.patternName, 'github-pat');
  assert.equal(inc.sourceIds[0], 'm1');
  assert.ok(!JSON.stringify(inc).includes(raw));
  assert.match(inc.maskedSnippet, /REDACTED:github-pat/);
  assert.equal(inc.contentSha256.length, 64);
});

test('memory content and tag are refused BEFORE mirror/storage', async () => {
  for (const face of ['content', 'tag']) {
    const root = mkdtempSync(join(tmpdir(), 'dsh-secret-'));
    try {
      const st = storeAt(root); const raw = fixtures['github-pat'];
      const r = await st.remember({
        content: face === 'content' ? `save ${raw}` : 'safe fact',
        tags: face === 'tag' ? [raw] : ['safe'], kind: 'lesson', scope: 'project',
        importance: 2, provenance: 'model-tool',
      });
      assert.equal(r, null, `${face} must be refused`);
      assert.match(st.lastWriteRefusal.reason, /github-pat/);
      assert.equal(st.all().length, 0, 'no truth-store write');
      if (existsSync(join(root, 'MEMORY.md'))) {
        assert.ok(!readFileSync(join(root, 'MEMORY.md'), 'utf8').includes(raw), 'no mirror leak');
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('clean content + secret sourceContext writes a REDACTED memory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-secret-'));
  try {
    const st = storeAt(root); const raw = fixtures['openai-project'];
    const r = await st.remember({ content: '用户要求定期轮换 API 凭据', sourceContext: `原话 ${raw} 请轮换`,
      tags: ['security'], kind: 'lesson', scope: 'project', importance: 2,
      confirm: true, provenance: 'review' });
    assert.ok(r?.id, 'memory itself is valuable and must survive');
    assert.ok(!r.sourceContext.includes(raw));
    assert.match(r.sourceContext, /REDACTED:openai-project/);
    assert.ok(!readFileSync(join(root, 'MEMORY.md'), 'utf8').includes(raw));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('model input cannot smuggle the internal secretGrant flag through tool schema', () => {
  const src = readFileSync(new URL('../../lib/index.js', import.meta.url), 'utf8');
  const toolStart = src.indexOf("name: 'memory_remember'");
  const toolEnd = src.indexOf('presentCall:', toolStart);
  const params = src.slice(toolStart, toolEnd);
  assert.equal(/allowSecretLike|secretGrant/.test(params), false,
    'the model tool must have no self-service bypass boolean');
});

test('human caller-derived grant can write once; no reusable config exists', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-secret-'));
  try {
    const st = storeAt(root); const raw = fixtures['github-pat'];
    const denied = await st.remember({ content: raw, confirm: true, provenance: 'model-tool' });
    assert.equal(denied, null);
    const allowed = await st.remember({ content: raw, confirm: true, secretGrant: true,
      provenance: 'explicit-user-request' });
    assert.ok(allowed?.id, 'only caller-derived UI/grant path can set the internal bit');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('all skill persistence faces are scanned before publish', () => {
  const faces = ['body', 'description', 'tag', 'meta', 'records'];
  for (const face of faces) {
    const root = mkdtempSync(join(tmpdir(), 'dsh-secret-skill-'));
    try {
      const base = {
        action: 'crystallize', source: 'model-tool', skillsDir: join(root, 'skills'),
        archiveDir: join(root, 'archive'), ownerId: OWNER, logger: { warn() {} },
      };
      const raw = fixtures.anthropic;
      const payload = { name: `skill-${face}`, tag: 'safe', records: [], body: '# Safe',
        description: 'safe', meta: { note: 'safe' } };
      if (face === 'records') payload.records = [{ id: 'm1', content: raw, tags: [] }];
      else payload[face] = raw;
      const incidents = [];
      const r = applySkillMutation({ ...base, payload, onSecretIncident: (x) => incidents.push(x) });
      assert.equal(r.ok, false, face);
      assert.match(r.reason, new RegExp(`in ${face}`));
      assert.equal(incidents.length, 1);
      assert.ok(!JSON.stringify(incidents[0]).includes(raw), `${face} incident raw-free`);
      assert.ok(!existsSync(join(root, 'skills', `skill-${face}`)), `${face} never published`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('audit recursively redacts every string field', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-secret-audit-'));
  try {
    const raw = fixtures.bearer;
    appendAudit(root, { event: 'diag', rawQuery: raw, nested: { error: `oops ${raw}` }, arr: [raw] },
      { auditMaxRuns: 10 }, { warn() {} });
    const text = readFileSync(join(root, '.evolve-audit.jsonl'), 'utf8');
    assert.ok(!text.includes(raw));
    assert.equal((text.match(/REDACTED:bearer/g) ?? []).length, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('tag scan happens before lower-casing and persistence never exceeds the scanned prefix', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-secret-limit-'));
  try {
    const st = storeAt(root);
    const aws = fixtures['aws-akid'];
    const tagDenied = await st.remember({ content: 'safe', tags: [aws], confirm: true,
      provenance: 'model-tool' });
    assert.equal(tagDenied, null, 'AKIA would disappear if tags were lower-cased before scanning');

    const long = 'x'.repeat(25_000) + fixtures['github-pat'];
    const r = await st.remember({ content: long, confirm: true, secretGrant: true,
      provenance: 'explicit-user-request' });
    assert.ok(r.content.length <= 24_000,
      'no unchecked suffix may be persisted -- the write cap equals the scan cap');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('skill bodies larger than the complete scan budget are refused, not prefix-scanned', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-secret-limit-'));
  try {
    const r = applySkillMutation({ action: 'crystallize', source: 'model-tool',
      skillsDir: join(root, 'skills'), archiveDir: join(root, 'archive'), ownerId: OWNER,
      payload: { name: 'too-large', tag: 'safe', records: [], body: 'x'.repeat(24_001) } });
    assert.equal(r.ok, false);
    assert.match(r.reason, /complete secret-scan limit/);
    assert.ok(!existsSync(join(root, 'skills', 'too-large')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('workspace .gitignore upgrades an existing file with every runtime secret surface', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-secret-ignore-'));
  try {
    writeFileSync(join(root, '.gitignore'), '# user rule\ncustom/\n');
    const st = storeAt(root);
    await st.remember({ content: 'safe', confirm: true, provenance: 'explicit-user-request' });
    const text = readFileSync(join(root, '.gitignore'), 'utf8');
    for (const rule of ['*.jsonl', 'skill-proposals/', '.curator-backups/', '.evolve-owner.json',
      '.evolve-reservations.json', 'secret-incidents/', '.ops/', '.locks/', '.wal/', '.orphans/']) {
      assert.ok(text.split('\n').includes(rule), `missing ${rule}`);
    }
    assert.match(text, /custom\//, 'existing user rules are preserved');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
