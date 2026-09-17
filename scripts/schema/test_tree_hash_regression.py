"""Real filesystem regression: a protocol D move must not change the tree hash.

The plan (section 0L.2) says treeHash permanently excludes .evolve-op-commit.json.
rev14's semantic validator asserted the OPPOSITE (hashes must differ) and would
have rejected every legal archive/restore/autoArchive manifest. Fixture-level
assertions could not catch that, because both the fixture and the rule were
written from the same wrong belief.

So this test does the real thing: build a skill tree on disk, hash it, write a
commit marker, move the directory, re-hash, and assert equality. If the
exclusion rule is ever dropped from the hasher, this fails.

Run: python3 scripts/schema/test_tree_hash_regression.py
"""
import hashlib
import os
import shutil
import sys
import tempfile
from pathlib import Path

MARKER_NAME = '.evolve-op-commit.json'


def tree_hash(root: Path, *, exclude_marker: bool = True) -> str:
    """Hash a directory tree: relative paths + file contents, sorted.

    Mirrors what the plan requires of the real implementation: stable ordering,
    path included (so renames inside the tree are visible), commit marker
    excluded so that publishing the marker cannot change the hash.
    """
    h = hashlib.sha256()
    entries = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for fn in sorted(filenames):
            if exclude_marker and fn == MARKER_NAME:
                continue
            full = Path(dirpath) / fn
            entries.append((full.relative_to(root).as_posix(), full))
    for rel, full in sorted(entries):
        h.update(rel.encode('utf-8'))
        h.update(b'\0')
        h.update(full.read_bytes())
        h.update(b'\0')
    return h.hexdigest()


def build_skill(root: Path) -> None:
    """A skill is a tree, not one file -- references/ and scripts/ must count."""
    root.mkdir(parents=True)
    (root / 'SKILL.md').write_text('# demo skill\n\nbody text\n', encoding='utf-8')
    (root / 'references').mkdir()
    (root / 'references' / 'api.md').write_text('reference body\n', encoding='utf-8')
    (root / 'scripts').mkdir()
    (root / 'scripts' / 'run.sh').write_text('#!/bin/sh\necho hi\n', encoding='utf-8')


results = []


def check(name, ok, detail=''):
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f'   {detail}' if detail and not ok else ''))


def main():
    work = Path(tempfile.mkdtemp(prefix='treehash-'))
    try:
        skills = work / 'skills'
        archive = work / 'skills' / '.archive'
        archive.mkdir(parents=True)
        src = skills / 'my-skill'
        build_skill(src)

        # 1. hash before anything happens
        before = tree_hash(src)

        # 2. write the commit marker into the source (the plan's ordering:
        #    hash, then marker, then move)
        (src / MARKER_NAME).write_text(
            '{"opId":"op-1","protocol":"D","action":"archive",'
            '"logicalSkillName":"my-skill","archiveId":"my-skill-20260915120000-abc123"}\n',
            encoding='utf-8')

        after_marker = tree_hash(src)
        check('writing the commit marker does not change treeHash',
              after_marker == before, f'{before[:12]} -> {after_marker[:12]}')

        # 3. perform the actual move
        dest = archive / 'my-skill-20260915120000-abc123'
        shutil.move(str(src), str(dest))
        check('source is gone after move', not src.exists())
        check('destination exists after move', dest.exists())
        check('marker travelled with the tree', (dest / MARKER_NAME).exists())

        committed = tree_hash(dest)
        check('*** beforeTreeHash == committedTreeHash (plan 0L.2)',
              committed == before, f'{before[:12]} vs {committed[:12]}')

        # 4. the exclusion must be the ONLY reason they match: prove the hasher
        #    would otherwise notice the marker.
        with_marker = tree_hash(dest, exclude_marker=False)
        check('without the exclusion the marker WOULD change the hash',
              with_marker != before,
              'hasher ignores the marker for another reason -- exclusion untested')

        # 5. real content changes must still be detected
        (dest / 'references' / 'api.md').write_text('EDITED\n', encoding='utf-8')
        check('editing a nested file does change treeHash', tree_hash(dest) != before)

        # 6. the nested tree really is part of the hash
        shutil.rmtree(dest / 'scripts')
        check('deleting scripts/ does change treeHash', tree_hash(dest) != before)

        # 7. restore direction: moving back must also preserve the hash
        src2 = skills / 'my-skill'
        clean = work / 'clean'
        build_skill(clean)
        base = tree_hash(clean)
        (clean / MARKER_NAME).write_text('{"opId":"op-2","protocol":"D","action":"restore"}\n',
                                        encoding='utf-8')
        shutil.move(str(clean), str(src2))
        check('restore direction also preserves treeHash', tree_hash(src2) == base,
              f'{base[:12]} vs {tree_hash(src2)[:12]}')

        failed = [r for r in results if not r[1]]
        print(f'\n{"=" * 58}\nTOTAL: {len(results) - len(failed)}/{len(results)} passed, '
              f'{len(failed)} failed')
        return 1 if failed else 0
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main())
