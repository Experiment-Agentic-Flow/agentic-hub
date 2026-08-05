import { execFileSync } from 'node:child_process';

/**
 * Diffs two revisions in a repo that's already checked out at `repoDir` (no cloning - the calling
 * workflow's own `actions/checkout` step already has the files on disk). Returns `null` if the
 * diff can't be computed at all (e.g. `fromSha` isn't reachable - shallow clone, force-push,
 * history rewrite) so the caller can fall back to a full re-ingestion instead of silently treating
 * "diff failed" the same as "nothing changed".
 */
export function diffBetween(repoDir, fromSha, toSha) {
  let out;
  try {
    out = execFileSync('git', ['diff', '--name-status', fromSha, toSha], { cwd: repoDir, encoding: 'utf-8' });
  } catch {
    return null;
  }

  const changedFiles = [];
  const deletedProjectJsonPaths = [];

  for (const line of out.split('\n').filter(Boolean)) {
    // Rename lines look like "R100\told\tnew" - both old and new paths matter for mapping
    // affected projects, so every path on the line is treated as "changed".
    const [status, ...paths] = line.split('\t');
    changedFiles.push(...paths);
    if (status.startsWith('D') && paths[0]?.endsWith('project.json')) {
      deletedProjectJsonPaths.push(paths[0]);
    }
  }

  return { changedFiles, deletedProjectJsonPaths };
}

export function currentHeadSha(repoDir) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf-8' }).trim();
}

/** Reads a file's content as of a specific revision, without checking that revision out. */
export function readFileAtRevision(repoDir, sha, filePath) {
  return execFileSync('git', ['show', `${sha}:${filePath}`], { cwd: repoDir, encoding: 'utf-8' });
}
