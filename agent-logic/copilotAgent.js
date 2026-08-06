import { runCopilotAgent } from '../shared/copilotCli.js';
import { runGeminiAgent } from '../shared/geminiCli.js';
import { loadPrompt } from '../shared/promptTemplate.js';
import { CODING_PROVIDER } from '../shared/config.js';

/**
 * Delegates the coding task to a CLI coding agent, scoped to rootDir. The provider is a single
 * global switch for this repo - shared/config.js CODING_PROVIDER (env var CODING_PROVIDER) -
 * Gemini CLI by default, or the GitHub Copilot CLI (gpt-5.6-luna) when set to 'copilot'. Both
 * CLIs have their own sandboxed file read/write tools, so there's no need to implement a custom
 * tool-use loop - we just give them the instructions and ask for a small JSON summary we can parse
 * for the commit message / PR body. `extraResponseFields` lets callers require additional keys in
 * that final JSON if a future caller needs the agent to report something beyond those two.
 */
export async function runAgentLoop({ rootDir, systemPrompt, task, extraResponseFields = {} }) {
  const responseShape = {
    commitMessage: '<concise, imperative commit message>',
    prSummary: '<short PR description of what changed and why>',
    ...extraResponseFields,
  };

  const prompt = loadPrompt('agent-response-wrapper', {
    SYSTEM_PROMPT: systemPrompt,
    TASK: task,
    RESPONSE_SHAPE: JSON.stringify(responseShape),
  });

  const text = CODING_PROVIDER === 'copilot'
    ? await runCopilotAgent(prompt, { cwd: rootDir })
    : await runGeminiAgent(prompt, { cwd: rootDir });
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
