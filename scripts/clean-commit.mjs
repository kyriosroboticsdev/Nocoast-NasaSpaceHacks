/**
 * Create a commit without Cursor co-author trailers (uses commit-tree).
 * Usage: node scripts/clean-commit.mjs "commit message" [path ...]
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const git = process.platform === 'win32'
  ? 'C:\\Program Files\\Git\\mingw64\\bin\\git.exe'
  : 'git';
const msg = process.argv[2];
const paths = process.argv.slice(3);
if (!msg) {
  console.error('Usage: node scripts/clean-commit.mjs "message" [paths...]');
  process.exit(1);
}

function run(args, input) {
  const res = spawnSync(git, args, {
    encoding: 'utf8',
    input,
    env: process.env,
  });
  if (res.status !== 0) {
    console.error(res.stderr || res.stdout);
    process.exit(res.status ?? 1);
  }
  return (res.stdout || '').trim();
}

if (paths.length) run(['add', '--', ...paths]);
else run(['add', '-A']);

const status = run(['status', '--porcelain']);
if (!status) {
  console.log('Nothing to commit');
  process.exit(0);
}

const msgFile = join('.git', 'COMMIT_MSG_CLEAN.txt');
writeFileSync(msgFile, `${msg}\n`);
try {
  run(['write-tree']); // ensure index ready
  const tree = run(['write-tree']);
  const parent = run(['rev-parse', 'HEAD']);
  const authorName = run(['log', '-1', '--format=%an']);
  const authorEmail = run(['log', '-1', '--format=%ae']);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: authorName,
    GIT_AUTHOR_EMAIL: authorEmail,
    GIT_COMMITTER_NAME: authorName,
    GIT_COMMITTER_EMAIL: authorEmail,
  };
  const res = spawnSync(git, ['commit-tree', tree, '-p', parent, '-F', msgFile], {
    encoding: 'utf8',
    env,
  });
  if (res.status !== 0) {
    console.error(res.stderr || res.stdout);
    process.exit(res.status ?? 1);
  }
  const sha = res.stdout.trim();
  // Soft update HEAD without wiping the working tree.
  run(['update-ref', 'HEAD', sha]);
  run(['reset', '--mixed', 'HEAD']);
  const body = run(['log', '-1', '--format=%B']);
  if (/Co-authored-by:\s*Cursor/i.test(body)) {
    console.error('Commit unexpectedly contains Cursor co-author');
    process.exit(2);
  }
  console.log(run(['log', '-1', '--oneline']));
} finally {
  try { unlinkSync(msgFile); } catch { /* ignore */ }
}
