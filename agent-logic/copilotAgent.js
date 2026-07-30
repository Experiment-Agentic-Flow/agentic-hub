import { runCopilotAgent } from '../shared/copilotCli.js';

/**
 * Delegates the coding task to the GitHub Copilot CLI, scoped to rootDir. Copilot CLI has its
 * own sandboxed file read/write tools, so there's no need to implement a custom tool-use loop -
 * we just give it the instructions and ask it to end with a small JSON summary we can parse
 * for the commit message / PR body. `extraResponseFields` lets callers require additional keys
 * in that final JSON if a future caller needs the agent to report something beyond those two.
 */
export async function runAgentLoop({ rootDir, systemPrompt, task, extraResponseFields = {} }) {
  const responseShape = {
    commitMessage: '<concise, imperative commit message>',
    prSummary: '<short PR description of what changed and why>',
    ...extraResponseFields,
  };

  const prompt = `${systemPrompt}

${task}

Make all necessary file changes directly in the current working directory using your file tools.
When you are completely done, respond with ONLY a single JSON object (no other text, no markdown fences) in this exact shape:
${JSON.stringify(responseShape)}`;

  const text = await runCopilotAgent(prompt, { cwd: rootDir });
  const jsonMatch = text.match(/\{[\s\S]*\}/);

  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.commitMessage && parsed.prSummary) return parsed;
    } catch {
      // fall through to default below
    }
  }

  return {
    commitMessage: 'Automated change by agent-hub',
    prSummary: text.slice(0, 1000) || 'See linked ticket for details.',
  };
}
