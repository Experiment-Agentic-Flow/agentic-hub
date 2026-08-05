# MEP Workspace System Map

This document provides a deep architectural reference for the `mepworkspace` monorepo. It is designed to equip engineers and architects with the context required to design broad, cross-cutting Epics across the Mechanical, Electrical, and Plumbing (MEP) product suite. 

---

## 1. Product Overview

The `mepworkspace` is a massive Angular/Nx monorepo housing Trimble's web-based solutions for the MEP construction lifecycle. It provides end-to-end tooling that moves a construction project from digital blueprints and cost estimation into procurement, design, and ultimately, physical shop-floor fabrication. 

### Major Applications
Rather than isolated tools, these applications operate as a unified suite built on a shared platform:

- **Estimation MEP (`apps/hcui`) & Estimation Construct (`apps/ecui`)**: The core web-based estimating platforms for mechanical/plumbing (`hcui`) and electrical/general construction (`ecui`). Users build highly detailed bids using massive, industry-standard databases of labor rates and material costs.
- **LiveCount (`apps/livecount`)**: A cloud-based graphical takeoff solution. It allows estimators to upload PDF blueprints, calibrate scales, and visually count/measure runs to quantify materials (e.g., linear feet of pipe, number of fittings). It integrates directly into the Estimating apps.
- **Supplier Xchange (`apps/sxui`)**: A procurement and supply chain platform. Once an estimate is won, `sxui` connects contractors with integrated distributors to get real-time price files, manage quotes, and place orders. 
- **Corsa (`apps/fabui` & `apps/fabui-design`)**: The fabrication management software (Trimble FabShop equivalent). It takes detailed 3D models and work packages, generates Bills of Materials (BOM), and interfaces with shop floor machinery for duct and pipe fabrication.
- **Electrical Domain (`apps/electricaldomain`)**: An engineering application for performing advanced electrical calculations (e.g., load analysis, single-line diagrams, distribution board sizing, and protective device selection).
- **Admin Assist Portal (`apps/admin-assist-portal`)**: The back-office administration portal for configuring branches and managing distributor integrations for the Supply Chain products.

---

## 2. End-to-End Workflows

The monorepo's architecture is designed to support the flow of data through the construction lifecycle. Here are the primary user journeys and how they map to the codebase:

### Workflow A: The Estimating & Takeoff Journey
**Product Step:** An estimator receives digital blueprints and needs to determine how much material is required and what it will cost.
1. **Drawing Upload & Scaling**: The user uploads PDFs into the cloud platform. (App: `livecount` / Lib: `shared/estimating/project-files`).
2. **Graphical Takeoff**: The user clicks to count fixtures and draws lines to measure conduit/pipe runs. Complex vertical routing is handled via "Adders" and "Elevations". (App: `livecount` / Lib: `shared/estimating/graphical-takeoff` and `shared/estimating/annotations`).
3. **Cost Application**: The measured quantities are automatically synced to the estimating tool. The software applies labor units and material costs based on pre-built assemblies. (App: `hcui` or `ecui` / Lib: `shared/estimating/content-provider/item-library`).
4. **Bid Finalization**: The estimator reviews the Work Breakdown Structure (WBS), adds overhead/profit margins, and generates the final bid proposal. (Lib: `hcui/bid-breakdowns`, `hcui/wbs`).

### Workflow B: Procurement & Supply Chain
**Product Step:** The contractor wins the bid and needs to actually buy the materials at the best price.
1. **Requisition Generation**: The estimate's bill of materials is converted into a procurement job. (App: `sxui` / Lib: `sxui/procurement-projects`).
2. **Live Pricing Integration**: The contractor connects their list to specific suppliers (managed by `admin-assist-portal`). 
3. **Order Management**: Quotes are compared, and purchase orders are dispatched directly to the distributors. (App: `sxui` / Lib: `sxui/quotes-and-orders`).

### Workflow C: Shop Floor Fabrication
**Product Step:** For mechanical contractors, custom sheet metal ducts or pipe spools must be manufactured in their own shop before arriving on site.
1. **Work Packaging**: Detailers chunk the project into manageable work packages. (App: `fabui` / Lib: `fabui/work-packages`).
2. **3D Visualization & BOM**: Workers visualize the 3D assemblies and review the Bill of Materials. (App: `fabui-design` / Lib: `fabui/bill-of-materials`, `fabui-design/viewer-3d`).
3. **Machine Export**: Data is prepared for CNC machines on the shop floor. 

---

## 3. Structural Rules and Conventions

Any new Epic must adhere strictly to the established **Nx modularity boundaries**. Violating these layering rules will fail architectural CI checks (`nx lint` boundary constraints).

**Dependency Layering (`apps` -> `feature` -> `ui` / `data-access` -> `util` / `model`)**:
- **`apps/`**: Extremely thin routing shells. They simply bootstrap the environment and lazy-load feature libraries.
- **`libs/.../feature`**: Smart, routed components that orchestrate state, data access, and UI. *Can depend on `ui`, `data-access`, and `util`.*
- **`libs/.../ui`**: "Dumb" presentational components. Must have zero knowledge of business logic, state, or APIs. *Cannot depend on `feature` or `data-access`.*
- **`libs/.../data-access`**: Services, API wrappers, and NgRx State management. *Cannot depend on `feature`.*
- **`libs/.../util` & `model`**: Pure functions, TS interfaces, constants. *Zero dependencies on higher layers.*

**Additional Constraints**:
- **No Circular Dependencies**: Strictly enforced.
- **Shared Scope (`libs/shared/*`)**: Must only be used for code consumed by *two or more* distinct applications. If a feature is only used by `hcui`, it belongs in `libs/hcui/`.

---

## 4. Key Subsystems/Domains

### `shared/estimating` (The Core Engine)
**Responsibility**: The heavyweight algorithmic heart of the monorepo. It powers drawing rendering, annotation math, multi-page measurement resolution, and item pricing logic.
**Capabilities**:
- **Shared Graphical Takeoff (SGTO)**: Features a WebAssembly (`wasm`) module that drives high-performance 2D WebGL/Canvas rendering (`shared/estimating/graphical-takeoff`). 
- **Annotations & Measurements**: Complex models for "Adders" and "Elevations" (handling 3D verticality on 2D floor plans) and handling multi-page runs where a pipe continues on the next page (`shared/estimating/annotations`).
**Dependencies**: Strongly decoupled from specific applications. `livecount`, `hcui`, and `ecui` all depend heavily on this domain. 

### `shared/platform` (Core Infrastructure)
**Responsibility**: Cross-cutting application infrastructure required to bootstrap any app in the suite.
**Capabilities**: Authentication (`mep-authenticate`), authorization, Feature Flags, LogRocket session recording, and core Terms of Service compliance.

### `hcui/takeoff` & `ecui/shared/estimates` (Estimate Orchestration)
**Responsibility**: Bridging the raw quantities derived from `shared/estimating` with real-world financial and labor data. 
**Capabilities**: Work Breakdown Structure (WBS) management, typicals, bid breakdown generation, labor/equipment databases, and formula engines for deriving costs.

### `sxui` (Supply Chain / Trade Service)
**Responsibility**: Procurement data flow.
**Capabilities**: Processing massive price files (`sxui/price-file-processing`), managing contractor profiles (`sxui/manage-contractors`), and job analysis. 

---

## 5. Cross-Cutting Patterns

- **State Management**: **NgRx** is universally mandated. 
  - *Global State*: Standard `@ngrx/store`, `@ngrx/effects`, and `@ngrx/entity` are used for cross-application/cross-feature state (e.g., active user, loaded project).
  - *Local State*: `@ngrx/component-store` is used extensively for localized, smart-component state to avoid polluting the global store.
- **Testing (Strict Mandate)**: 
  - **100% Code Coverage**: The workspace enforces `100%` coverage (branches, functions, lines, statements) globally via Jest (`jest.config.mts`). Epics must account for rigorous unit testing time; leaving an `if` branch uncovered is not allowed.
  - **No Real HTTP**: `HttpTestingController` must be used. Real HTTP calls in tests are banned.
  - **No Silent Skips**: Skipping tests (`xit`) without a linked tracking ticket (e.g., `// TODO(HON-1234)`) is prohibited.
- **UI Frameworks**: The standard UI language is implemented via Trimble Modus Web Components and Modus Icons.
- **Security Protocols**: 
  - Storing secrets/JWTs in `environment.ts` is explicitly banned due to XSS extraction risks.
  - Angular's native auto-escaping `{{ }}` is mandatory; bypassing security (`bypassSecurityTrustHtml`) triggers immediate flags unless heavily justified.
  - RxJS subscriptions must actively prevent memory leaks via `takeUntilDestroyed()`.

---

## 6. Notable Constraints & Gotchas

Any new initiative must account for the following technical realities:

1. **WASM Build Pipeline**: The Graphical Takeoff engine uses WebAssembly (built via `build-sgto-wasm.mjs`). Changes to the low-level rendering or geometry math will require understanding this WASM bridge, and developers must ensure the `sgto` module compiles correctly.
2. **Node Heap Limits**: The monorepo is massive. Building applications (especially `hcui`) locally or in CI *will fail* with a JavaScript heap out-of-memory exception unless `NODE_OPTIONS=--max-old-space-size=8192` is set. 
3. **Commercial Component Licensing**: The platform utilizes DevExpress (DevExtreme) and Mescius (Wijmo) UI components (especially for high-performance data grids and Excel exports). Developers must have valid `DEVEXTREME_LICENSE_KEY` and `WIJMO_LICENSE_KEY` environment variables set to run the applications locally, which are validated at runtime in `app.component.ts`. 
4. **Complex Multi-Window Architecture (SGTO)**: The estimating takeoff experience supports a "Primary" drawing window and multiple "Secondary" (detached) drawing windows (used by users with multi-monitor setups). The architecture uses `BroadcastChannel` APIs under the hood to synchronize drawing state across browser tabs. New features interacting with the takeoff canvas must be designed to safely replicate across these detached windows.
5. **E2E Testing Split**: While unit tests use Jest, E2E testing utilizes modern Playwright (`apps/*-e2e`). However, there is also a legacy C# Solution (`automation/mepworkspace-e2e.sln`) which implies that certain broader integration or legacy flows rely on a .NET testing environment.