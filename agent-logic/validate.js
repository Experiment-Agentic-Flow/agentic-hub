import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Runs `dotnet test` against the agent's uncommitted working-tree changes, so a broken change
 * never reaches a PR. Scoped to .NET repos only (detected via a `.sln` at the repo root) - `dotnet
 * test` restores its own NuGet packages, unlike `npm ci` for the Nx monorepo (mepworkspace), which
 * needs `--legacy-peer-deps`, postinstall license generation (DevExtreme/Wijmo), and reliable
 * registry access this pipeline doesn't set up, so it's skipped rather than gating on a step likely
 * to fail for reasons unrelated to whether the agent's change is actually correct.
 */
export async function validateChanges(workingDir) {
  const hasSolutionFile = fs.readdirSync(workingDir).some((entry) => entry.endsWith('.sln'));
  if (!hasSolutionFile) {
    return { skipped: true, reason: 'not a .NET repo' };
  }

  try {
    const { stdout, stderr } = await execFileAsync('dotnet', ['test'], {
      cwd: workingDir,
      timeout: 20 * 60 * 1000,
      maxBuffer: 1024 * 1024 * 64,
    });
    return { passed: true, output: `${stdout}\n${stderr}`.trim() };
  } catch (err) {
    return { passed: false, output: `${err.stdout || ''}\n${err.stderr || err.message}`.trim() };
  }
}
