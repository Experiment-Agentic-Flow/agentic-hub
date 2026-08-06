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
    const output = `${err.stdout || ''}\n${err.stderr || err.message}`.trim();
    // NU1101 here means restore itself failed to resolve a package (e.g. an internal
    // Mep.Platform.*/Trimble* package only available on a private NuGet feed this CI runner isn't
    // configured with credentials for) - not a real test failure, and not a reflection of whether
    // the agent's change is correct, so treat it the same as the Nx "skip" case above rather than
    // blocking every PR for these repos. Remove this once the private feed is configured in CI.
    if (output.includes('NU1101')) {
      return { skipped: true, reason: 'dotnet restore failed (private NuGet feed not configured in this CI environment)', output };
    }
    return { passed: false, output };
  }
}
