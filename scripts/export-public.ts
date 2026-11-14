// Exports the tracked files at HEAD into a new folder as a fresh repository with one commit (docs/plans/step-7.md).
//
//   node scripts/export-public.ts <target folder> --author "Name <email>" [--allow-dirty]
//
// It never pushes, adds no remote and writes nothing to this repository. Ignored files are never copied.
// --allow-dirty exports HEAD even when the working tree has changes. Use it only to test this script.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMIT_MESSAGE = 'Initial public release';
const USAGE = 'Usage: node scripts/export-public.ts <target folder> --author "Name <email>" [--allow-dirty]';

// These must never be in the export. Names match whole path segments, case-insensitively (as Windows does).
const EXCLUDED_SEGMENTS = ['.claude', '.vscode-test', 'node_modules', 'dist'];
const EXCLUDED_PREFIXES = ['docs/research'];
const EXCLUDED_SUFFIXES = ['.vsix'];

class ExportError extends Error {}

interface TreeEntry {
  mode: string;
  oid: string;
  path: string;
}

interface Options {
  target: string;
  name: string;
  email: string;
  allowDirty: boolean;
}

function fail(message: string): never {
  throw new ExportError(message);
}

function excludedReason(path: string): string | undefined {
  const lower = path.toLowerCase();
  for (const prefix of EXCLUDED_PREFIXES) {
    if (lower === prefix || lower.startsWith(`${prefix}/`)) return prefix;
  }
  const segments = lower.split('/');
  for (const name of EXCLUDED_SEGMENTS) {
    if (segments.includes(name)) return name;
  }
  for (const suffix of EXCLUDED_SUFFIXES) {
    if (lower.endsWith(suffix)) return `*${suffix}`;
  }
  return undefined;
}

/** True if child is parent or lies inside it. Windows paths compare case-insensitively here. */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** The environment for git, without any GIT_* variable from the caller, so no other repository can be reached by accident. */
function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith('GIT_')) env[key] = value;
  }
  return { ...env, ...extra };
}

function git(cwd: string, args: string[], options: { input?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const result = spawnSync('git', args, {
    cwd,
    input: options.input,
    env: options.env ?? gitEnv(),
    encoding: 'utf8',
    maxBuffer: 1 << 30,
  });
  if (result.error) fail(`could not run git: ${result.error.message}`);
  if (result.status !== 0) fail(`git ${args.join(' ')} failed:\n${result.stderr.trim()}`);
  return result.stdout;
}

function gitBlob(cwd: string, oid: string): Buffer {
  const result = spawnSync('git', ['cat-file', 'blob', oid], { cwd, env: gitEnv(), maxBuffer: 1 << 30 });
  if (result.error) fail(`could not run git: ${result.error.message}`);
  if (result.status !== 0) fail(`git cat-file failed for ${oid}`);
  return result.stdout;
}

function parseArgs(argv: string[]): Options {
  let target: string | undefined;
  let author: string | undefined;
  let allowDirty = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--allow-dirty') allowDirty = true;
    else if (arg === '--author') {
      author = argv[++i];
      if (author === undefined) fail(`--author needs a value. ${USAGE}`);
    } else if (arg.startsWith('--author=')) author = arg.slice('--author='.length);
    else if (arg.startsWith('-')) fail(`unknown option ${arg}. ${USAGE}`);
    else if (target === undefined) target = arg;
    else fail(`give one target folder only. ${USAGE}`);
  }
  if (target === undefined) fail(USAGE);
  if (author === undefined) {
    fail(`--author "Name <email>" is required, so that no personal address is used by default. ${USAGE}`);
  }
  const match = /^([^<>\r\n]*\S)\s*<([^<>\s@]+@[^<>\s@]+)>$/.exec(author);
  if (!match) fail('--author must look like "Name <email>".');
  return { target: resolve(target), name: match[1], email: match[2], allowDirty };
}

/** The regular files at HEAD. Symbolic links and submodules are refused, because this export can't copy them faithfully. */
function listTree(repo: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const record of git(repo, ['ls-tree', '-r', '-z', '--full-tree', 'HEAD']).split('\0')) {
    if (record === '') continue;
    const tab = record.indexOf('\t');
    const [mode, type, oid] = record.slice(0, tab).split(' ');
    const path = record.slice(tab + 1);
    if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) {
      fail(`"${path}" is not a regular file (mode ${mode}, type ${type}). Symbolic links and submodules can't be exported.`);
    }
    if (path.includes('\n')) fail('a tracked path contains a line break, which this export does not support.');
    entries.push({ mode, oid, path });
  }
  return entries;
}

/** Every file and folder under root, as paths with forward slashes. */
function walk(root: string, rel = ''): { path: string; isDir: boolean }[] {
  const found: { path: string; isDir: boolean }[] = [];
  for (const dirent of readdirSync(join(root, rel), { withFileTypes: true })) {
    const path = rel === '' ? dirent.name : `${rel}/${dirent.name}`;
    found.push({ path, isDir: dirent.isDirectory() });
    if (dirent.isDirectory()) found.push(...walk(root, path));
  }
  return found;
}

function verifyFolder(target: string, entries: TreeEntry[]): void {
  const found = walk(target);
  for (const item of found) {
    const reason = excludedReason(item.path);
    if (reason) fail(`the export contains "${item.path}", which matches the excluded "${reason}". Nothing was committed.`);
  }
  const expected = new Set(entries.map((entry) => entry.path));
  const actual = new Set(found.filter((item) => !item.isDir).map((item) => item.path));
  const extra = [...actual].filter((path) => !expected.has(path));
  const missing = [...expected].filter((path) => !actual.has(path));
  if (extra.length > 0 || missing.length > 0) {
    fail(`the exported files differ from the tracked files at HEAD (${extra.length} extra, ${missing.length} missing).`);
  }
}

function cleanup(target: string, createdTarget: boolean): void {
  if (createdTarget) {
    rmSync(target, { recursive: true, force: true });
    return;
  }
  // The folder was empty before, so everything in it now was written by this run.
  for (const name of readdirSync(target)) rmSync(join(target, name), { recursive: true, force: true });
}

function main(): void {
  let target = '';
  let written = false;
  let createdTarget = false;
  try {
    const options = parseArgs(process.argv.slice(2));
    target = options.target;
    const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const repo = resolve(git(scriptRoot, ['rev-parse', '--show-toplevel']).trim());
    const head = git(repo, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).trim();
    if (head === '') fail('this repository has no commit to export.');
    const sourceTree = git(repo, ['rev-parse', 'HEAD^{tree}']).trim();

    // Untracked files that aren't ignored count as uncommitted too. Ignored files don't.
    const status = git(repo, ['status', '--porcelain', '--untracked-files=all']).trim();
    if (status !== '' && !options.allowDirty) {
      fail(
        `the working tree has uncommitted changes (${status.split('\n').length} entries). Commit or remove them first.`,
      );
    }
    if (status !== '') console.warn('export-public: warning: --allow-dirty is set, so only HEAD is exported.');

    if (isInside(repo, target)) fail('the target folder is inside this repository. Choose a folder outside it.');
    if (isInside(target, repo)) fail('the target folder contains this repository. Choose another folder.');
    createdTarget = !existsSync(target);
    if (!createdTarget) {
      if (!statSync(target).isDirectory()) fail('the target exists and is not a folder.');
      if (readdirSync(target).length > 0) fail('the target folder exists and is not empty.');
    }

    // Refuse to reuse an address that already appears in this repository's history or git settings.
    const known = new Set(
      git(repo, ['log', '--all', '--format=%ae%n%ce']).split('\n').map((line) => line.trim().toLowerCase()),
    );
    const configured = spawnSync('git', ['config', '--get', 'user.email'], { cwd: repo, env: gitEnv(), encoding: 'utf8' });
    if (configured.status === 0) known.add(configured.stdout.trim().toLowerCase());
    if (known.has(options.email.toLowerCase())) {
      fail('that author address already appears in this repository. Use another address, such as a no-reply address.');
    }

    const entries = listTree(repo);
    for (const entry of entries) {
      const reason = excludedReason(entry.path);
      if (reason) fail(`tracked file "${entry.path}" matches the excluded "${reason}". Remove it from the repository first.`);
    }

    // Export. Each blob is written from HEAD, so the export holds exactly the tracked files.
    mkdirSync(target, { recursive: true });
    written = true;
    for (const entry of entries) {
      const full = join(target, ...entry.path.split('/'));
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, gitBlob(repo, entry.oid), { mode: entry.mode === '100755' ? 0o755 : 0o644 });
    }
    verifyFolder(target, entries);

    // A fresh repository with the same tree, and no history, remotes or hooks.
    git(target, ['init', '--quiet', '-b', 'main']);
    git(target, ['config', 'user.name', options.name]);
    git(target, ['config', 'user.email', options.email]);
    git(target, ['config', 'core.autocrlf', 'false']);

    // Blobs are hashed without filters, so each one must have the same id as at HEAD.
    const hashed = git(target, ['hash-object', '-w', '--no-filters', '--stdin-paths'], {
      input: `${entries.map((entry) => entry.path).join('\n')}\n`,
    })
      .trim()
      .split('\n');
    entries.forEach((entry, index) => {
      if (hashed[index] !== entry.oid) fail(`"${entry.path}" differs from HEAD.`);
    });
    git(target, ['update-index', '--index-info'], {
      input: entries.map((entry) => `${entry.mode} ${entry.oid}\t${entry.path}\n`).join(''),
    });
    if (git(target, ['write-tree']).trim() !== sourceTree) fail('the exported tree does not match HEAD.');

    // No hooks run for this commit, and no GPG signing.
    const hooks = join(target, '.git', 'no-hooks');
    mkdirSync(hooks, { recursive: true });
    const identity = {
      GIT_AUTHOR_NAME: options.name,
      GIT_AUTHOR_EMAIL: options.email,
      GIT_COMMITTER_NAME: options.name,
      GIT_COMMITTER_EMAIL: options.email,
    };
    git(
      target,
      ['-c', `core.hooksPath=${hooks}`, '-c', 'commit.gpgSign=false', 'commit', '--quiet', '--no-verify', '-m', COMMIT_MESSAGE],
      { env: gitEnv(identity) },
    );

    // Check what was made.
    if (git(target, ['rev-list', '--count', 'HEAD']).trim() !== '1') fail('the new repository does not have exactly one commit.');
    const [authorName, authorEmail, committerName, committerEmail, subject] = git(target, [
      'log',
      '-1',
      '--format=%an%n%ae%n%cn%n%ce%n%s',
    ])
      .replace(/\r?\n$/, '')
      .split('\n');
    const mismatched = [
      ['author name', authorName !== options.name],
      ['author email', authorEmail !== options.email],
      ['committer name', committerName !== options.name],
      ['committer email', committerEmail !== options.email],
      ['message', subject !== COMMIT_MESSAGE],
    ]
      .filter(([, differs]) => differs)
      .map(([field]) => field);
    if (mismatched.length > 0) fail(`the commit has an unexpected ${mismatched.join(', ')}.`);
    if (git(target, ['rev-parse', 'HEAD^{tree}']).trim() !== sourceTree) fail('the commit tree does not match HEAD.');
    if (git(target, ['status', '--porcelain']).trim() !== '') fail('the new repository is not clean after the commit.');
    if (git(target, ['remote']).trim() !== '') fail('the new repository has a remote, which must not happen.');

    console.log(`Exported ${entries.length} tracked files from HEAD ${head.slice(0, 7)} to ${target}`);
    console.log(`Excluded paths are absent: ${EXCLUDED_PREFIXES.concat(EXCLUDED_SEGMENTS, EXCLUDED_SUFFIXES.map((s) => `*${s}`)).join(', ')}`);
    console.log(`One commit "${COMMIT_MESSAGE}" by ${options.name} <${options.email}>, on branch main, with no remote.`);
    console.log('Nothing was pushed. Review the folder, then add a remote and push it yourself.');
  } catch (error) {
    if (written) cleanup(target, createdTarget);
    if (error instanceof ExportError) {
      console.error(`export-public: ${error.message}`);
    } else {
      console.error('export-public: unexpected error');
      console.error(error);
    }
    process.exitCode = 1;
  }
}

main();
