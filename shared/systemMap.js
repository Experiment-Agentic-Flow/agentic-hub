import fs from 'node:fs';
import path from 'node:path';

const SYSTEM_MAP_DIR = path.resolve('data/system-map');

/** Deterministic, filesystem-safe file name for a repo's system map, e.g. "owner/repo" -> "owner__repo.md". */
function systemMapPath(repo) {
  return path.join(SYSTEM_MAP_DIR, `${repo.replace('/', '__')}.md`);
}

/** Reads `repo`'s system map, or `null` if one hasn't been generated yet. */
export function loadSystemMap(repo) {
  try {
    return fs.readFileSync(systemMapPath(repo), 'utf-8');
  } catch {
    return null;
  }
}

/** Overwrites `repo`'s system map with `content` - always a full replace, never merged (see summarizer.js `generateSystemMap`). */
export function saveSystemMap(repo, content) {
  fs.mkdirSync(SYSTEM_MAP_DIR, { recursive: true });
  fs.writeFileSync(systemMapPath(repo), content, 'utf-8');
}
