import fs from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';

const ALIAS_PREFIX = '@hcworkspace/';

/** Parses tsconfig.base.json's compilerOptions.paths into { alias -> libRootDir }, or {} if the repo isn't this kind of Nx workspace. */
function readPathAliases(repoDir) {
  try {
    const tsconfig = JSON.parse(fs.readFileSync(path.join(repoDir, 'tsconfig.base.json'), 'utf-8'));
    const paths = tsconfig.compilerOptions?.paths || {};
    const aliasToLibRoot = {};
    for (const [alias, targets] of Object.entries(paths)) {
      const target = Array.isArray(targets) ? targets[0] : targets;
      if (!target) continue;
      // e.g. "libs/shared/platform/projects/data-access/src/index.ts" -> "libs/shared/platform/projects/data-access"
      aliasToLibRoot[alias] = target.replace(/\/src\/index\.ts$/, '').replace(/\.ts$/, '');
    }
    return aliasToLibRoot;
  } catch {
    return {};
  }
}

/** Every `@hcworkspace/*` import specifier referenced anywhere under `dir` (excluding spec files). */
function findImportedAliases(dir) {
  const files = fg.sync('**/*.{ts,tsx}', { cwd: dir, ignore: ['**/node_modules/**', '**/*.spec.ts'] });
  const found = new Set();
  const importRegex = new RegExp(`from\\s+['"](${ALIAS_PREFIX}[^'"]+)['"]`, 'g');
  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(path.join(dir, file), 'utf-8');
    } catch {
      continue;
    }
    let match;
    while ((match = importRegex.exec(content))) {
      found.add(match[1]);
    }
  }
  return found;
}

/**
 * Resolves the real set of libs an app depends on by statically scanning its own source for
 * `@hcworkspace/*` import specifiers, mapping them back to lib folders via tsconfig.base.json's
 * path aliases - the same underlying signal Nx's own project graph is ultimately derived from for
 * library edges. Deliberately doesn't shell out to `nx graph`/`nx show project`, for the same
 * CI-fragility reasons documented on monorepoIngestor.js's readProjectsFromProjectJson (no
 * install, no peer-dep conflicts).
 *
 * Returns `{ appPath, libPaths }`. `libPaths` is a *bounded* transitive closure: recursion only
 * continues into libs under the app's own domain (`libs/{appName}/**`) - cross-domain/shared libs
 * (e.g. libs/shared/**) are included as direct dependencies but treated as leaves, since
 * recursing into a widely-shared lib's own imports would otherwise pull in most of the monorepo.
 * Returns `{ appPath: null, libPaths: [] }` if `appName` isn't found or the repo has no
 * tsconfig.base.json (not this kind of Nx workspace) - callers should fall back to
 * naming-convention guessing in that case.
 */
export function resolveAppLibDependencies({ repoDir, appName }) {
  const aliasToLibRoot = readPathAliases(repoDir);
  if (Object.keys(aliasToLibRoot).length === 0) return { appPath: null, libPaths: [] };

  const projectFiles = fg.sync('**/project.json', { cwd: repoDir, ignore: ['**/node_modules/**'] });
  let appRoot = null;
  for (const file of projectFiles) {
    try {
      const project = JSON.parse(fs.readFileSync(path.join(repoDir, file), 'utf-8'));
      if (project.name === appName) {
        appRoot = path.dirname(file);
        break;
      }
    } catch {
      // skip unreadable project.json
    }
  }
  if (!appRoot) return { appPath: null, libPaths: [] };

  // Recursing into every discovered lib's own imports (true full transitive closure) explodes
  // once a widely-shared lib (e.g. libs/shared/utilities) is reached - it pulls in most of the
  // monorepo. Only recurse further into libs that belong to appName's own domain
  // (`libs/{appName}/**`); cross-domain libs (e.g. libs/shared/**) are recorded as direct
  // dependencies but treated as leaves, matching the prompt's "skim, don't deep-dive" intent.
  const ownDomainPrefix = `libs/${appName}/`;
  const visitedLibRoots = new Set();
  const visitedDirs = new Set();
  const queue = [appRoot];

  while (queue.length > 0) {
    const dir = queue.shift();
    if (visitedDirs.has(dir)) continue;
    visitedDirs.add(dir);

    for (const alias of findImportedAliases(path.join(repoDir, dir))) {
      const libRoot = aliasToLibRoot[alias];
      if (!libRoot || visitedLibRoots.has(libRoot)) continue;
      visitedLibRoots.add(libRoot);
      if (libRoot.replace(/\\/g, '/').startsWith(ownDomainPrefix)) queue.push(libRoot);
    }
  }

  return { appPath: appRoot, libPaths: [...visitedLibRoots] };
}
