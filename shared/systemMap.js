import fs from 'node:fs';
import path from 'node:path';

const SYSTEM_MAP_DIR = path.resolve('data/system-map');

/** Deterministic, filesystem-safe file name for a repo's system map, e.g. "owner/repo" -> "owner__repo.md",
 * or "owner/repo" + scope "livecount" -> "owner__repo__livecount.md" (see summarizer.js `generateSystemMap`). */
function systemMapPath(repo, scope) {
  const base = repo.replace('/', '__');
  return path.join(SYSTEM_MAP_DIR, `${scope ? `${base}__${scope}` : base}.md`);
}

/** Reads `repo`'s (optionally `scope`d) system map, or `null` if one hasn't been generated yet. */
export function loadSystemMap(repo, scope) {
  try {
    return fs.readFileSync(systemMapPath(repo, scope), 'utf-8');
  } catch {
    return null;
  }
}

/** Overwrites `repo`'s (optionally `scope`d) system map with `content` - always a full replace, never merged (see summarizer.js `generateSystemMap`). */
export function saveSystemMap(repo, content, scope) {
  fs.mkdirSync(SYSTEM_MAP_DIR, { recursive: true });
  fs.writeFileSync(systemMapPath(repo, scope), content, 'utf-8');
}
