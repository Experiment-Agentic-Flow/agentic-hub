import { runCopilotAnalysis, COPILOT_SUMMARY_MODEL } from '../shared/copilotCli.js';

/**
 * The "auto-healing" step: has the agent actually explore the repo checked out at `cwd` (README,
 * manifests, and enough real source - controllers/handlers, domain models, configuration - to
 * understand what it does) and produce a factual, ground-truth JSON summary. This is grounded in
 * the real codebase rather than a handful of pre-fetched files, so it can pick up implementation
 * details a README never mentions.
 */
export async function summarizeApiService({ repo, cwd }) {
  const prompt = `You are documenting an internal API service for a code-search knowledge base.
Produce a factual, ground-truth JSON summary. Do not invent details - if something genuinely can't
be determined from the code, use an empty array or "unknown" rather than guessing.

Repository: ${repo}

Explore the checked-out repository in your current working directory using your read tool. Start
with README.md and the project manifest (.csproj/.sln/package.json/etc.), then open enough of the
actual source (controllers/handlers, core domain models, configuration) to understand what this
service really does, not just what its README claims.

Respond with ONLY valid JSON in this exact shape, no prose before or after:
{
  "purpose": string,
  "techStack": string[],
  "keyModules": string[],
  "dependencies": string[],
  "notablePatterns": string[]
}`;

  const text = await runCopilotAnalysis(prompt, { cwd, model: COPILOT_SUMMARY_MODEL });
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
  const prompt = `You are documenting one project inside a monorepo for a code-search knowledge base.
Produce a factual, ground-truth JSON summary. Do not invent details - if something genuinely can't
be determined from the code, use an empty array or "unknown" rather than guessing.

Repository: ${repo}
Project: ${projectName}

Explore the checked-out project in your current working directory using your read tool (source
files, any local README, configuration) to understand what this specific project actually does.
Identify the concrete, named building blocks a developer would search for - exported
components/classes/services/modules (e.g. "TakeoffManagerGrid", "OrderService") - not just a
general description.

Respond with ONLY valid JSON in this exact shape, no prose before or after:
{
  "purpose": string,
  "keyModules": string[],
  "notablePatterns": string[]
}`;

  const text = await runCopilotAnalysis(prompt, { cwd, model: COPILOT_SUMMARY_MODEL });
  const jsonMatch = text.match(/\{[\s\S]*\}/);

  try {
    return JSON.parse(jsonMatch ? jsonMatch[0] : text);
  } catch {
    return { purpose: text.slice(0, 500), keyModules: [], notablePatterns: [] };
  }
}
