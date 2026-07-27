import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// GitHub Copilot CLI (`copilot`) must be installed and authenticated.
// Auth precedence: COPILOT_GITHUB_TOKEN > GH_TOKEN > GITHUB_TOKEN, using a token with the
// "Copilot Requests" permission. See https://github.com/github/copilot-cli
// Bugfix/tech-debt implementation agents default to Claude Sonnet 5; override via COPILOT_MODEL.
export const COPILOT_MODEL = process.env.COPILOT_MODEL || 'claude-sonnet-5';
// Summarization is a cheap, low-reasoning task, so default it to a fast/low-cost model.
export const COPILOT_SUMMARY_MODEL = process.env.COPILOT_SUMMARY_MODEL || 'claude-haiku-4.5';

/**
 * Runs `copilot` non-interactively as a pure text generator: shell and file-write tools are
 * denied, since all context is passed directly in the prompt. Use for summarization/classification.
 */
export async function runCopilotPrompt(prompt, { timeoutMs = 5 * 60 * 1000, model = COPILOT_SUMMARY_MODEL } = {}) {
  const args = ['-p', prompt, '-s', '--no-ask-user', '--deny-tool=shell', '--deny-tool=write'];
  if (model) args.push('--model', model);

  const { stdout } = await execFileAsync('copilot', args, {
    maxBuffer: 1024 * 1024 * 32,
    timeout: timeoutMs,
    env: process.env,
  });
  return stdout.trim();
}

/**
 * Runs `copilot` as a coding agent scoped to `cwd`. It's granted read/write file access
 * (its own sandboxed tools) but never shell access, so it can't run arbitrary commands or exfiltrate
 * data via the network. Git/PR operations stay under our explicit control in agent-logic/git.js
 * and agent-logic/githubPr.js.
 */
export async function runCopilotAgent(prompt, { cwd, timeoutMs = 20 * 60 * 1000 } = {}) {
  const args = [
    '-p',
    prompt,
    '-s',
    '--no-ask-user',
    '--allow-all-paths', // cwd is a throwaway job-scoped checkout (or several candidate clones side by side) - path scoping adds no value here
    '--allow-tool=write',
    '--allow-tool=read',
    '--deny-tool=shell',
  ];
  if (COPILOT_MODEL) args.push('--model', COPILOT_MODEL);

  const { stdout } = await execFileAsync('copilot', args, {
    cwd,
    maxBuffer: 1024 * 1024 * 64,
    timeout: timeoutMs,
    env: process.env,
  });
  return stdout.trim();
}
