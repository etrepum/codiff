import { expect, test } from 'vite-plus/test';
import { fileHasVisibleDiff, getVisibleDiffSections } from './App.tsx';
import type { ChangedFile } from './types.ts';

test('pure renames are visible without content hunks', () => {
  const file = {
    fingerprint: 'rename-only',
    oldPath: 'old.txt',
    path: 'new.txt',
    sections: [
      {
        binary: false,
        id: 'new.txt:staged',
        kind: 'staged',
        newFile: {
          contents: 'same contents\n',
          name: 'new.txt',
        },
        oldFile: {
          contents: 'same contents\n',
          name: 'old.txt',
        },
        patch:
          'diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt\n',
      },
    ],
    status: 'renamed',
  } satisfies ChangedFile;

  const visibleSections = getVisibleDiffSections(file, false);

  expect(visibleSections).toHaveLength(1);
  expect(visibleSections[0].fileDiff.hunks).toHaveLength(0);
  expect(fileHasVisibleDiff(file, false)).toBe(true);
});
