import fs from 'node:fs';
import path from 'node:path';
import { downloadImageAttachments } from './jira.js';

const ATTACHMENTS_DIRNAME = '.ticket-attachments';

/**
 * Downloads every image attachment into `${destRoot}/.ticket-attachments/` and returns a task-text
 * snippet pointing the coding agent at their relative paths (or '' if none were downloaded).
 * `destRoot` must be a directory the agent's cwd actually covers - see bugfix-agent.js/
 * general-agent.js for why that differs between the single- and multi-candidate cases. Must be
 * paired with a `cleanupImageAttachments(destRoot)` call before any git diff/commit check on that
 * same directory, so downloaded images never leak into a PR (see git.js `hasChanges`/`commitAndPush`
 * - both treat any untracked file as a real change).
 */
export async function prepareImageAttachments(attachments, destRoot) {
  const destDir = path.join(destRoot, ATTACHMENTS_DIRNAME);
  const saved = await downloadImageAttachments(attachments, destDir);
  if (!saved.length) return '';

  const list = saved.map((f) => `- ${ATTACHMENTS_DIRNAME}/${f.filename}`).join('\n');
  return `\n\nImage attachments (view these files directly - they are available on disk relative to your working directory):\n${list}`;
}

/** Removes the downloaded image-attachments folder from `destRoot`, if present. */
export function cleanupImageAttachments(destRoot) {
  fs.rmSync(path.join(destRoot, ATTACHMENTS_DIRNAME), { recursive: true, force: true });
}
