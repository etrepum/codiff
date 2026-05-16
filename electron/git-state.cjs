const { execFile } = require('node:child_process');
const { promises: fs } = require('node:fs');
const { createHash } = require('node:crypto');
const { join } = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const getFingerprint = (value) => createHash('sha256').update(value).digest('hex').slice(0, 16);

const git = async (repoPath, args, options = {}) => {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], {
    encoding: options.encoding || 'utf8',
    maxBuffer: 1024 * 1024 * 64,
  });
  return stdout;
};

const gitBuffer = async (repoPath, args) => {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], {
    encoding: 'buffer',
    maxBuffer: 1024 * 1024 * 64,
  });
  return stdout;
};

const fileSort = (left, right) => {
  const leftParts = left.path.split('/');
  const rightParts = right.path.split('/');
  const length = Math.min(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (leftPart === rightPart) {
      continue;
    }

    const leftIsDirectory = index < leftParts.length - 1;
    const rightIsDirectory = index < rightParts.length - 1;
    if (leftIsDirectory !== rightIsDirectory) {
      return leftIsDirectory ? -1 : 1;
    }

    return leftPart.localeCompare(rightPart);
  }

  return leftParts.length - rightParts.length;
};

const parseStatus = (raw) => {
  const parts = raw.split('\0').filter(Boolean);
  const files = new Map();

  for (let index = 0; index < parts.length; index += 1) {
    const record = parts[index];
    const x = record[0];
    const y = record[1];
    let path = record.slice(3);
    let oldPath;

    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      oldPath = parts[++index];
    }

    const current = files.get(path) || {
      oldPath,
      path,
      staged: false,
      status: 'modified',
      unstaged: false,
      untracked: false,
    };

    if (x === '?' && y === '?') {
      current.status = 'untracked';
      current.unstaged = true;
      current.untracked = true;
    } else {
      current.staged = x !== ' ';
      current.unstaged = y !== ' ';

      const statusCode = current.staged ? x : y;
      current.status =
        statusCode === 'A'
          ? 'added'
          : statusCode === 'D'
            ? 'deleted'
            : statusCode === 'R' || statusCode === 'C'
              ? 'renamed'
              : 'modified';
    }

    files.set(path, current);
  }

  return [...files.values()].sort(fileSort);
};

const isBinaryBuffer = (buffer) => buffer.includes(0);

const bufferToTextFile = (name, buffer, cacheKey) => {
  if (isBinaryBuffer(buffer)) {
    return {
      binary: true,
      file: undefined,
    };
  }

  return {
    binary: false,
    file: {
      cacheKey,
      contents: buffer.toString('utf8'),
      name,
    },
  };
};

const readGitFile = async (repoRoot, ref, path) => {
  try {
    const buffer = await gitBuffer(repoRoot, ['show', `${ref}:${path}`]);
    return bufferToTextFile(path, buffer, `${ref}:${path}`);
  } catch {
    return {
      binary: false,
      file: {
        cacheKey: `${ref}:${path}:empty`,
        contents: '',
        name: path,
      },
    };
  }
};

const readIndexFile = async (repoRoot, path) => {
  try {
    const buffer = await gitBuffer(repoRoot, ['show', `:${path}`]);
    return bufferToTextFile(path, buffer, `index:${path}`);
  } catch {
    return {
      binary: false,
      file: {
        cacheKey: `index:${path}:empty`,
        contents: '',
        name: path,
      },
    };
  }
};

const readWorkingTreeFile = async (repoRoot, path) => {
  try {
    const buffer = await fs.readFile(join(repoRoot, path));
    return bufferToTextFile(path, buffer, `worktree:${path}:${buffer.length}`);
  } catch {
    return {
      binary: false,
      file: {
        cacheKey: `worktree:${path}:empty`,
        contents: '',
        name: path,
      },
    };
  }
};

const createUntrackedPatch = async (repoRoot, path) => {
  const absolutePath = join(repoRoot, path);
  const buffer = await fs.readFile(absolutePath);

  if (isBinaryBuffer(buffer)) {
    return {
      binary: true,
      patch: '',
    };
  }

  const contents = buffer.toString('utf8');
  const trimmed = contents.endsWith('\n') ? contents.slice(0, -1) : contents;
  const lines = trimmed.length > 0 ? trimmed.split('\n') : [];
  const body = lines.map((line) => `+${line}`).join('\n');
  const noNewline = contents.endsWith('\n') ? '' : '\n\\ No newline at end of file';

  return {
    binary: false,
    patch: [
      `diff --git a/${path} b/${path}`,
      'new file mode 100644',
      'index 0000000..0000000',
      '--- /dev/null',
      `+++ b/${path}`,
      `@@ -0,0 +1,${lines.length} @@`,
      body,
    ]
      .filter(Boolean)
      .join('\n')
      .concat(noNewline, '\n'),
  };
};

const getPatch = async (repoRoot, path, kind, untracked) => {
  if (untracked) {
    return createUntrackedPatch(repoRoot, path);
  }

  const args =
    kind === 'staged'
      ? ['diff', '--cached', '--patch', '--no-ext-diff', '--', path]
      : ['diff', '--patch', '--no-ext-diff', '--', path];
  const patch = await git(repoRoot, args);

  return {
    binary: /Binary files .* differ/.test(patch),
    patch,
  };
};

const getWorkingTreeContents = async (repoRoot, item, kind) => {
  if (kind === 'staged') {
    const oldFile = await readGitFile(repoRoot, 'HEAD', item.oldPath || item.path);
    const newFile = await readIndexFile(repoRoot, item.path);

    return {
      binary: oldFile.binary || newFile.binary,
      newFile: newFile.file,
      oldFile: oldFile.file,
    };
  }

  if (item.untracked) {
    const newFile = await readWorkingTreeFile(repoRoot, item.path);
    return {
      binary: newFile.binary,
      newFile: newFile.file,
      oldFile: {
        cacheKey: `empty:${item.path}`,
        contents: '',
        name: item.path,
      },
    };
  }

  const oldFile = await readIndexFile(repoRoot, item.oldPath || item.path);
  const newFile = await readWorkingTreeFile(repoRoot, item.path);

  return {
    binary: oldFile.binary || newFile.binary,
    newFile: newFile.file,
    oldFile: oldFile.file,
  };
};

const normalizeStatus = (statusCode) =>
  statusCode === 'A'
    ? 'added'
    : statusCode === 'D'
      ? 'deleted'
      : statusCode === 'R' || statusCode === 'C'
        ? 'renamed'
        : 'modified';

const parseCommitNameStatus = (raw) => {
  const parts = raw.split('\0').filter(Boolean);
  const files = [];

  for (let index = 0; index < parts.length; ) {
    const statusCode = parts[index++];
    const statusType = statusCode[0];

    if (statusType === 'R' || statusType === 'C') {
      const oldPath = parts[index++];
      const path = parts[index++];
      files.push({
        oldPath,
        path,
        status: 'renamed',
      });
    } else {
      const path = parts[index++];
      files.push({
        path,
        status: normalizeStatus(statusType),
      });
    }
  }

  return files.sort(fileSort);
};

const readWorkingTreeState = async (launchPath) => {
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const status = parseStatus(await git(repoRoot, ['status', '--porcelain=v1', '-z', '-uall']));
  const files = [];

  for (const item of status) {
    const sections = [];

    if (item.staged) {
      const staged = await getPatch(repoRoot, item.path, 'staged', false);
      const contents = await getWorkingTreeContents(repoRoot, item, 'staged');
      sections.push({
        binary: staged.binary || contents.binary,
        id: `${item.path}:staged`,
        kind: 'staged',
        newFile: contents.newFile,
        oldFile: contents.oldFile,
        patch: staged.patch,
      });
    }

    if (item.unstaged) {
      const unstaged = await getPatch(repoRoot, item.path, 'unstaged', item.untracked);
      const contents = await getWorkingTreeContents(repoRoot, item, 'unstaged');
      sections.push({
        binary: unstaged.binary || contents.binary,
        id: `${item.path}:unstaged`,
        kind: 'unstaged',
        newFile: contents.newFile,
        oldFile: contents.oldFile,
        patch: unstaged.patch,
      });
    }

    const fingerprint = getFingerprint(
      `${item.status}\n${item.oldPath || ''}\n${sections
        .map(
          (section) =>
            `${section.binary ? 'binary' : 'text'}\n${section.patch}\n${
              section.oldFile?.contents || ''
            }\n${section.newFile?.contents || ''}`,
        )
        .join('\n')}`,
    );

    files.push({
      fingerprint,
      oldPath: item.oldPath,
      path: item.path,
      sections,
      status: item.status,
    });
  }

  return {
    files,
    generatedAt: Date.now(),
    launchPath,
    root: repoRoot,
    source: {
      type: 'working-tree',
    },
  };
};

const readUntrackedFileSignatures = async (repoRoot) => {
  const raw = await git(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z']);
  const paths = raw.split('\0').filter(Boolean).sort();
  const signatures = [];

  for (const path of paths) {
    try {
      const stat = await fs.stat(join(repoRoot, path));
      signatures.push(`${path}\0${stat.size}\0${stat.mtimeMs}`);
    } catch {
      signatures.push(`${path}\0missing`);
    }
  }

  return signatures.join('\0');
};

const gitOrEmpty = async (repoRoot, args) => {
  try {
    return await git(repoRoot, args);
  } catch {
    return '';
  }
};

const readRepositoryChangeSignature = async (launchPath) => {
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const [head, status, stagedDiff, unstagedDiff, untracked] = await Promise.all([
    gitOrEmpty(repoRoot, ['rev-parse', '--verify', 'HEAD']),
    git(repoRoot, ['status', '--branch', '--porcelain=v1', '-z', '-uall']),
    gitOrEmpty(repoRoot, ['diff', '--cached', '--binary', '--no-ext-diff']),
    gitOrEmpty(repoRoot, ['diff', '--binary', '--no-ext-diff']),
    readUntrackedFileSignatures(repoRoot),
  ]);

  return {
    root: repoRoot,
    signature: getFingerprint([head, status, stagedDiff, unstagedDiff, untracked].join('\0')),
  };
};

const readCommitState = async (launchPath, ref) => {
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const commit = (await git(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
  const status = parseCommitNameStatus(
    await git(repoRoot, [
      'diff-tree',
      '--no-commit-id',
      '--name-status',
      '-r',
      '-z',
      '--root',
      '-M',
      commit,
    ]),
  );
  const files = [];

  for (const item of status) {
    const patch = await git(repoRoot, [
      'show',
      '--format=',
      '--patch',
      '--no-ext-diff',
      '--find-renames',
      commit,
      '--',
      item.path,
    ]);
    const oldFile = await readGitFile(repoRoot, `${commit}^`, item.oldPath || item.path);
    const newFile = await readGitFile(repoRoot, commit, item.path);

    files.push({
      fingerprint: getFingerprint(
        `${commit}\n${item.oldPath || ''}\n${patch}\n${oldFile.file?.contents || ''}\n${
          newFile.file?.contents || ''
        }`,
      ),
      oldPath: item.oldPath,
      path: item.path,
      sections: [
        {
          binary: /Binary files .* differ/.test(patch) || oldFile.binary || newFile.binary,
          id: `${item.path}:${commit}`,
          kind: 'commit',
          newFile: newFile.file,
          oldFile: oldFile.file,
          patch,
        },
      ],
      status: item.status,
    });
  }

  return {
    files,
    generatedAt: Date.now(),
    launchPath,
    root: repoRoot,
    source: {
      ref: commit,
      type: 'commit',
    },
  };
};

const readRepositoryState = async (launchPath, source = { type: 'working-tree' }) =>
  source.type === 'commit'
    ? readCommitState(launchPath, source.ref)
    : readWorkingTreeState(launchPath);

const listRepositoryHistory = async (launchPath, limit = 200) => {
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const raw = await git(repoRoot, [
    'log',
    `--max-count=${limit}`,
    '--format=%H%x00%P%x00%ct%x00%s%x00',
  ]);
  const parts = raw.split('\0').filter(Boolean);
  const entries = [];

  for (let index = 0; index < parts.length; index += 4) {
    entries.push({
      committedAt: Number(parts[index + 2]) * 1000,
      parents: parts[index + 1] ? parts[index + 1].split(' ') : [],
      ref: parts[index],
      subject: parts[index + 3],
    });
  }

  return {
    entries,
    root: repoRoot,
  };
};

module.exports = {
  listRepositoryHistory,
  parseStatus,
  readRepositoryChangeSignature,
  readCommitState,
  readRepositoryState,
  readWorkingTreeState,
};
