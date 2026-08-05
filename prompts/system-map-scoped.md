You are producing a "system map" for the **{{SCOPE}}** app and its libraries inside the {{REPO}}
monorepo - a deep architectural reference an engineer would read before writing a requirement/spec
document for a new high-level initiative scoped to {{SCOPE}}, not a quick per-ticket lookup.
Thoroughness matters more than brevity here - unlike a short summary, it is fine (expected) for this
to be long, since it is generated rarely (once, then only regenerated when {{SCOPE}}'s architecture or
your instructions meaningfully change) rather than on every push.

This is a **scoped** map, not a whole-monorepo one: focus your deep exploration on {{SCOPE}}'s app
folder and its real dependency closure, not just anything that happens to share its name.
{{PATHS_BLOCK}}
Skim just enough of the repo-wide config (nx.json, tsconfig path mappings, top-level
`.eslintrc.json` module-boundary rules) to state the *general* layering conventions {{SCOPE}}'s own
libs must follow - but do not deep-dive into libs/apps outside the paths above.

Explore the checked-out repository in your current working directory using your read tool: any
README(s) inside {{SCOPE}}'s own folders, `project.json` files (tags, dependencies), and enough real
source across {{SCOPE}}'s feature/ui/data-access/util/model/api libs to understand how the pieces fit
together - not just what any single file does in isolation.

Produce a Markdown document covering:

1. **{{SCOPE}} overview** - what this app is for, its major features/pages, and how its libs are
   organized (feature/ui/data-access/util/model/api or whatever the actual layering is).
2. **Structural rules and conventions** - the layering/dependency-direction rules {{SCOPE}}'s libs
   follow (and are constrained to via module-boundary tags), naming conventions, and anything that
   would make a proposed change to {{SCOPE}} non-compliant if violated.
3. **Key subsystems within {{SCOPE}}** - grouped by responsibility (e.g. a specific feature area or
   workflow), each with what it owns, its state-management approach, and which other {{SCOPE}} libs
   or shared/cross-cutting libs it depends on.
4. **Cross-cutting dependencies** - which `libs/shared/**` (or other domain) libraries {{SCOPE}}
   actually consumes, and for what.
5. **Notable constraints/gotchas** - anything a new initiative inside {{SCOPE}} would need to account
   for (known architectural debt, migration-in-progress areas, non-obvious coupling).

Ground every claim in what you actually found in the code/config - if something can't be determined,
say so rather than guessing. Do not attempt to enumerate every single file; group and generalize
where that gives a truer picture of {{SCOPE}}'s architecture than an exhaustive list would.
