import { runGeminiAnalysis, GEMINI_SUMMARY_MODEL, GEMINI_MODEL } from '../shared/geminiCli.js';
import { loadPrompt } from '../shared/promptTemplate.js';

/**
 * The "auto-healing" step: has the agent actually explore the repo checked out at `cwd` (README,
 * manifests, and enough real source - controllers/handlers, domain models, configuration - to
 * understand what it does) and produce a factual, ground-truth JSON summary. This is grounded in
 * the real codebase rather than a handful of pre-fetched files, so it can pick up implementation
 * details a README never mentions.
 */
export async function summarizeApiService({ repo, cwd }) {
  const prompt = loadPrompt('summarize-api-service', { REPO: repo });

  const text = await runGeminiAnalysis(prompt, { cwd, model: GEMINI_SUMMARY_MODEL });
  const jsonMatch = text.match(/\{[\s\S]*\}/);

  try {
    return JSON.parse(jsonMatch ? jsonMatch[0] : text);
  } catch {
    return {
      purpose: text.slice(0, 500),
      techStack: [],
      keyModules: [],
      dependencies: [],
      notablePatterns: [],
    };
  }
}

/**
 * Same idea as summarizeApiService, scoped to a single project's subfolder inside a monorepo
 * clone. Monorepo projects previously only got structural metadata (tags/deps from project.json)
 * with no semantic description at all, which made them poor vector-search matches for
 * natural-language ticket descriptions - this fills that gap.
 */
export async function summarizeMonorepoProject({ repo, projectName, cwd }) {
  const prompt = loadPrompt('summarize-monorepo-project', { REPO: repo, PROJECT_NAME: projectName });

  const text = await runGeminiAnalysis(prompt, { cwd, model: GEMINI_SUMMARY_MODEL });
  const jsonMatch = text.match(/\{[\s\S]*\}/);

  try {
    return JSON.parse(jsonMatch ? jsonMatch[0] : text);
  } catch {
    return { purpose: text.slice(0, 500), keyModules: [], notablePatterns: [] };
  }
}

/**
 * Deliberately separate from summarizeApiService/summarizeMonorepoProject: this produces one
 * long-form Markdown architecture reference (layering rules, subsystem relationships,
 * cross-cutting patterns), not a compact per-ticket-routing summary. It's meant to be generated
 * rarely (on demand, not on every push) and consumed rarely (per high-level initiative, e.g. Epic
 * spec generation) - verbosity here is a feature, not a cost problem, since
 * data/repo-directory.json stays the cheap/frequent artifact for per-ticket candidate resolution.
 * Uses GEMINI_MODEL (not GEMINI_SUMMARY_MODEL) since this needs deeper reasoning across a much
 * wider slice of the codebase than a single project's summary does.
 *
 * `scope` (optional) narrows this to a single app + its libs within a monorepo (e.g. "livecount"
 * in mepworkspace) instead of the whole repo - useful when the whole-repo map is too broad for a
 * high-level initiative confined to one domain. `resolvedPaths` (optional, only meaningful with
 * `scope`) is the app's *real* transitive lib dependency closure from
 * knowledge-ingestion/nxDependencyResolver.js's resolveAppLibDependencies - passed through as an
 * explicit path list rather than letting the model guess by folder-name convention, since a lib an
 * app depends on can live under an entirely different domain folder (e.g. libs/shared/**). Falls
 * back to naming-convention guessing (no paths block) if resolution found nothing.
 */
/** Safety net against a still-large resolved dependency list blowing past the OS command-line length limit. */
const MAX_RESOLVED_PATHS = 80;

export async function generateSystemMap({ repo, cwd, scope, resolvedPaths }) {
  const truncated = resolvedPaths?.length > MAX_RESOLVED_PATHS;
  const paths = truncated ? resolvedPaths.slice(0, MAX_RESOLVED_PATHS) : resolvedPaths;
  const pathsBlock = paths?.length
    ? `\n\nThe real dependency closure (resolved from actual imports, not name-guessing) is:\n${paths
        .map((p) => `- ${p}`)
        .join('\n')}\n${truncated ? `\n(truncated to ${MAX_RESOLVED_PATHS} of ${resolvedPaths.length} resolved paths - use these plus your own judgment for the rest)\n` : ''}\nExplore exactly these paths - do not assume any other path belongs to ${scope} just because it shares its name.\n`
    : `\n\nNo pre-resolved dependency list was available - check the workspace layout yourself and use ` +
      `\`apps/${scope}/**\` and \`libs/${scope}/**\` as a starting guess, but verify via actual imports rather than assuming.\n`;
  const prompt = scope
    ? loadPrompt('system-map-scoped', { REPO: repo, SCOPE: scope, PATHS_BLOCK: pathsBlock })
    : loadPrompt('system-map', { REPO: repo });
  return runGeminiAnalysis(prompt, { cwd, model: GEMINI_MODEL, timeoutMs: 30 * 60 * 1000 });
}
