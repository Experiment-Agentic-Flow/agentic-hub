import { runCopilotPrompt } from '../shared/copilotCli.js';

/**
 * The "auto-healing" step: asks the GitHub Copilot CLI to produce a factual, ground-truth JSON
 * summary of an API service using only the evidence fetched from GitHub (no invention).
 */
export async function summarizeApiService({ repo, readme, manifest, fileTree }) {
  const prompt = `You are documenting an internal API service for a code-search knowledge base.
Produce a factual, ground-truth JSON summary ONLY from the evidence provided below. Do not invent details.
If information is missing, use an empty array or "unknown" rather than guessing.

Repository: ${repo}

README.md:
"""
${readme || '(missing)'}
"""

Manifest (.csproj / .sln):
"""
${manifest || '(missing)'}
"""

Repository file tree (excluding build output):
${fileTree?.length ? fileTree.join('\n') : '(missing)'}

Respond with ONLY valid JSON in this exact shape, no prose before or after:
{
  "purpose": string,
  "techStack": string[],
  "keyModules": string[],
  "dependencies": string[],
  "notablePatterns": string[]
}`;

  const text = await runCopilotPrompt(prompt);
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
