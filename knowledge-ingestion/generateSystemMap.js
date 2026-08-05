import 'dotenv/config';
import { generateSystemMap } from './summarizer.js';
import { saveSystemMap } from '../shared/systemMap.js';
import { resolveAppLibDependencies } from './nxDependencyResolver.js';

/**
 * On-demand system-map generation, run manually (workflow_dispatch) rather than on every push -
 * unlike ingestOnPush.js, this is deliberately NOT wired into the per-repo push pipeline: it's
 * expensive (deep exploration across the whole repo, long timeout) and only needed rarely, when a
 * high-level initiative's requirement docs need real architectural grounding - see
 * knowledge-ingestion/summarizer.js's generateSystemMap for the full rationale.
 *
 * Required: REPO (org/name), REPO_DIR (existing checkout).
 * Optional: SCOPE (a single app + its libs within a monorepo, e.g. "livecount" - narrows
 * exploration and produces a separate, smaller map instead of the whole-repo one). When set, the
 * app's real lib dependency closure is resolved first (nxDependencyResolver.js) rather than
 * guessing paths by naming convention.
 */
function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

/**
 * Deterministic, code-generated appendix listing every resolved path - not dependent on the LLM
 * choosing to enumerate them all in its narrative (it tends to group/summarize, and the prompt
 * itself only shows a truncated slice past MAX_RESOLVED_PATHS - see summarizer.js). Guarantees the
 * map always has a complete, literal record of the app + its full lib dependency closure.
 */
function buildDependencyAppendix({ scope, appPath, libPaths }) {
  const lines = [
    `## Appendix: ${scope} Resolved Dependency Closure`,
    ``,
    `Full, code-resolved list (from real \`@hcworkspace/*\` imports, not name-guessing or LLM summarization) - ${libPaths.length} lib(s):`,
    ``,
    `- App: \`${appPath}\``,
    ...libPaths.map((p) => `- \`${p}\``),
  ];
  return lines.join('\n');
}

async function main() {
  const repo = requireEnv('REPO');
  const repoDir = requireEnv('REPO_DIR');
  const scope = process.env.SCOPE || undefined;

  let resolvedPaths;
  let appendix = '';
  if (scope) {
    const { appPath, libPaths } = resolveAppLibDependencies({ repoDir, appName: scope });
    if (appPath) {
      resolvedPaths = [appPath, ...libPaths];
      appendix = `\n\n---\n\n${buildDependencyAppendix({ scope, appPath, libPaths })}\n`;
      console.log(`[${repo} :: ${scope}] resolved ${libPaths.length} lib dependenc${libPaths.length === 1 ? 'y' : 'ies'} from real imports`);
    } else {
      console.log(`[${repo} :: ${scope}] couldn't resolve real dependencies (no matching project.json or not an @hcworkspace Nx workspace) - falling back to naming-convention guessing`);
    }
  }

  console.log(`[${repo}${scope ? ` :: ${scope}` : ''}] generating system map...`);
  const content = await generateSystemMap({ repo, cwd: repoDir, scope, resolvedPaths }) + appendix;
  saveSystemMap(repo, content, scope);
  console.log(`[${repo}${scope ? ` :: ${scope}` : ''}] wrote system map (${content.length} chars) to data/system-map/`);
}

main().catch((err) => {
  console.error('Fatal system-map generation error:', err);
  process.exit(1);
});
