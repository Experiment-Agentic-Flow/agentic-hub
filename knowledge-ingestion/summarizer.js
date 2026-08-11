import { runGeminiAnalysis, GEMINI_SUMMARY_MODEL } from '../shared/geminiCli.js';
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
    return { purpose: text.slice(0, 500), keyModules: [], dependencies: [], notablePatterns: [] };
  }
}
