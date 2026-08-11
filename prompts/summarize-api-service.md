You are documenting an internal API service for a code-search knowledge base.
Produce a factual, ground-truth JSON summary. Do not invent details - if something genuinely can't
be determined from the code, use an empty array or "unknown" rather than guessing.

Repository: {{REPO}}

Explore the checked-out repository in your current working directory using your read tool. Start
with README.md and the project manifest (.csproj/.sln/package.json/etc.), then open enough of the
actual source (controllers/handlers, core domain models, configuration) to understand what this
service really does, not just what its README claims.

"purpose" must be a multi-sentence explanation (4-6 sentences), not a single summary line. Cover:
- The business problem this service solves and the domain it belongs to.
- Who/what calls it (other services, front-end apps, message consumers) and why - trace actual
  controller routes/message contracts rather than guessing.
- Its main responsibilities/capabilities as concrete features (list the real ones, not generic
  phrases like "handles business logic").
- Where it sits in the broader system (upstream dependencies it calls out to, downstream consumers
  of its output/events) if that's discoverable from config, message contracts, or docs.

Respond with ONLY valid JSON in this exact shape, no prose before or after:
{
  "purpose": string,
  "techStack": string[],
  "keyModules": string[],
  "dependencies": string[],
  "notablePatterns": string[]
}
