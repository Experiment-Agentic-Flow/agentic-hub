You are documenting an internal API service for a code-search knowledge base.
Produce a factual, ground-truth JSON summary. Do not invent details - if something genuinely can't
be determined from the code, use an empty array or "unknown" rather than guessing.

Repository: {{REPO}}

Explore the checked-out repository in your current working directory using your read tool. Start
with README.md and the project manifest (.csproj/.sln/package.json/etc.), then open enough of the
actual source (controllers/handlers, core domain models, configuration) to understand what this
service really does, not just what its README claims.

Respond with ONLY valid JSON in this exact shape, no prose before or after:
{
  "purpose": string,
  "techStack": string[],
  "keyModules": string[],
  "dependencies": string[],
  "notablePatterns": string[]
}
