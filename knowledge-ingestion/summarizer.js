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
 * high-level initiative confined to one domain. See prompts/system-map-scoped.md.
 */
export async function generateSystemMap({ repo, cwd, scope }) {
  const prompt = scope
    ? loadPrompt('system-map-scoped', { REPO: repo, SCOPE: scope })
    : loadPrompt('system-map', { REPO: repo });
  return runGeminiAnalysis(prompt, { cwd, model: GEMINI_MODEL, timeoutMs: 30 * 60 * 1000 });
}
