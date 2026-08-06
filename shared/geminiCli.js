import crossSpawn from 'cross-spawn';

// Google Gemini CLI (`gemini`) must be installed and authenticated.
// Install: npm install -g @google/gemini-cli
// Auth: set GEMINI_API_KEY (see https://aistudio.google.com/apikey).
// This is the default provider for both knowledge-ingestion summarization (knowledge-ingestion/summarizer.js) and
// ticket-implementation coding agents (agent-logic/copilotAgent.js) - Copilot CLI remains
// available as a global opt-in for this repo, see shared/config.js `CODING_PROVIDER`.
export const GEMINI_MODEL = process.env.GEMINI_MODEL || 'pro';
// Summarization is a cheap, low-reasoning task, so default it to a fast/low-cost model.
export const GEMINI_SUMMARY_MODEL = process.env.GEMINI_SUMMARY_MODEL || 'flash';

/**
 * npm's Windows global-install shim for a CLI is `gemini.cmd`, which plain child_process
 * execFile/spawn can't invoke directly (spawn EINVAL/ENOENT), and `shell: true` unsafely
 * re-splits our multi-line prompt argument on cmd.exe's quoting rules. cross-spawn resolves and
 * invokes the shim correctly on Windows (used by npm/husky for exactly this problem) while
 * behaving like plain child_process.spawn elsewhere.
 *
 * `prompt` is piped via stdin rather than passed as a `-p`/positional CLI argument - a long
 * prompt (e.g. a system map's resolved-dependency list) can otherwise exceed the OS command-line
 * length limit ("the command line is too long" on Windows). Gemini CLI's headless mode triggers
 * on non-TTY input regardless, which spawned stdio always is here.
 */
function runGemini(args, { cwd, timeoutMs, prompt }) {
  return new Promise((resolve, reject) => {
    // Belt-and-suspenders alongside the --skip-trust arg: some CLI versions still hit the
    // trust-folder check before parsing flags, so the env var form is set too.
    const env = { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: 'true' };
    const child = crossSpawn('gemini', args, { cwd, env, timeout: timeoutMs });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`gemini exited with code ${code}: ${stderr || stdout}`));
      else resolve(stdout);
    });
    child.stdin.end(prompt);
  });
}

/**
 * `gemini --output-format json` is documented to wrap the final answer in `{ response, stats,
 * error }`, but in practice (v0.53.1) stdout is sometimes just the raw response text directly -
 * handle both rather than assuming the wrapper is always present.
 */
function parseGeminiOutput(stdout) {
  const trimmed = stdout.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && 'response' in parsed) {
      if (parsed.error) throw new Error(`gemini CLI error: ${JSON.stringify(parsed.error)}`);
      return (parsed.response ?? '').trim();
    }
  } catch {
    // not the documented JSON wrapper - fall through and treat stdout as the raw response
  }
  return trimmed;
}

/**
 * Runs `gemini` as a read-only exploration agent scoped to `cwd`: only read/list/search tools are
 * allowed (no writes, no shell), used by knowledge-ingestion to ground repo/project summaries in the
 * real checked-out codebase instead of a pre-fetched README/manifest snippet. Mirrors
 * shared/copilotCli.js's (now-removed) runCopilotAnalysis.
 */
export async function runGeminiAnalysis(prompt, { cwd, timeoutMs = 15 * 60 * 1000, model = GEMINI_MODEL } = {}) {
  const args = [
    '-m', model,
    '--skip-trust', // cwd is a throwaway ingestion checkout - no interactive session to answer the trust dialog
    '--approval-mode', 'default',
    '--allowed-tools', 'read_file,list_directory,glob,search_file_content',
    '--output-format', 'json',
  ];

  const stdout = await runGemini(args, { cwd, timeoutMs, prompt });
  return parseGeminiOutput(stdout);
}

/**
 * Runs `gemini` as a coding agent scoped to `cwd`. It's granted read/write file access but never
 * shell access. `--approval-mode=yolo` auto-accepts file edits without an interactive confirmation
 * prompt, since cwd is a throwaway job-scoped checkout (or several candidate clones side by side).
 * Git/PR operations stay under our explicit control in agent-logic/git.js and
 * agent-logic/githubPr.js.
 */
export async function runGeminiAgent(prompt, { cwd, timeoutMs = 40 * 60 * 1000, model = GEMINI_MODEL } = {}) {
  const args = [
    '-m', model,
    '--skip-trust', // cwd is a throwaway job-scoped checkout - no interactive session to answer the trust dialog
    '--approval-mode', 'yolo',
    '--allowed-tools', 'read_file,write_file,list_directory,glob,search_file_content,replace',
    '--output-format', 'json',
  ];

  const stdout = await runGemini(args, { cwd, timeoutMs, prompt });
  return parseGeminiOutput(stdout);
}
