# agent-hub

Central repository powering an autonomous AI developer system: incremental RAG ingestion of your
organization's codebases, plus LLM coding agents that turn Jira tickets into pull requests.

No agent logic lives inside your production codebases — everything is centralized here. Ingestion
is the one exception: each target repo carries a tiny trigger-only workflow of its own so it can
notify agentic-hub on its own pushes (see [Incremental RAG ingestion](#the-incremental-rag-ingestion-flow)
below) — that workflow only fires a `repository_dispatch` naming the repo/commit range; it holds no
Copilot or Pinecone credentials, and none are ever sent to it. The actual clone, analysis, and
vector DB writes all happen back here in agentic-hub, using agentic-hub's own secrets.

## Architecture

```
Jira (webhook) --> n8n (router) --> GitHub repository_dispatch --> agent-hub (this repo)
                                                                      |
                                                    +-----------------+-----------------+
                                                    |                                   |
                                       .github/workflows/unified-agent-runner.yml   .github/workflows/rag-ingestion-dispatch.yml
                                        (bugfix-agent.js / tech-debt-agent.js)     (repository_dispatch from a target
                                                                                    repo's own trigger-only workflow)
```

- **Router** — Jira + n8n. Jira fires a webhook to n8n on ticket creation. n8n forwards just the ticket key and type via a
  `repository_dispatch` to this repo - agent-hub itself fetches the ticket description from Jira, resolves the target
  repo(s) (via the parent ticket for bugfix, or a vector-DB search for tech-debt), and decides what to change.
- **Memory** — Pinecone (serverless vector DB), kept fresh incrementally: each target repo's own
  push re-analyzes only what actually changed since the last successful run.
- **Brain & Hands** — this repo: ingestion scripts, agent logic, and the GitHub Actions
  workflows that run them against target repositories using an org-level PAT.

## Repository layout

| Path | Purpose |
|---|---|
| [docs/WORKFLOW.md](docs/WORKFLOW.md) | End-to-end ticket-to-PR workflow, with an elaborated deep dive on the RAG layer: why it exists, how it's generated, what's stored, and model details. |
| [.github/workflows/unified-agent-runner.yml](.github/workflows/unified-agent-runner.yml) | Entry point triggered by n8n via `repository_dispatch`. |
| [.github/workflows/rag-ingestion-dispatch.yml](.github/workflows/rag-ingestion-dispatch.yml) | Entry point triggered by a target repo's own trigger-only workflow via `repository_dispatch`; does the actual clone + ingestion. |
| [rag-ingestion/](rag-ingestion/ingestOnPush.js) | Per-push incremental ingestion entrypoint (`ingestOnPush.js`) and the summarize/embed logic it calls into. |
| [agent-logic/](agent-logic/copilotAgent.js) | The LLM code-editing agents: [bugfix-agent.js](agent-logic/bugfix-agent.js) and [tech-debt-agent.js](agent-logic/tech-debt-agent.js). |
| [shared/](shared/config.js) | Shared Pinecone / Copilot CLI clients and config used by both layers. |

## The incremental RAG ingestion flow

Each target repo carries a small trigger-only workflow (e.g.
`mepworkspace/.github/workflows/rag-ingestion.yml`) that fires on every push to its tracked branch
(plus a manual `workflow_dispatch` for on-demand runs). That workflow does **not** run any
Copilot/Pinecone logic itself - it just fires a `repository_dispatch` (event type `rag-ingest`) at
agentic-hub with `{ repo, repo_type, event_name, before, after, force_full }`, using only a PAT
capable of triggering that dispatch. [.github/workflows/rag-ingestion-dispatch.yml](.github/workflows/rag-ingestion-dispatch.yml)
receives it, checks out the target repo itself (using agentic-hub's own `ORG_GITHUB_PAT`), and runs
`npm run ingest:push` ([rag-ingestion/ingestOnPush.js](rag-ingestion/ingestOnPush.js)) with `REPO`,
`REPO_TYPE`, and `REPO_DIR` supplied from that payload - Copilot/Pinecone secrets only ever exist
here, in agentic-hub.

1. **Work out what changed** — a push event's own `before`/`after` commits are used directly; a
   manual dispatch instead diffs against whatever commit
   [rag-ingestion/ingestionState.js](rag-ingestion/ingestionState.js) recorded as last successfully
   ingested (a small bookkeeping vector in Pinecone, `{repo}::_ingestion-state`). If nothing
   changed, the run skips entirely.
2. **API services** — analyzed as a whole project every time something changed
   ([rag-ingestion/apiServiceIngestor.js](rag-ingestion/apiServiceIngestor.js)): a read-only Copilot
   CLI agent explores the checked-out code (README, manifest, controllers/handlers, domain models)
   and produces one factual JSON summary
   ([rag-ingestion/summarizer.js](rag-ingestion/summarizer.js)'s `summarizeApiService`) covering the
   whole repo — one summary call is cheap enough that there's no benefit to diffing at file
   granularity for these.
3. **Nx monorepos** — only the project(s) actually touched are re-analyzed
   ([rag-ingestion/monorepoIngestor.js](rag-ingestion/monorepoIngestor.js)): every project's
   `project.json` is read directly (deliberately bypassing the Nx CLI — running `npm install` +
   `npx nx graph` against an arbitrary target repo is fragile in CI: peer-dependency conflicts,
   postinstall permission issues, long install times), the diff's changed files are mapped to
   whichever project's declared root is their longest matching ancestor path, and only those
   projects get a fresh read-only Copilot CLI pass
   ([rag-ingestion/summarizer.js](rag-ingestion/summarizer.js)'s `summarizeMonorepoProject`) - up to
   `RAG_INGEST_CONCURRENCY` (default 6) running in parallel, each upserted to Pinecone as soon as
   its own summary is ready rather than waiting for every project in the batch to finish first.
   Deleted/renamed `project.json` files are detected from the diff and their old vector removed
   outright, rather than waiting for a full pass to notice they're gone.
4. **Sync vector DB** — [shared/pinecone.js](shared/pinecone.js) embeds each summary text via
   Pinecone's hosted inference API and upserts with `{ repo, type, purpose, keyModules,
   dependencies/dependsOn, notablePatterns, runId, updatedAt, ... }` metadata, then records the
   commit just ingested so the next run knows where to resume from.

A repo with no prior ingestion state yet (first run ever, or a diff that can't be computed - shallow
history, force-push, rewritten history) falls back to a full baseline pass over every project,
automatically, in the same `rag-ingestion-dispatch.yml` run - there's no separate backfill workflow
to run first.

## The agentic ticket lifecycle

1. **Ticket ingestion** — Jira webhook → n8n.
2. **Trigger GitHub Hub** — n8n forwards only the ticket key: it sends a single generic `repository_dispatch` (event type
   `jira-ticket`) with a `client_payload` of `{ ticket_key }` on *any* ticket creation. Nothing else - not the description,
   not the ticket type, not target repo(s)/branch/path - is ever sent by n8n; all of that is resolved entirely within
   GitHub Actions by agent-hub itself.
3. **Agent execution** — [.github/workflows/unified-agent-runner.yml](.github/workflows/unified-agent-runner.yml) is a
   single job (no matrix - candidate repos are gathered and cloned from inside the Node scripts, not fanned out per-repo
   at the workflow level):
   - **Fetch and classify the ticket** — [agent-logic/fetchTicket.js](agent-logic/fetchTicket.js) fetches the ticket's
     summary/description/issue type from Jira, then [agent-logic/jira.js](agent-logic/jira.js)'s `classifyTicketType()`
     maps the Jira issue type to an automation category: **"User Story Bug"** (a subtask type) → bugfix,
     **"Technical Debt"** → tech-debt, anything else (`Story`/`User Story` parent containers, `Task`, `Epic`, ...) → not
     automated, and the job cleanly no-ops rather than guessing.
   - **Gather candidate repos** — [agent-logic/repoCandidates.js](agent-logic/repoCandidates.js) gathers candidate repo(s)
     for [agent-logic/bugfix-agent.js](agent-logic/bugfix-agent.js) / [agent-logic/tech-debt-agent.js](agent-logic/tech-debt-agent.js)
     to consider, in priority order: bugfix tickets look up **every** repo
     referenced by the Jira parent ticket's linked PRs *and* branches ([agent-logic/jira.js](agent-logic/jira.js)) - a
     parent story/epic can span several repos, so all of them become candidates; otherwise (tech-debt always, since it
     has no parent ticket) an adaptive set of "appropriate" candidates comes from a vector-DB search
     ([agent-logic/contextRetrieval.js](agent-logic/contextRetrieval.js)) - one match if there's a clear winner, several if
     more than one repo is a genuinely competitive match. Every vector-search-derived candidate uses its actual
     GitHub default branch ([agent-logic/githubPr.js](agent-logic/githubPr.js)'s `getDefaultBranch`) rather than
     guessing a default.
   - **Clone and decide** — each surviving candidate (skipping any that already has an open PR for this ticket) is shallow
     -cloned into its own subfolder of the workspace ([agent-logic/repoWorkspace.js](agent-logic/repoWorkspace.js)). If
     there's only one candidate, the coding agent works on it directly. If there are several, one Copilot CLI session is
     given all the checked-out candidates side by side - the ticket may apply to only one of them, or to several at once
     (e.g. a fix or cleanup that spans more than one service) - and it edits every repo the ticket genuinely applies to,
     leaving the rest untouched.
4. **Commit and notify** — rather than trusting the agent's self-report of which repo(s) it touched, every candidate is
   checked for real changes via `git status` ([agent-logic/git.js](agent-logic/git.js)): each repo with actual changes gets
   its own branch pushed and its own PR opened ([agent-logic/githubPr.js](agent-logic/githubPr.js)); repos the agent left
   untouched are skipped and their local clone is removed. A single Jira comment then lists the PR link for every repo
   that got one ([agent-logic/jira.js](agent-logic/jira.js)) — so a multi-repo ticket ends up with one comment listing
   every PR, not just one.

## Setup

1. `npm install`
2. Install the GitHub Copilot CLI globally: `npm install -g @github/copilot` (requires an active Copilot subscription).
3. Copy [.env.example](.env.example) to `.env` and fill in credentials for local runs.
4. Add the same values as GitHub Actions **secrets** (`COPILOT_GITHUB_TOKEN`, `PINECONE_API_KEY`, `ORG_GITHUB_PAT`,
   `JIRA_EMAIL`, `JIRA_API_TOKEN`) and **variables** (`COPILOT_MODEL`, `PINECONE_INDEX`, `PINECONE_EMBEDDING_MODEL`, `JIRA_BASE_URL`) on this repo.
   `COPILOT_GITHUB_TOKEN` should be a PAT (fine-grained or classic) with the "Copilot Requests" permission enabled.
5. `ORG_GITHUB_PAT` must be an organization-level PAT (or GitHub App installation token) with `repo` and `pull_request` scope
   across every target repository - agentic-hub's own ingestion workflow uses it to check out a target repo when a
   `rag-ingest` dispatch arrives, and agent-logic uses it to look up a candidate repo's default branch via the GitHub API.
   Each target repo also needs this same PAT (as its own `ORG_GITHUB_PAT` secret) purely to fire the `repository_dispatch`
   that notifies agentic-hub - it never sees Copilot/Pinecone credentials.
6. Point your n8n workflow's HTTP node at
   `POST https://api.github.com/repos/<org>/agent-hub/dispatches` with `event_type: jira-ticket` and
   `client_payload: { "ticket_key": "<the Jira issue key>" }` - on every new ticket, regardless of type; agent-hub
   decides whether/how to act on it.
7. For each repo you want RAG-ingested, add a small trigger-only workflow *in that repo* (e.g.
   [mepworkspace's rag-ingestion.yml](../mepworkspace/.github/workflows/rag-ingestion.yml)) that fires a
   `repository_dispatch` at agentic-hub on push - see the
   [incremental RAG ingestion flow](#the-incremental-rag-ingestion-flow) above for the payload shape. That workflow only
   needs `ORG_GITHUB_PAT`; none of step 4's Copilot/Pinecone secrets are needed in the target repo.

## Local commands

```bash
npm run ingest:push      # incremental ingestion for one already-checked-out repo (requires REPO, REPO_TYPE, REPO_DIR env vars)
npm run agent:bugfix     # run the bugfix agent (requires TICKET_KEY, TICKET_DESCRIPTION; TARGET_REPO/WORKSPACE_DIR optional)
npm run agent:tech-debt  # run the tech-debt agent (also accepts an optional TARGET_PATH)
```
