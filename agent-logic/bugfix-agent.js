import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { runAgentLoop } from './agentLoop.js';
import { createBranch, commitAndPush, hasChanges } from './git.js';
import { openPullRequest, findExistingPullRequest } from './githubPr.js';
import { addJiraComment } from './jira.js';
import { gatherCandidates } from './repoCandidates.js';
import { cloneCandidate, sanitizeRepoDirName } from './repoWorkspace.js';
import { validateChanges } from './validate.js';
import { loadPrompt } from '../shared/promptTemplate.js';

async function main() {
  const {
    TICKET_KEY,
    TICKET_DESCRIPTION,
    TARGET_BRANCH,
    WORKSPACE_DIR = path.resolve('workspace'),
  } = process.env;

  if (!TICKET_KEY || !TICKET_DESCRIPTION) {
    throw new Error('TICKET_KEY and TICKET_DESCRIPTION are required env vars');
  }

  const branchName = `bugfix/${TICKET_KEY.toLowerCase()}`;

  let candidates = await gatherCandidates({
    ticketKey: TICKET_KEY,
    ticketType: 'bugfix-ticket',
    description: TICKET_DESCRIPTION,
    targetBranch: TARGET_BRANCH,
  });

  if (candidates.length === 0) {
    throw new Error(`Could not identify any candidate repo for ${TICKET_KEY}`);
  }

  // Drop any candidate that already has an open PR for this ticket - no point cloning it.
  const openCandidates = [];
  for (const candidate of candidates) {
    const existingPr = await findExistingPullRequest({ repo: candidate.repo, head: branchName, base: candidate.branch });
    if (existingPr) {
      console.log(`An open PR already exists for ${TICKET_KEY} on ${candidate.repo}, skipping candidate: ${existingPr.html_url}`);
      continue;
    }
    openCandidates.push(candidate);
  }

  if (openCandidates.length === 0) {
    console.log('Every candidate repo already has an open PR for this ticket; nothing to do.');
    return;
  }
  candidates = openCandidates;

  console.log(
    `Candidate repo(s) for ${TICKET_KEY}: ${candidates.map((c) => `${c.repo} (${c.source})`).join(', ')}`
  );

  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  const candidateDirs = {};
  for (const candidate of candidates) {
    console.log(`Cloning ${candidate.repo}...`);
    candidateDirs[candidate.repo] = await cloneCandidate(WORKSPACE_DIR, candidate);
    await createBranch(candidateDirs[candidate.repo], branchName);
  }

  let result;

  if (candidates.length === 1) {
    const chosenRepo = candidates[0].repo;
    console.log(`Running bugfix agent for ${TICKET_KEY} on ${chosenRepo}`);
    result = await runAgentLoop({
      rootDir: candidateDirs[chosenRepo],
      systemPrompt: loadPrompt('bugfix-single-repo', { REPO: chosenRepo }),
      task: `Bug ticket ${TICKET_KEY}:\n\n${TICKET_DESCRIPTION}`,
    });
  } else {
    console.log(`Multiple candidate repos for ${TICKET_KEY}; letting the agent inspect and fix it wherever it applies.`);
    const candidateList = candidates
      .map((c) => `- ${sanitizeRepoDirName(c.repo)}/  (repo: ${c.repo}, matched via: ${c.source})`)
      .join('\n');

    result = await runAgentLoop({
      rootDir: WORKSPACE_DIR,
      systemPrompt: loadPrompt('bugfix-multi-repo', { CANDIDATE_LIST: candidateList }),
      task: `Bug ticket ${TICKET_KEY}:\n\n${TICKET_DESCRIPTION}`,
    });
  }

  // Rather than trusting the agent's self-report of which repo(s) it touched, check every
  // candidate's actual git status - that way a fix that legitimately spans multiple repos gets a
  // PR in each of them, and repos the agent left untouched are correctly skipped.
  const openedPrs = [];
  const failedValidations = [];
  for (const candidate of candidates) {
    if (!(await hasChanges(candidateDirs[candidate.repo]))) {
      console.log(`No changes were made by the agent in ${candidate.repo}; skipping PR creation.`);
      fs.rmSync(candidateDirs[candidate.repo], { recursive: true, force: true });
      continue;
    }

    // .NET repos only - run the real test suite before committing/pushing, so a broken build
    // never reaches a PR (Nx/Node repos are skipped here, see validate.js).
    const validation = await validateChanges(candidateDirs[candidate.repo]);
    if (validation.skipped) {
      console.log(`Skipping test validation for ${candidate.repo}: ${validation.reason}`);
    } else if (!validation.passed) {
      console.error(`Tests failed for ${candidate.repo}; not opening a PR:\n${validation.output}`);
      failedValidations.push({ repo: candidate.repo, output: validation.output });
      fs.rmSync(candidateDirs[candidate.repo], { recursive: true, force: true });
      continue;
    } else {
      console.log(`Tests passed for ${candidate.repo}.`);
    }

    const pushed = await commitAndPush(
      candidateDirs[candidate.repo],
      candidate.repo,
      branchName,
      `${result.commitMessage}\n\nFixes ${TICKET_KEY}`
    );
    if (!pushed) {
      console.log(`No changes were made by the agent in ${candidate.repo}; skipping PR creation.`);
      fs.rmSync(candidateDirs[candidate.repo], { recursive: true, force: true });
      continue;
    }

    const prUrl = await openPullRequest({
      repo: candidate.repo,
      base: candidate.branch,
      head: branchName,
      title: `[${TICKET_KEY}] ${result.commitMessage}`,
      body: `${result.prSummary}\n\nAutomated fix generated by agent-hub for ${TICKET_KEY}.`,
    });

    console.log(`Opened PR: ${prUrl}`);
    openedPrs.push({ repo: candidate.repo, prUrl });
    fs.rmSync(candidateDirs[candidate.repo], { recursive: true, force: true });
  }

  if (openedPrs.length === 0) {
    console.log(`No changes were made by the agent in any candidate repo for ${TICKET_KEY}; skipping PR creation.`);
    return;
  }

  const prSummaryLines = openedPrs.map((p) => `- ${p.repo}: ${p.prUrl}`).join('\n');
  const failureLines = failedValidations.map((f) => `- ${f.repo}: tests failed, no PR opened`).join('\n');
  await addJiraComment(
    TICKET_KEY,
    `agent-hub opened the following fix PR(s) for this ticket:\n${prSummaryLines}` +
      (failureLines ? `\n\nTests failed for other candidate(s), no PR opened:\n${failureLines}` : '')
  );
}

main().catch((err) => {
  console.error('Bugfix agent failed:', err);
  process.exit(1);
});
