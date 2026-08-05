import 'dotenv/config';
import { generateSystemMap } from './summarizer.js';
import { saveSystemMap } from '../shared/systemMap.js';

/**
 * On-demand system-map generation, run manually (workflow_dispatch) rather than on every push -
 * unlike ingestOnPush.js, this is deliberately NOT wired into the per-repo push pipeline: it's
 * expensive (deep exploration across the whole repo, long timeout) and only needed rarely, when a
 * high-level initiative's requirement docs need real architectural grounding - see
 * knowledge-ingestion/summarizer.js's generateSystemMap for the full rationale.
 *
 * Required: REPO (org/name), REPO_DIR (existing checkout).
 */
function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

async function main() {
  const repo = requireEnv('REPO');
  const repoDir = requireEnv('REPO_DIR');

  console.log(`[${repo}] generating system map...`);
  const content = await generateSystemMap({ repo, cwd: repoDir });
  saveSystemMap(repo, content);
  console.log(`[${repo}] wrote system map (${content.length} chars) to data/system-map/`);
}

main().catch((err) => {
  console.error('Fatal system-map generation error:', err);
  process.exit(1);
});
