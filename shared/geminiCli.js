import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Google Gemini CLI (`gemini`) must be installed and authenticated.
// Install: npm install -g @google/gemini-cli
// Auth: set GEMINI_API_KEY (see https://aistudio.google.com/apikey).
// This is the default provider for both knowledge-ingestion summarization (knowledge-ingestion/summarizer.js) and
// ticket-implementation coding agents (agent-logic/copilotAgent.js) - Copilot CLI remains
// available as a global opt-in for this repo, see shared/config.js `CODING_PROVIDER`.
export const GEMINI_MODEL = process.env.GEMINI_MODEL || 'pro';
// Summarization is a cheap, low-reasoning task, so default it to a fast/low-cost model.
export const GEMINI_SUMMARY_MODEL = process.env.GEMINI_SUMMARY_MODEL || 'flash';

/** `gemini --output-format json` wraps the model's final answer in `{ response, stats, error }`. */
function parseGeminiOutput(stdout) {
  const parsed = JSON.parse(stdout);
  if (parsed.error) throw new Error(`gemini CLI error: ${JSON.stringify(parsed.error)}`);
  return (parsed.response ?? '').trim();
}

/**
 * Runs `gemini` as a read-only exploration agent scoped to `cwd`: only read/list/search tools are
 * allowed (no writes, no shell), used by knowledge-ingestion to ground repo/project summaries in the
 * real checked-out codebase instead of a pre-fetched README/manifest snippet. Mirrors
 * shared/copilotCli.js's (now-removed) runCopilotAnalysis.
 */
export async function runGeminiAnalysis(prompt, { cwd, timeoutMs = 15 * 60 * 1000, model = GEMINI_MODEL } = {}) {
  const args = [
    '-p', prompt,
    '-m', model,
    '--approval-mode', 'default',
    '--allowed-tools', 'read_file,list_directory,glob,search_file_content',
    '--output-format', 'json',
  ];

  const { stdout } = await execFileAsync('gemini', args, {
    cwd,
    maxBuffer: 1024 * 1024 * 64,
    timeout: timeoutMs,
    env: process.env,
  });
  return parseGeminiOutput(stdout);
}

/**
 * Runs `gemini` as a coding agent scoped to `cwd`. It's granted read/write file access but never
 * shell access. `--approval-mode=yolo` auto-accepts file edits without an interactive confirmation
 * prompt, since cwd is a throwaway job-scoped checkout (or several candidate clones side by side).
 * Git/PR operations stay under our explicit control in agent-logic/git.js and
 * agent-logic/githubPr.js.
 */
export async function runGeminiAgent(prompt, { cwd, timeoutMs = 20 * 60 * 1000, model = GEMINI_MODEL } = {}) {
  const args = [
    '-p', prompt,
    '-m', model,
    '--approval-mode', 'yolo',
    '--allowed-tools', 'read_file,write_file,list_directory,glob,search_file_content,replace',
    '--output-format', 'json',
  ];

  const { stdout } = await execFileAsync('gemini', args, {
    cwd,
    maxBuffer: 1024 * 1024 * 64,
    timeout: timeoutMs,
    env: process.env,
  });
  return parseGeminiOutput(stdout);
}
