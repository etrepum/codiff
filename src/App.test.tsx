import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';
import { fileHasVisibleDiff, getVisibleDiffSections } from './App.tsx';
import type { ChangedFile } from './types.ts';

const require = createRequire(import.meta.url);
const { parseStatus } = require('../electron/git-state.cjs') as {
  parseStatus: (raw: string) => Array<{
    oldPath?: string;
    path: string;
    staged: boolean;
    status: string;
    unstaged: boolean;
    untracked: boolean;
  }>;
};

test('App', () => {
  expect(1 + 1).toBe(2);
});

test('parseStatus reads staged rename paths in porcelain v1 -z order', () => {
  expect(parseStatus('R  new.txt\0old.txt\0')).toEqual([
    {
      oldPath: 'old.txt',
      path: 'new.txt',
      staged: true,
      status: 'renamed',
      unstaged: false,
      untracked: false,
    },
  ]);
});

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
