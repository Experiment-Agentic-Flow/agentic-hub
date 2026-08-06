# agent-hub: Ticket-to-PR Workflow

This document walks through the entire journey from a Jira ticket being created to a pull request
landing in the target repository, covering both agentic workflows (bugfix and general ticket implementation), how a
ticket is classified and routed to the right repo(s), how code changes are made and PR'd, and — in
detail — the Retrieval-Augmented Generation (RAG) layer that supports repo/context resolution. For
a higher-level architecture summary, see [README.md](README.md).

## End-to-end workflow

```
Jira ticket created
        │
        ▼
n8n forwards only { ticket_key } via repository_dispatch
        │
        ▼
agent-logic/fetchTicket.js fetches summary/description/issue type from Jira
        │
        ▼
classifyTicketType(): "User Story Bug" → bugfix   |   anything else → general ticket   |   missing issue type → no-op
        │
        ▼
agent-logic/repoCandidates.js gatherCandidates()
        │
        ├─ bugfix ticket, parent's linked PR/branch found? ──────► use that repo (no RAG — see below)
        │
        └─ otherwise (general ticket always; bugfix with no parent match)
                    │
                    ▼
           RAG: resolveCandidatesFromVectorSearch(description)
                    │
                    ▼
        clone candidate repo(s) → coding agent inspects real code → applies fix/refactor
                    │
                    ▼
        (general ticket, single-candidate only) RAG: retrieveRelatedContext() adds extra context
                    │
                    ▼
        git diff detected per candidate → commit, push, open PR for every repo actually changed
                    │
                    ▼
        one Jira comment listing every PR opened
```

## Ticket classification and repo resolution

[agent-logic/fetchTicket.js](agent-logic/fetchTicket.js) fetches the ticket's summary, description,
and Jira issue type, then [agent-logic/jira.js](agent-logic/jira.js)'s `classifyTicketType()` maps
the issue type to an automation category: **"User Story Bug"** (a subtask type) → bugfix,
anything else (`Technical Debt`, `Story`/`User Story` parent containers, `Task`, `Epic`, ...) → general
ticket, and only a missing issue type causes the job to cleanly no-op rather than guessing.

[agent-logic/repoCandidates.js](agent-logic/repoCandidates.js)'s `gatherCandidates()` then resolves
which repo(s) the ticket targets, in priority order:

1. **Bugfix tickets**: every repo referenced by the Jira **parent** ticket's linked GitHub PRs
   *and* branches (via Jira's Development panel / dev-status API,
   [agent-logic/jira.js](agent-logic/jira.js)'s `resolveTargetReposFromParent`) — a parent
   story/epic can span several repos, so all of them become candidates.
2. **Otherwise** (general ticket always; bugfix only when step 1 found nothing): an adaptive set of
   candidates from a RAG vector-DB search — see [RAG in this workflow](#rag-in-this-workflow) below.

### Bugfix tickets resolved via a parent ticket do not use RAG at all

This is intentional, and worth calling out explicitly since it's easy to assume RAG is always in
the loop. If step 1 above finds any repos, those are used directly —
`resolveCandidatesFromVectorSearch` (RAG) is never called for this ticket. Separately,
[agent-logic/bugfix-agent.js](agent-logic/bugfix-agent.js) never calls `retrieveRelatedContext()`
either (that's only wired into [agent-logic/general-agent.js](agent-logic/general-agent.js)).
So for a typical bugfix subtask whose parent story already has a linked branch/PR, **RAG plays no
role whatsoever** — not for finding the repo, and not for extra context.

Why this is the right design, not a gap: a parent ticket's linked PR/branch is a **concrete,
already-verified fact** — a human or a previous automation run already associated that exact repo
with this work. RAG's vector search is a *probabilistic* fallback for when no such ground-truth
signal exists yet. Reaching for a semantic guess when you already have certainty would be strictly
worse — slower, and with a (small but nonzero) chance of picking the wrong repo.

| Ticket path | Repo resolution | RAG used? |
|---|---|---|
| Bugfix, parent ticket has linked PR(s)/branch(es) | Jira dev-status API | **No** |
| Bugfix, parent ticket has no linked activity yet | Vector search | Yes (candidate resolution only) |
| General ticket (always — no parent ticket concept) | Vector search | Yes (candidate resolution **and** related-context) |

## Cloning, coding, and PR creation

Each surviving candidate (skipping any that already has an open PR for this ticket) is shallow
-cloned into its own subfolder of the workspace ([agent-logic/repoWorkspace.js](agent-logic/repoWorkspace.js)).
If there's only one candidate, the coding agent works on it directly. If there are several, one
Copilot CLI session is given all the checked-out candidates side by side — the ticket may apply to
only one of them, or to several at once (e.g. a fix or cleanup spanning more than one service) —
and it edits every repo the ticket genuinely applies to, leaving the rest untouched.

Rather than trusting the agent's self-report of which repo(s) it touched, every candidate is then
checked for real changes via `git status` ([agent-logic/git.js](agent-logic/git.js)): each repo
with actual changes gets its own branch pushed and its own PR opened
([agent-logic/githubPr.js](agent-logic/githubPr.js)); repos left untouched are skipped and their
local clone is removed. A single Jira comment then lists the PR link for every repo that got one
([agent-logic/jira.js](agent-logic/jira.js)) — so a multi-repo ticket ends up with one comment
listing every PR, not just one.

## RAG in this workflow

### Why RAG was introduced (the benefit)

Without RAG, the only options for "which repo does this ticket belong to" when there's no
ground-truth signal (see the table above) would be:

- **Guess from ticket text alone with an LLM** — no grounding in what the org's repos actually
  contain; high risk of hallucinated or wrong repo names.
- **Clone and inspect every registered repository for every ticket** — correct in principle, but
  slow (one clone + one Copilot CLI exploration per repo, per ticket) and burns Copilot CLI quota
  on repos that were almost certainly never relevant.

RAG's benefit is doing the expensive "understand what every repo actually does" work **once, as
part of that repo's own push** (not per-ticket, and not by re-scanning the whole repo every time —
see below) — so that at ticket time, resolving "which repo(s)" is a single cheap vector-similarity
query instead of an expensive live exploration of the entire org's codebase. It turns an O(all
repos) problem per ticket into an O(1) semantic lookup, while still producing a real, code-grounded
answer (not a blind guess) because the ingestion agent already read the real, changed source files
in advance.

### The two things RAG is used for

Both consumers live in [agent-logic/contextRetrieval.js](agent-logic/contextRetrieval.js):

1. **Candidate repo resolution** — `resolveCandidatesFromVectorSearch(description)`, called from
   `gatherCandidates()` (used by general tickets always, and bugfix only as a fallback — see the table
   above). Embeds the ticket description as a `'query'` vector, searches the index, and returns an
   *adaptive* set of candidates: the top match is always included; further matches are only added
   if they're close enough in score to be genuinely competitive (`minScore: 0.65`,
   `relativeMargin: 0.08`, capped at `maxCandidates: 5`, which limits distinct **repos**, not paths
   within one repo). This can return **one** repo (clear winner) or **several** (multiple plausible
   matches) — the final choice of which repo(s)/path(s) to actually modify is deferred to the
   coding agent once it can see the real checked-out code, not decided by vector score alone. A
   single monorepo candidate carries a `paths` array, not just one path: every competitive Nx
   project match for that repo contributes its own `projectPath`, since one ticket can genuinely
   span several libs in the same monorepo - the coding agent only gets hard-scoped to a single
   directory when exactly one project matched.
2. **Related architectural context** — `retrieveRelatedContext(description, repo)`, called from
   [agent-logic/general-agent.js](agent-logic/general-agent.js) only (single-candidate case):
   once the target repo is known, this re-queries the index filtered to that repo and feeds the
   top matches' metadata into the coding agent's prompt as extra grounding context before it starts
   editing.

RAG is **never** used to write code itself — it only narrows down "where" and provides background
context. The actual code changes are always made by a real CLI coding agent (Gemini CLI by
default, `runGeminiAgent`; Copilot CLI's `runCopilotAgent` when this repo's global
[shared/config.js](shared/config.js) `CODING_PROVIDER` is set to `'copilot'`) with file read/write
tools, exploring and editing the real checked-out repository.

### How the RAG index is generated (per-repo incremental knowledge ingestion)

Entry point: [knowledge-ingestion/ingestOnPush.js](knowledge-ingestion/ingestOnPush.js), run by
[.github/workflows/knowledge-ingestion-dispatch.yml](.github/workflows/knowledge-ingestion-dispatch.yml) in
**agent-hub itself**. Each target repo carries a tiny trigger-only workflow of its own (e.g.
`mepworkspace/.github/workflows/knowledge-ingestion.yml`) that fires on every push to its tracked branch
(plus a manual `workflow_dispatch` for on-demand runs), but that workflow does no Gemini/Pinecone
work and holds no such credentials - it only fires a `repository_dispatch` (event type
`knowledge-ingest`) at agent-hub with `{ repo, repo_type, event_name, before, after, force_full }`.
Agent-hub's own workflow receives it, checks out the target repo itself, and passes
`REPO`/`REPO_TYPE`/`REPO_DIR` (and the `before`/`after` SHAs) to `ingestOnPush.js` as env vars -
Gemini and Pinecone secrets only ever exist in agent-hub, never in a target repo.

For each dispatch, the pipeline is:

1. **Work out what changed** — a push event's own `before`/`after` commits are used directly to
   diff; a manual dispatch has no "before" of its own, so it falls back to whatever commit
   [knowledge-ingestion/ingestionState.js](knowledge-ingestion/ingestionState.js) recorded as last successfully
   ingested (a small bookkeeping vector in Pinecone, `{repo}::_ingestion-state`,
   excluded from search/pruning via `type: "ingestion_state"`) — this is also what lets a re-run
   catch up on any push whose own ingestion run failed. If the resolved range has no actual
   changes, the run skips entirely — no agent call, no Pinecone write.
2. **API services stay whole-project** — [knowledge-ingestion/apiServiceIngestor.js](knowledge-ingestion/apiServiceIngestor.js)'s
   `ingestApiServiceFromDir` re-runs one summary over the entire already-checked-out repo whenever
   anything changed. A single summary call is cheap enough that diffing at file granularity buys
   nothing here — the whole point of the incremental machinery below is to avoid unnecessary
   *agent* calls, and an API service only ever needs one.
3. **Monorepo projects are diffed to just what changed** —
   [knowledge-ingestion/monorepoIngestor.js](knowledge-ingestion/monorepoIngestor.js) reads every project's
   `project.json` directly (still deliberately bypassing the Nx CLI, for the same CI-fragility
   reasons as before), then [knowledge-ingestion/gitDiff.js](knowledge-ingestion/gitDiff.js)'s changed-file list
   is mapped to whichever project's declared root is the longest (most specific) matching ancestor
   path — only those projects get a fresh agent pass, up to `KNOWLEDGE_INGEST_CONCURRENCY` (default 6) in
   parallel rather than one at a time. Deleted/renamed `project.json` files are detected from the
   diff directly (`resolveDeletedProjectIds`, reading the old blob via `git show <fromSha>:<path>`
   to resolve the project's old name) and their vector removed outright, rather than waiting for a
   full pass to notice they're gone.
4. **Explore the real code** — for whatever needs re-analysis (the whole API service, or just the
   affected Nx project(s)), a **read-only Gemini CLI agent**
   ([shared/geminiCli.js](shared/geminiCli.js)'s `runGeminiAnalysis`) is pointed at the already
   -checked-out working tree. It's granted read/list/search tools (so it can actually open
   README/manifest/controllers/domain models/config — whatever it decides is relevant) but write
   and shell tools are both denied, since this is analysis only. This is deliberately the same
   *kind* of exploration the real coding agents do, just without edit permissions — summaries are
   grounded in the actual codebase, not just a README's claims.
5. **Summarize into structured JSON** — [knowledge-ingestion/summarizer.js](knowledge-ingestion/summarizer.js)
   drives that exploration with one of two prompts, both instructed to return only verifiable facts
   (`"unknown"`/`[]` rather than invented details):
   - `summarizeApiService({ repo, cwd })` → `{ purpose, techStack, keyModules, dependencies, notablePatterns }`.
   - `summarizeMonorepoProject({ repo, projectName, cwd })` → `{ purpose, keyModules, notablePatterns }`,
     run once per *affected* Nx project inside a monorepo, scoped to that project's own subfolder.
6. **Embed** — the structured summary is flattened into one plain-text block (e.g.
   `Repository: ...\nPurpose: ...\nTech stack: ...\nKey modules: ...\n...`) and embedded via
   [shared/embeddings.js](shared/embeddings.js)'s `embedTexts(texts, 'passage')`.
7. **Upsert + record progress** — [shared/pinecone.js](shared/pinecone.js) upserts each project's
   vector + metadata under a deterministic ID as soon as that project's own summary is ready (not
   after every project in the batch finishes), deletes any vector ids resolved as
   genuinely-removed projects, and finally [knowledge-ingestion/ingestionState.js](knowledge-ingestion/ingestionState.js)
   records the commit just ingested so the next dispatch knows where to resume from.

A repo with no prior ingestion state at all (first run ever, or a diff that can't be computed —
shallow history, force-push, rewritten history) falls back to a full baseline pass over every
project (`ingestMonorepoFull`), pruning anything stale via `pruneStale(repo, runId)` — incremental
runs never call `pruneStale`, since they intentionally leave untouched projects alone; they only
ever delete ids they've specifically identified as removed.

### What's actually stored

**Vector ID scheme** (deterministic, so re-ingestion overwrites in place rather than duplicating):
- API service: `"{repo}::service-summary"` — one vector per repo.
- Monorepo project: `"{repo}::{projectName}"` — one vector per Nx project.

**Metadata per record:**

| Field | API service | Monorepo project | Description |
|---|---|---|---|
| `repo` | ✅ | ✅ | e.g. `"org/quantitytakeoffservice"` |
| `type` | `"api_service"` | `"monorepo_project"` | Lets queries/filters distinguish record shape |
| `purpose` | ✅ | ✅ | Plain-English description of what it actually does |
| `keyModules` | ✅ | ✅ | Named components/classes/services the agent found while exploring |
| `dependencies` | ✅ | — | External package/service dependencies (API services) |
| `dependsOn` | — | ✅ | Other Nx projects it declares as `implicitDependencies` |
| `notablePatterns` | ✅ | ✅ | Architectural patterns worth flagging (e.g. CQRS, sagas) |
| `techStack` | ✅ | — | e.g. `["dotnet"]` |
| `tags` | — | ✅ | Nx project tags from `project.json` |
| `projectPath` | — | ✅ | Path of the project within the monorepo |
| `runId` | ✅ | ✅ | UUID of the ingestion run that (re)wrote this vector — drives pruning |
| `updatedAt` | ✅ | ✅ | ISO timestamp of last (re)write |

Storing `purpose`/`keyModules`/`dependencies`/`notablePatterns` in metadata (not just using them to
compute the embedding and discarding them) means a query returns real descriptive content to reason
with or show a user — not just a bare repo name and similarity score.

### Model details

| Purpose | Model | Where configured |
|---|---|---|
| Embeddings (both ingestion and query time) | `llama-text-embed-v2` (Pinecone-hosted inference), 1024-dim, cosine similarity | [shared/config.js](shared/config.js) `EMBEDDING_MODEL`/`EMBEDDING_DIMENSION`, overridable via `PINECONE_EMBEDDING_MODEL` env var |
| Ingestion's read-only exploration/summarization agent | `GEMINI_SUMMARY_MODEL` (`flash` default) | [shared/geminiCli.js](shared/geminiCli.js) `runGeminiAnalysis`, overridable per-call |
| Coding agents (bugfix/general ticket implementation), default provider | `GEMINI_MODEL` (`pro` default) | [shared/geminiCli.js](shared/geminiCli.js) `runGeminiAgent`, env var `GEMINI_MODEL` |
| Coding agents, opt-in provider (`CODING_PROVIDER=copilot`, this repo's own env/config) | `COPILOT_MODEL` (`gpt-5.6-luna` default) | [shared/copilotCli.js](shared/copilotCli.js) `runCopilotAgent`, env var `COPILOT_MODEL` |
| Repo/project relevance-judgment prompts (candidate resolution) | `COPILOT_SUMMARY_MODEL` (`gpt-5.6-luna` default) | [shared/copilotCli.js](shared/copilotCli.js) `runCopilotPrompt`, used by agent-logic/repoDirectoryLookup.js and agent-logic/contextRetrieval.js |

**Why `llama-text-embed-v2` and not a code-specialized embedding model:** everything actually
embedded — both the ingested summaries and the ticket descriptions used to query them — is
LLM-distilled natural-language prose, not raw source code. A code-specialized model's advantage
(bridging code ↔ natural-language) doesn't apply here, since neither side of the comparison is raw
code; a strong general-purpose text model is the better (and simpler, single-vendor) fit.

**Why the exploration model defaults to the strong model, not the cheap one:** ingestion output
quality (how well the agent actually understands each repo) directly determines how well candidate
resolution and context retrieval work later — a weaker model here would degrade both agentic
workflows downstream, so cost is a secondary concern to correctness for this step.

### Index configuration

- Serverless Pinecone index, created on demand by `ensureIndexExists()` if it doesn't already exist
  ([shared/pinecone.js](shared/pinecone.js)): `dimension: 1024`, `metric: cosine`,
  `cloud: aws`, `region: us-east-1`.
- **Pinecone doesn't support changing an existing index's dimension or embedding model in place.**
  If the embedding model ever changes to one with a different output dimension, the existing index
  must be deleted and recreated (or `PINECONE_INDEX` pointed at a new name) — otherwise every
  upsert fails with a dimension mismatch.
