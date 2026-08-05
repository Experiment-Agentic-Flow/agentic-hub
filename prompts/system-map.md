You are producing a "system map" for {{REPO}}: a deep architectural reference an engineer would read
before writing a requirement/spec document for a new high-level initiative (an Epic spanning several
areas of this codebase), not a quick per-ticket lookup. Thoroughness matters more than brevity here -
unlike a short summary, it is fine (expected) for this to be long, since it is generated rarely (once,
then only regenerated when the architecture or your instructions meaningfully change) rather than on
every push.

Explore the checked-out repository in your current working directory using your read tool: README(s),
architecture docs, top-level config (nx.json/tsconfig path mappings, project.json tags, workspace
layout), and enough real source across different areas to understand how the pieces fit together - not
just what any single file does in isolation.

Produce a Markdown document covering:

1. **Product overview** - what business/user problem this repo's product(s) solve and who their
   actual users are, at the level a new engineer or architect needs before proposing a change; the
   major apps/services/domains it contains, how they relate, and where each fits in the broader
   product suite. Write this for someone who has never used the product, not just someone reading
   the code.
2. **End-to-end workflows** - the real user-facing workflows/journeys the major apps support,
   described step by step in plain product language first, then for each step naming the concrete
   app/domain/subsystem that actually implements it. Cover every major workflow you can ground in
   the real code/routes/components, not just the primary happy path.
3. **Structural rules and conventions** - layering rules (e.g. feature/ui/data-access/util/model/api
   dependency direction), naming conventions, tagging conventions, module boundary enforcement - and
   anything that would make a proposed design non-compliant if violated.
4. **Key subsystems/domains** - grouped by responsibility (not a flat list of every project), each
   stating both its technical responsibility AND the user-facing capability it enables, and which
   other subsystems it depends on or is depended on by.
5. **Cross-cutting patterns** - state management approach, testing conventions, shared infrastructure
   (auth, logging, feature flags, etc.) used across multiple subsystems.
6. **Notable constraints/gotchas** - anything a new initiative's design would need to account for
   (known architectural debt, migration-in-progress areas, non-obvious coupling).

Ground every claim in what you actually found in the code/config - if something can't be determined,
say so rather than guessing. Do not attempt to enumerate every single project/file; group and
generalize where that gives a truer picture of the architecture than an exhaustive list would.
