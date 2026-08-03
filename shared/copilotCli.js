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

// Each agent-logic script (bugfix-agent.js, tech-debt-agent.js, ...) runs as its own process per
// ticket, so this module-level log naturally scopes to "every Copilot CLI call made for this
// ticket run" without threading a tracking object through every function call. There's no exact
// token/dollar cost available from the CLI itself - GitHub tracks premium-request billing
// centrally, not per stdout call - so call count + model + duration is the best proxy we can
// report ourselves for how much AI usage a ticket actually consumed.
const callLog = [];

function recordCall(kind, model, durationMs) {
  callLog.push({ kind, model, durationMs });
}

/** Every Copilot CLI call made so far in this process, summarized by kind/model - see `formatUsageSummary`. */
export function getUsageSummary() {
  const byModel = {};
  for (const call of callLog) {
    const key = call.model || 'unknown';
    byModel[key] = (byModel[key] || 0) + 1;
  }
  return {
    totalCalls: callLog.length,
    byModel,
    totalDurationMs: callLog.reduce((sum, call) => sum + call.durationMs, 0),
  };
}

/** Renders `getUsageSummary()` as a single human-readable line for logs/Jira comments. */
export function formatUsageSummary() {
  const { totalCalls, byModel, totalDurationMs } = getUsageSummary();
  if (totalCalls === 0) return 'AI usage: no Copilot CLI calls made.';

  const byModelText = Object.entries(byModel)
    .map(([model, count]) => `${model}: ${count}`)
    .join(', ');
  const totalSeconds = Math.round(totalDurationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const durationText = minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`;

  return `AI usage: ${totalCalls} Copilot CLI call(s) - ${byModelText} (total ${durationText})`;
}

/**
 * Runs `copilot` non-interactively as a pure text generator: shell and file-write tools are
 * denied, since all context is passed directly in the prompt. Use for summarization/classification.
 */
export async function runCopilotPrompt(prompt, { timeoutMs = 5 * 60 * 1000, model = COPILOT_SUMMARY_MODEL } = {}) {
  const args = ['-p', prompt, '-s', '--no-ask-user', '--deny-tool=shell', '--deny-tool=write'];
  if (model) args.push('--model', model);

  const startedAt = Date.now();
  try {
    const { stdout } = await execFileAsync('copilot', args, {
      maxBuffer: 1024 * 1024 * 32,
      timeout: timeoutMs,
      env: process.env,
    });
    return stdout.trim();
  } finally {
    recordCall('prompt', model, Date.now() - startedAt);
  }
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

  const startedAt = Date.now();
  try {
    const { stdout } = await execFileAsync('copilot', args, {
      cwd,
      maxBuffer: 1024 * 1024 * 64,
      timeout: timeoutMs,
      env: process.env,
    });
    return stdout.trim();
  } finally {
    recordCall('agent', COPILOT_MODEL, Date.now() - startedAt);
  }
}

/**
 * Runs `copilot` as a read-only exploration agent scoped to `cwd`: it's granted the read tool so
 * it can actually open real source files (routes/handlers, domain models, configs - whatever it
 * decides is relevant), but write and shell are both denied since this is analysis only, used by
 * rag-ingestion to ground repo/project summaries in the real codebase instead of a pre-fetched
 * README/manifest snippet. Defaults to COPILOT_MODEL; callers doing high-volume summarization
 * (e.g. rag-ingestion/summarizer.js) pass `model: COPILOT_SUMMARY_MODEL` explicitly instead.
 */
export async function runCopilotAnalysis(prompt, { cwd, timeoutMs = 15 * 60 * 1000, model = COPILOT_MODEL } = {}) {
  const args = [
    '-p',
    prompt,
    '-s',
    '--no-ask-user',
    '--allow-all-paths', // cwd is a throwaway ingestion checkout
    '--allow-tool=read',
    '--deny-tool=write',
    '--deny-tool=shell',
  ];
  if (model) args.push('--model', model);

  const startedAt = Date.now();
  try {
    const { stdout } = await execFileAsync('copilot', args, {
      cwd,
      maxBuffer: 1024 * 1024 * 64,
      timeout: timeoutMs,
      env: process.env,
    });
    return stdout.trim();
  } finally {
    recordCall('analysis', model, Date.now() - startedAt);
  }
}
