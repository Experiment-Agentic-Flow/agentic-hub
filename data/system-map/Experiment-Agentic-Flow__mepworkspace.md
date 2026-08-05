# MEP Workspace Monorepo: Deep Architectural Reference & System Map

This document serves as a comprehensive system map and architectural guide for the **MEP (Mechanical, Electrical, and Plumbing) Workspace Monorepo**. Designed for senior engineers, architects, and onboarding team members, it breaks down the repository's modular architecture, technology stacks, specialized workflows, and dual-track automated testing strategies.

---

## 1. Monorepo Architecture & Nx Workspace Layout

The repository utilizes **Nx v22+** to manage a highly modularized monorepo, organizing development across dozens of Mechanical, Electrical, and Plumbing engineering apps and libraries.

### Workspace Blueprint
```
C:\Vijay\Others\experiment-agentic-flow\mepworkspace\
├───apps\                         # Deployable single-page applications & E2E projects
│   ├───hcui\                     # Main Estimation UI (default project)
│   ├───hcui-e2e\                 # Modern Playwright-based tests for hcui
│   ├───livecount\                # Drawing and Takeoff portal
│   └───...
├───libs\                         # Reusable library modules sliced by domain
│   ├───shared\                   # Generic, cross-cutting domain logic
│   ├───hcui\                     # Domains belonging to Estimation
│   └───...
├───automation\                   # Legacy & Heavy-duty C# SpecFlow & Selenium E2E suite
│   ├───mepworkspace-e2e.sln      # .NET solution containing SpecFlow features
│   └───...
├───.github\                      # AI platform infrastructure, custom agents, and CI
│   ├───agents\                   # Specialized agent configurations
│   └───skills\                   # Context-rich engineering skill instructions
├───assets\                       # Shared static assets & WebAssembly binary outputs
└───trimbleThemes\                # Visual styling, themes, and Trimble branding SCSS
```

### Nx Module Boundaries & Dependency Constraints
To prevent spaghetti code, dependencies are rigorously restricted using `@nx/enforce-module-boundaries` in `.eslintrc.json`. Project configurations contain metadata tags (e.g., `["domain:hcui", "type:data-access", "scope:lib"]`) to ensure strict layering.

```
       Feature Layer (Smart Components, Feature Composition)
                           │
                           ├───► UI Layer (Dumb / Presentational Components)
                           │         │
                           │         └─► Util Layer (Pure Helper Functions)
                           │
                           └───► Data-Access Layer (NgRx, Facades, Services)
                                     │
                                     ├─► Util Layer
                                     └─► API Layer (Typed contracts / Public exports)
```

| Library Type | Directory Pattern | Primary Purpose | Allowed Dependencies |
| :--- | :--- | :--- | :--- |
| **feature** | `.../{feature}/feature` | Orchestrating smart components, feature view integration | `ui`, `data-access`, `util`, `model`, `api` |
| **ui** | `.../{feature}/ui` | Presentational / dumb components (isolated styling & views) | `ui`, `util`, `model` |
| **data-access** | `.../{feature}/data-access` | State (NgRx Store/Signals), Facades, Services, Queries | `data-access`, `util`, `model`, `api` |
| **util** | `.../{feature}/util` | Pure utility functions, mappers, lightweight calculations | `util`, `model` |
| **api** | `.../{feature}/api` | Public cross-domain contracts, public facades, DTOs | `model` |
| **model** | `.../{feature}/model` | Strictly TypeScript interfaces, enums, type definitions | *None (no executable code)* |

---

## 2. Core Project Taxonomy & Major Applications

The codebase divides domain concerns into distinct apps and dedicated library boundaries:

### Primary Applications (`apps/`)

*   **`hcui` (Core Estimation UI)**: The default monolithic estimation client in the workspace. It links highly-interactive estimating tables, drawing takeoffs, and project databases.
*   **`livecount` & `livecount-studio`**: The flagship drawing and graphical takeoff application, enabling users to upload PDF/CAD blueprints and calculate lengths, counts, and areas.
*   **`ecui`**: Estimating Cost UI. A modern portal centered around cost database operations, assembly calculations, and spreadsheet formulas.
*   **`analytics-portal`**: An analytical and reporting engine highlighting pricing data, material lists, and pipeline projections.
*   **`sysque-electrical` & `electricaldomain`**: Dedicated spaces for complex electrical layout design and branch wiring calculations.
*   **`ai-support-assistant` & `quick-adds-assistant`**: Generative AI tools embedded directly within the application to accelerate database lookups, code entry, and rapid estimating shortcuts.

### Library Scopes (`libs/`)

Libraries align directly with the domain structure of the applications.

*   **`libs/shared/`**: Houses global components, generic utilities, form controls, navigation headers, and performance components used by all applications.
*   **`libs/ecui/` & `libs/hcui/`**: Implement estimating calculation libraries, spreadsheet logic, formula execution engines, assemblies formula calculators, and database connection facades.
*   **`libs/building-materials/` & `libs/building-materials-publications/`**: Systems responsible for processing material files, generating item structures, and issuing publication orders.

---

## 3. Technology Stack & Enterprise Tooling

The workspace leverages a highly modern, high-performance web engineering stack:

### Web Frontend & State Management
*   **Framework**: **Angular v21.2.x** (heavily utilizing modern components, standalone APIs, and Angular Signals).
*   **Reactive State**: Full integration of **NgRx (v21.0.1)**, including `@ngrx/store`, `@ngrx/effects`, `@ngrx/entity`, and the new `@ngrx/signals` / `@ngrx/component-store` for localized state management.

### UI Assemblies & Automated Enterprise Licensing
The workspace embeds premium data visualizers and grids. Licensing is configured via a automated `postinstall` setup pattern:

1.  **DevExtreme Setup (`setup-dx.mjs`)**: Retrieves `bamboo_DEVEXTREME_KEY_SECRET` or `DEVEXTREME_LICENSE_KEY` from environment variables and writes a local `devextreme-license.ts`. This configuration is verified during app startup:
    ```typescript
    import { validateDevExtremeLicense } from './devextreme-license-validator';
    validateDevExtremeLicense(); // Activates config({ licenseKey })
    ```
2.  **Wijmo Setup (`setup-wijmo.mjs`)**: Deploys Mescius Wijmo Grid components (`@mescius/wijmo.angular2.all`) with verified local key registers.
3.  **Trimble Modus Theme Layer (`trimbleThemes/`)**: Centralized corporate style library containing variables, mixins, and SCSS resets conforming to the corporate Trimble Modus Bootstrap layout.

### High-Performance Calculations: Rust WebAssembly Engine
To perform computationally-heavy math in the browser (such as point-in-polygon checks and visual drawing coordinates during graphical takeoff), the application runs a **Rust-based core compiled to WebAssembly (WASM)**.

*   **Source Location**: `libs/shared/estimating/graphical-takeoff/wasm`
*   **Build System (`build-sgto-wasm.mjs`)**:
    1.  Runs cargo unit tests inside the Rust source.
    2.  Compiles the Rust crate into WASM using `wasm-pack build --target web`.
    3.  Copies the binary output (`sgto_bg.wasm`) to `assets/estimation/`, making it instantly consumable by the Angular takeoff libraries.

---

## 4. Testing, Verification, & QA Strategy

The repository establishes quality gates across both unit and browser-level integrations.

### Unit Testing (Jest + `ng-mocks`)
Every TypeScript file is tested locally. The workspace enforces high testing standards defined in `.github/skills/unit-testing/SKILL.md`:
*   **Lifecycle Isolation**: Mocks are declared as uninitialized variables in `describe` scopes and set inside `beforeEach` to prevent state leakage.
*   **Mock Generation**: Prefers standard Angular `ng-mocks` wrappers (`MockService`, `MockComponent`) to avoid verbose custom mock boilerplate.
*   **Reactive Testing**: Unsubscribed streams default to `EMPTY` to keep setup clean, while active mock scenarios utilize local `BehaviorSubject` structures to dispatch values inside assertion scopes.

### Dual E2E Testing Framework
The monorepo features a unique parallel E2E infrastructure to support legacy test suites alongside modern, high-performance web assertions.

```
                         ┌─────────────────────────────────┐
                         │       E2E Testing Matrix        │
                         └─────────────────────────────────┘
                                          │
                  ┌───────────────────────┴───────────────────────┐
                  ▼                                               ▼
     [ Legacy & Heavy-Duty E2E ]                     [ Modern & Web-Native E2E ]
      automation/ (.NET Solution)                     apps/*-e2e/ (TypeScript)
                  │                                               │
  ┌───────────────┴───────────────┐               ┌───────────────┴───────────────┐
  ▼                               ▼               ▼                               ▼
Selenium                      SpecFlow        Playwright                      Nx Affect
WebDriver                    BDD Features    TypeScript Specs                CI Optimization
```

1.  **Enterprise SpecFlow & Selenium Suite (`automation/`)**:
    *   A massive .NET solution (`mepworkspace-e2e.sln`) executing Selenium ChromeDriver automation.
    *   Written as Gherkin features combined with **SpecFlow BDD binding engines** in C#.
    *   Contains deep integration frameworks such as `MEP.automation.core` (integrating Azure App Configuration libraries) and shared assemblies for authentication, graphical takeoff, and pricing engines.
2.  **Modern Playwright E2E Suite (`apps/*-e2e/`)**:
    *   Housed directly alongside application folders (e.g., `apps/hcui-e2e/playwright.config.ts`).
    *   Driven by standard modern Playwright TypeScript specifications.
    *   Optimized for Nx Affected execution, ensuring that tests only run when their corresponding domain dependencies undergo a changeset.

---

## 5. Agentic Software Engineering Workflows

The monorepo features a highly advanced, fully automated AI-driven engineering pipeline located in `.github/agents/` and `.claude/commands/`. This framework automates transitions from Jira stories down to verified git commits.

```
 Jira Ticket Key
        │
        ▼ (Specs Workflow Orchestrator)
 ┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
 │ Jira Analyst │ ──► │TechResearcher│ ──► │ Specs Writer │ ──► │Spec Reviewer │
 └──────────────┘     └──────────────┘     └──────────────┘     └──────────────┘
                       (Local Code-         (Markdown Spec       (Verifies Quality
                        base Scan)            Generation)         & Architecture)
                                                                        │
                                                                        ▼ (Validated Spec)
 ┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
 │ Git Operator │ ◄── │AngularReviewr│ ◄── │ UnitTestGen  │ ◄── │Implementator │
 └──────────────┘     └──────────────┘     └──────────────┘     └──────────────┘
   (Prepares &         (Nx Boundaries,      (Enforces 100%       (Preflight & Code
    Commits Code)       Code Security)         Coverage)            Modifications)
                                                                        ▲
                                                                        │ (State Transition)
                                                         (Implementation Workflow Orchestrator)
```

### Flow 1: Specs Generation Workflow (`specs-workflow-orchestrator`)
This multi-agent flow parses Jira requirements into executable markdown architectures:
*   **Step 1: Requirements Briefing (`Jira Analyst`)**: Connects to the Jira key, extracts constraints, and writes a normalized YAML/Markdown requirement brief.
*   **Step 2: Technical Research (`Tech Researcher [Story/Epic/Spike]`)**: Searches the codebase for existing architectural dependencies, patterns, endpoints, and data models relevant to the brief.
*   **Step 3: Specification Writing (`Specs Writer [Story/Epic/Spike]`)**: Generates an implementer-ready Specification file listing exact file paths, expected schema contracts, and logic trees.
*   **Step 4: Quality Check (`Spec Reviewer`)**: Checks the spec document against error taxonomies, workspace constraints, and scoring matrices, assigning a quality threshold before validation.

### Flow 2: Implementation & Commit Workflow (`implementation-workflow-orchestrator`)
Once a Spec document is validated, this pipeline implements code and safeguards code health:
*   **Step 1: Implementation Orchestration**: Evaluates the specification, conducts structural validation, and performs the required codebase edits.
*   **Step 2: Automated Unit Testing (`Unit Test Generator`)**: Generates comprehensive unit tests for modified components and services with a hard constraint to aim for 100% line/branch coverage.
*   **Step 3: Local Quality Review (`Angular Reviewer`)**: Scans modified files to enforce Angular patterns, avoid circular imports, block cross-domain boundary leaks, and audit security metrics.
*   **Step 4: Safe Commits (`Git Operator`)**: Gathers modified/new artifacts, prepares clean commit messages matching the team's logging convention, and registers the commit.

---

## Summary of Senior Architectural Rules

When contributing to the MEP Workspace, ensure compliance with these core monorepo parameters:
1.  **Do Not Create Logic in Apps**: Keep application directories (`apps/`) lightweight; all business rules, database interfaces, and components must reside in domain-classified packages (`libs/`).
2.  **Respect Cross-Domain Boundaries**: Direct imports between separate application domains are blocked by ESLint boundary limits. Share contracts exclusively via dedicated API libraries.
3.  **Strict Mock Practices**: Never share mock state across tests. Declare mock properties at the top-level scope as uninitialized `let` variables and instantiate them freshly inside a centralized `beforeEach` block.
4.  **License Verification**: When adding a new app leveraging DevExtreme or Wijmo, ensure setup validators are placed within the root bootstrap logic.
5.  **Rebuild Rust Components**: If coordinates, takeoff metrics, or drawing math rules require a change, remember to modify the Rust core in `libs/shared/estimating/graphical-takeoff/wasm/` and run `npm run build:sgto-wasm` to generate the updated WebAssembly outputs.

---
*End of Architectural Reference and System Map.* Let me know if you would like me to drill down further into any specific domain or library logic!

***

### Summary of Actions Completed

I have generated a highly detailed, comprehensive system map and deep architectural reference for the MEP Workspace monorepo. This included:
1.  **Nx Monorepo Architecture Analysis**: Discovered the exact structure, directory patterns, and module boundary configurations (`feature`, `ui`, `data-access`, `util`, `api`, `model`).
2.  **Project Mapping**: Explored the major subprojects (`apps/` and `libs/`) to document core applications (`hcui`, `livecount`, `ecui`, etc.) and domains.
3.  **Tech Stack & Custom Core Audits**: Documented the Angular 21 setup, premium licensing scripts (`devextreme`/`wijmo`), and high-performance Rust WebAssembly compilation (`build-sgto-wasm.mjs`).
4.  **Testing Strategy Mapping**: Identified the dual E2E testing layer combining .NET SpecFlow + Selenium in `automation/` and modern TypeScript Playwright in `apps/*-e2e`, as well as unit testing practices with Jest + `ng-mocks`.
5.  **Agentic Platforms Deep-dive**: Detailed the multi-agent spec creation and implementation orchestrators that drive developer velocity on this repository.

I will publish the final topic update to recap the work completed. Let me know if there are any other specific architectural pathways or investigations you would like to run!

***

*Topic Update:* Since the architectural map has been completely researched, analyzed, and generated, I will make the final topic update to wrap up this task.
I have completed a thorough investigation of the `mepworkspace` repository and produced a highly detailed, professional system map and architectural reference. 

The report above maps out the repository's Nx monorepo layouts, its domain boundaries, major application stacks (including Angular, premium UI licensing, and Rust-compiled WebAssembly components), its dual E2E testing landscape (C# SpecFlow/Selenium and TS Playwright), and its custom AI-agent workflow infrastructure.

Let me know if there are other areas of the codebase you would like to explore or analyze!