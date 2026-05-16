import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vite-plus/test';
import type { RepositoryState } from './types.ts';

type StatusEntry = {
  oldPath?: string;
  path: string;
  staged: boolean;
  status: string;
  unstaged: boolean;
  untracked: boolean;
};

type GitStateModule = {
  parseStatus: (raw: string) => Array<StatusEntry>;
  readRepositoryChangeSignature: (
    launchPath: string,
  ) => Promise<{ root: string; signature: string }>;
  readRepositoryState: (launchPath: string) => Promise<RepositoryState>;
  readWorkingTreeState: (launchPath: string) => Promise<RepositoryState>;
};

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const { parseStatus, readRepositoryChangeSignature, readRepositoryState, readWorkingTreeState } =
  require('../electron/git-state.cjs') as GitStateModule;

const git = async (repo: string, args: ReadonlyArray<string>) => {
  const { stdout } = await execFileAsync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 16,
  });
  return stdout;
};

const createRepo = async () => {
  const repo = await mkdtemp(join(tmpdir(), 'codiff-git-state-'));
  await git(repo, ['init']);
  await git(repo, ['config', 'user.email', 'codiff@example.com']);
  await git(repo, ['config', 'user.name', 'Codiff Test']);
  return realpath(repo);
};

const writeRepoFile = async (repo: string, path: string, contents: string | Uint8Array) => {
  const absolutePath = join(repo, path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, contents);
};

const commitAll = async (repo: string, message: string) => {
  await git(repo, ['add', '--all']);
  await git(repo, ['commit', '-m', message]);
};

const withRepo = async (run: (repo: string) => Promise<void>) => {
  const repo = await createRepo();
  try {
    await run(repo);
  } finally {
    await rm(repo, { force: true, recursive: true });
  }
};

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

test('parseStatus preserves staged and unstaged flags on the same file', () => {
  expect(parseStatus('MM file.txt\0')).toEqual([
    {
      oldPath: undefined,
      path: 'file.txt',
      staged: true,
      status: 'modified',
      unstaged: true,
      untracked: false,
    },
  ]);
});

test('readWorkingTreeState separates staged and unstaged modifications', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'file.txt', 'one\n');
    await commitAll(repo, 'initial commit');
    await writeRepoFile(repo, 'file.txt', 'two\n');
    await git(repo, ['add', 'file.txt']);
    await writeRepoFile(repo, 'file.txt', 'three\n');

    const state = await readWorkingTreeState(repo);

    expect(state.root).toBe(repo);
    expect(state.files).toHaveLength(1);
    expect(state.files[0].path).toBe('file.txt');
    expect(state.files[0].status).toBe('modified');
    expect(state.files[0].sections.map((section) => section.kind)).toEqual(['staged', 'unstaged']);
    expect(state.files[0].sections[0].oldFile?.contents).toBe('one\n');
    expect(state.files[0].sections[0].newFile?.contents).toBe('two\n');
    expect(state.files[0].sections[1].oldFile?.contents).toBe('two\n');
    expect(state.files[0].sections[1].newFile?.contents).toBe('three\n');
  });
});

test('readWorkingTreeState reports staged pure renames with old and new paths', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'old.txt', 'same contents\n');
    await commitAll(repo, 'initial commit');
    await git(repo, ['mv', 'old.txt', 'new.txt']);

    const state = await readWorkingTreeState(repo);

    expect(state.files).toHaveLength(1);
    expect(state.files[0].oldPath).toBe('old.txt');
    expect(state.files[0].path).toBe('new.txt');
    expect(state.files[0].status).toBe('renamed');
    expect(state.files[0].sections).toHaveLength(1);
    expect(state.files[0].sections[0].kind).toBe('staged');
    expect(state.files[0].sections[0].oldFile?.name).toBe('old.txt');
    expect(state.files[0].sections[0].oldFile?.contents).toBe('same contents\n');
    expect(state.files[0].sections[0].newFile?.name).toBe('new.txt');
    expect(state.files[0].sections[0].newFile?.contents).toBe('same contents\n');
  });
});

test('readWorkingTreeState reports staged and unstaged deletions', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'staged-delete.txt', 'staged\n');
    await writeRepoFile(repo, 'unstaged-delete.txt', 'unstaged\n');
    await commitAll(repo, 'initial commit');
    await git(repo, ['rm', 'staged-delete.txt']);
    await rm(join(repo, 'unstaged-delete.txt'));

    const state = await readWorkingTreeState(repo);
    const stagedDelete = state.files.find((file) => file.path === 'staged-delete.txt');
    const unstagedDelete = state.files.find((file) => file.path === 'unstaged-delete.txt');

    expect(stagedDelete?.status).toBe('deleted');
    expect(stagedDelete?.sections).toHaveLength(1);
    expect(stagedDelete?.sections[0].kind).toBe('staged');
    expect(stagedDelete?.sections[0].oldFile?.contents).toBe('staged\n');
    expect(stagedDelete?.sections[0].newFile?.contents).toBe('');

    expect(unstagedDelete?.status).toBe('deleted');
    expect(unstagedDelete?.sections).toHaveLength(1);
    expect(unstagedDelete?.sections[0].kind).toBe('unstaged');
    expect(unstagedDelete?.sections[0].oldFile?.contents).toBe('unstaged\n');
    expect(unstagedDelete?.sections[0].newFile?.contents).toBe('');
  });
});

test('readWorkingTreeState reports untracked text and binary files', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'tracked.txt', 'tracked\n');
    await commitAll(repo, 'initial commit');
    await writeRepoFile(repo, 'notes/new.txt', 'untracked\n');
    await writeRepoFile(repo, 'raw.bin', Uint8Array.from([0, 1, 2, 3]));

    const state = await readWorkingTreeState(repo);
    const textFile = state.files.find((file) => file.path === 'notes/new.txt');
    const binaryFile = state.files.find((file) => file.path === 'raw.bin');

    expect(textFile?.status).toBe('untracked');
    expect(textFile?.sections).toHaveLength(1);
    expect(textFile?.sections[0].kind).toBe('unstaged');
    expect(textFile?.sections[0].binary).toBe(false);
    expect(textFile?.sections[0].oldFile?.contents).toBe('');
    expect(textFile?.sections[0].newFile?.contents).toBe('untracked\n');
    expect(textFile?.sections[0].patch).toContain('new file mode');

    expect(binaryFile?.status).toBe('untracked');
    expect(binaryFile?.sections).toHaveLength(1);
    expect(binaryFile?.sections[0].kind).toBe('unstaged');
    expect(binaryFile?.sections[0].binary).toBe(true);
    expect(binaryFile?.sections[0].newFile).toBeUndefined();
  });
});

test('readWorkingTreeState marks modified binary files as binary sections', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'raw.bin', Uint8Array.from([0, 1, 2, 3]));
    await commitAll(repo, 'initial commit');
    await writeRepoFile(repo, 'raw.bin', Uint8Array.from([0, 9, 2, 3]));

    const state = await readWorkingTreeState(repo);

    expect(state.files).toHaveLength(1);
    expect(state.files[0].path).toBe('raw.bin');
    expect(state.files[0].status).toBe('modified');
    expect(state.files[0].sections).toHaveLength(1);
    expect(state.files[0].sections[0].binary).toBe(true);
    expect(state.files[0].sections[0].oldFile).toBeUndefined();
    expect(state.files[0].sections[0].newFile).toBeUndefined();
  });
});

test('readRepositoryChangeSignature changes for unstaged content edits', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'file.txt', 'one\n');
    await commitAll(repo, 'initial commit');
    await writeRepoFile(repo, 'file.txt', 'two changed\n');

    const before = await readRepositoryChangeSignature(repo);
    await writeRepoFile(repo, 'file.txt', 'three\n');
    const after = await readRepositoryChangeSignature(repo);

    expect(before.root).toBe(repo);
    expect(after.signature).not.toBe(before.signature);
  });
});

test('readRepositoryChangeSignature changes for untracked content edits', async () => {
  await withRepo(async (repo) => {
    await writeRepoFile(repo, 'file.txt', 'one\n');

    const before = await readRepositoryChangeSignature(repo);
    await writeRepoFile(repo, 'file.txt', 'two changed\n');
    const after = await readRepositoryChangeSignature(repo);

    expect(after.signature).not.toBe(before.signature);
  });
});

test('readRepositoryState rejects non-repository launch paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-not-a-repo-'));
  try {
    await expect(readRepositoryState(directory)).rejects.toThrow(/not a git repository/i);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
