import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { runAgentLoop } from './copilotAgent.js';
import { createBranch, commitAndPush } from './git.js';
import { openPullRequest, findExistingPullRequest } from './githubPr.js';
import { addJiraComment } from './jira.js';
import { retrieveRelatedContext } from './contextRetrieval.js';
import { gatherCandidates } from './repoCandidates.js';
import { cloneCandidate, sanitizeRepoDirName } from './repoWorkspace.js';
import { formatUsageSummary } from '../shared/copilotCli.js';

async function main() {
  const {
    TICKET_KEY,
    TICKET_DESCRIPTION,
    TARGET_REPO,
    TARGET_PATH,
    TARGET_BRANCH,
    WORKSPACE_DIR = path.resolve('workspace'),
  } = process.env;

  if (!TICKET_KEY || !TICKET_DESCRIPTION) {
    throw new Error('TICKET_KEY and TICKET_DESCRIPTION are required env vars');
  }

  const branchName = `task/${TICKET_KEY.toLowerCase()}`;

  // Tech-debt tickets have no parent ticket to fall back on - candidates always come from either
  // an explicit target repo or a vector-DB search.
  let candidates = await gatherCandidates({
    ticketKey: TICKET_KEY,
    ticketType: 'tech-debt-ticket',
    description: TICKET_DESCRIPTION,
    targetRepo: TARGET_REPO,
    targetBranch: TARGET_BRANCH,
    targetPath: TARGET_PATH,
  });

  if (candidates.length === 0) {
    throw new Error(`Could not identify any candidate repo for ${TICKET_KEY} from the vector DB`);
  }

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
    `Candidate repo(s) for ${TICKET_KEY}: ${candidates.map((c) => `${c.repo} (${c.paths.join(', ')}, ${c.source})`).join(', ')}`
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
    const candidate = candidates[0];
    const chosenRepo = candidate.repo;
    console.log(`Running tech-debt agent for ${TICKET_KEY} on ${chosenRepo} (${candidate.paths.join(', ')})`);

    let relatedContext = [];
    try {
      relatedContext = await retrieveRelatedContext(TICKET_DESCRIPTION, chosenRepo);
    } catch (err) {
      console.warn(`Vector context retrieval failed, continuing without it: ${err.message}`);
    }

    const contextBlock = relatedContext.length
      ? `\n\nRelated architectural context from the knowledge base:\n${relatedContext
          .map((c) => `- ${c.id} (score ${c.score.toFixed(2)}): ${JSON.stringify(c.metadata)}`)
          .join('\n')}`
      : '';

    if (candidate.paths.length === 1 && candidate.paths[0] !== '.') {
      // Exactly one matching project - safe to scope the agent's whole working directory to it, so
      // it doesn't have to search the rest of the repo to find it.
      const onlyPath = candidate.paths[0];
      const scopedRoot = path.resolve(candidateDirs[chosenRepo], onlyPath);
      result = await runAgentLoop({
        rootDir: scopedRoot,
        systemPrompt: `You are an autonomous senior software engineer paying down tech debt in ${chosenRepo}, scoped strictly to path "${onlyPath}".
Use the provided tools to explore only this scope and apply a focused refactor. Do not touch files outside this scope.`,
        task: `Tech debt ticket ${TICKET_KEY}:\n\n${TICKET_DESCRIPTION}${contextBlock}`,
      });
    } else {
      // Several projects inside this repo matched (or none matched a specific project) - the
      // ticket may span more than one of them, so don't hard-restrict rootDir to a single path.
      const pathsList = candidate.paths.filter((p) => p !== '.').map((p) => `- ${p}`);
      const pathsBlock = pathsList.length
        ? `\n\nThe knowledge base identified these specific project paths for this ticket:\n${pathsList.join('\n')}\n\nGo straight to these paths rather than searching the whole repository for them. This ticket may apply
to only one of these, or to several of them at once (e.g. the same pattern duplicated across libs). Apply a focused
refactor inside every path that genuinely applies, and leave unrelated parts of the repository untouched.`
        : '';
      result = await runAgentLoop({
        rootDir: candidateDirs[chosenRepo],
        systemPrompt: `You are an autonomous senior software engineer paying down tech debt in ${chosenRepo}.${pathsBlock}`,
        task: `Tech debt ticket ${TICKET_KEY}:\n\n${TICKET_DESCRIPTION}${contextBlock}`,
      });
    }
  } else {
    console.log(`Multiple candidate repos for ${TICKET_KEY}; letting the agent inspect and refactor wherever it applies.`);
    const candidateList = candidates
      .map(
        (c) =>
          `- ${sanitizeRepoDirName(c.repo)}/  (repo: ${c.repo}, likely path(s): ${c.paths.join(', ')}, matched via: ${c.source})`
      )
      .join('\n');

    result = await runAgentLoop({
      rootDir: WORKSPACE_DIR,
      systemPrompt: `You are an autonomous senior software engineer. It isn't yet certain which repository this tech-debt
ticket belongs to, so several candidates have been checked out as subfolders of the current working directory:
${candidateList}

Inspect each candidate's code. This ticket may target ONLY ONE of these repos, or it may describe a cross-cutting
cleanup that applies to SEVERAL of them (e.g. the same pattern duplicated across services). Apply a focused refactor
inside the subfolder of EVERY repo (and, for monorepos, the specific project path within it) the ticket genuinely
applies to, and leave every other candidate completely untouched.`,
      task: `Tech debt ticket ${TICKET_KEY}:\n\n${TICKET_DESCRIPTION}`,
    });
  }

  // Rather than trusting the agent's self-report of which repo(s) it touched, check every
  // candidate's actual git status - that way a cleanup that legitimately spans multiple repos
  // gets a PR in each of them, and repos the agent left untouched are correctly skipped.
  const openedPrs = [];
  for (const candidate of candidates) {
    const pushed = await commitAndPush(
      candidateDirs[candidate.repo],
      candidate.repo,
      branchName,
      `${result.commitMessage}\n\nAddresses ${TICKET_KEY}`
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
      body: `${result.prSummary}\n\nAutomated tech-debt cleanup generated by agent-hub for ${TICKET_KEY}, scoped to \`${candidate.paths.join(', ')}\`.`,
    });

    console.log(`Opened PR: ${prUrl}`);
    openedPrs.push({ repo: candidate.repo, paths: candidate.paths, prUrl });
    fs.rmSync(candidateDirs[candidate.repo], { recursive: true, force: true });
  }

  if (openedPrs.length === 0) {
    console.log(`No changes were made by the agent in any candidate repo for ${TICKET_KEY}; skipping PR creation.`);
    console.log(formatUsageSummary());
    return;
  }

  const prSummaryLines = openedPrs.map((p) => `- ${p.repo} (${p.paths.join(', ')}): ${p.prUrl}`).join('\n');
  console.log(formatUsageSummary());
  await addJiraComment(
    TICKET_KEY,
    `agent-hub opened the following tech-debt cleanup PR(s) for this ticket:\n${prSummaryLines}\n\n${formatUsageSummary()}`
  );
}

main().catch((err) => {
  console.error('Tech-debt agent failed:', err);
  process.exit(1);
});
