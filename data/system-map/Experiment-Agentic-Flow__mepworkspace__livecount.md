Here is the comprehensive system map for the **LiveCount** application and its dependency closure within the MEP Workspace monorepo.

# LiveCount System Map

## 1. Product Overview
LiveCount is a web-based construction estimation and quantity takeoff application designed for MEP (Mechanical, Electrical, and Plumbing) professionals. It solves the business problem of accurately extracting and aggregating material quantities (lengths, areas, item counts) directly from 2D architectural drawings (PDFs) and 3D building models. 

Its users are typically estimators who need to quantify materials for a job to build an accurate bid or estimate. LiveCount operates in two distinct operational modes:
1. **Standalone Web Application**: Users access LiveCount directly via a browser, allowing them to navigate through Customers, Projects, and Jobs before performing takeoff.
2. **Embedded Integration**: LiveCount is heavily designed to be embedded within other Trimble host applications (most notably **Accubid Classic** and **Trimble Cloud Console**). In this mode, the host application manages the project/job context, and LiveCount is loaded into an embedded Chromium browser (historically supporting versions as old as Chromium 67) to provide the graphical takeoff interface directly alongside the host's estimating grid.

## 2. End-to-End Workflows

### Authentication and Context Initialization
- **Workflow**: A user attempts to access the application. If standalone, they are directed to Trimble Identity for login. If embedded within a host application like Accubid, an authentication code or token is passed directly via the URL to seamlessly log them in. 
- **Subsystems**: 
  - `libs/shared/platform/mep-authenticate/feature` (handles standard login and guards).
  - `apps/livecount/src/app/login/livecount-embed-login.component` (specialized handling for embedded host integration).

### Job Selection and Preparation (Standalone Mode)
- **Workflow**: The user selects a Customer/Region, navigates to a Project, and then opens a specific Job. 
- **Subsystems**:
  - Route guards (`with-valid-selected-customer-and-region.guard`, `with-selected-project.guard`, `with-standalone-browser-app.guard`) enforce this flow.
  - `libs/livecount/projects/feature` and `libs/livecount/jobs/feature` provide the UI and state for selecting the working context. 

### 2D Graphical Takeoff (Drawing Measurement)
- **Workflow**: The user opens a 2D PDF drawing. They select a measurement tool (e.g., Length, Area, Count, or Auto-Count pattern search) from a floating toolbar, scale/calibrate the drawing, and click/drag on the drawing canvas to draw annotations.
- **Subsystems**: 
  - `libs/shared/estimating/drawings/feature` (loads the drawing list and viewport).
  - `libs/shared/estimating/graphical-takeoff/feature` (provides the layout, toolbars, and Fabric.js canvas components).
  - `libs/shared/estimating/graphical-takeoff/data-access` (the heavy 2D engine that processes Fabric.js canvas events, manages the `active-canvas` state, and translates user clicks into model data like `takeoff-polygon` or `takeoff-line`).

### 3D Model Takeoff
- **Workflow**: If the 3D Quantity Takeoff feature flag is active, the user opens a 3D model instead of a 2D drawing. They navigate the 3D space and select model elements to generate quantity counts.
- **Subsystems**:
  - `libs/shared/feature-flags/data-access` (checks `LC_3dQuantityTakeoff`).
  - `libs/livecount/connect-viewer/feature` (embeds and orchestrates the Trimble Connect 3D viewer).

### Quantity Aggregation and Grid Management
- **Workflow**: As the user draws annotations in 2D or selects elements in 3D, the resulting quantities are aggregated in real-time in a tabular data grid occupying the bottom half of a split-screen view. The user can define, merge, or modify these takeoff items directly in the grid.
- **Subsystems**:
  - `libs/livecount/quantity-takeoff/feature` (contains the `TakeoffContainerComponent` which orchestrates the split-screen view, embedding either the 2D canvas or 3D viewer on top, and the `TakeoffManagerOverviewComponent` on the bottom).
  - `libs/livecount/quantity-takeoff/ui` (provides the DevExtreme `DxDataGrid` wrappers for the takeoff grid).

### Data Synchronization
- **Workflow**: Takeoff modifications (additions, deletions, edits) are synchronized continuously with the backend orchestrator to ensure the host estimating system stays up to date.
- **Subsystems**:
  - `libs/livecount/quantity-takeoff-signalr/data-access` (maintains real-time WebSockets via SignalR hubs like `QuantityTakeoffHub` and `OrchestratorHub` to push/pull live takeoff data and model conversion progress).

## 3. LiveCount Technical Overview

LiveCount adheres to the workspace's strict Nx Domain-Driven Design architecture. 

The `apps/livecount` folder is an extremely thin application shell. Its primary responsibilities are bootstrapping Angular, validating global licenses (DevExtreme/Wijmo), defining the top-level route array (`app-routing.module.ts`), and setting up environment configurations for different deployments (dev, prod, staging, lc-migration, etc.).

All actual business logic is pushed down into libraries, organized by domain (`livecount` vs `shared/estimating` vs `shared/platform`) and then layered by architectural `type`:
- **`type:feature`** (e.g., `libs/livecount/quantity-takeoff/feature`): Contains routable components, smart container components, and UI orchestration. These libraries import `data-access` and `ui` libraries to wire state to presentation.
- **`type:data-access`** (e.g., `libs/shared/estimating/graphical-takeoff/data-access`): Contains NgRx Actions, Reducers, Selectors, Effects, Facades, and heavy application services (like the Fabric.js canvas manager or SignalR hub connections).
- **`type:ui`** (e.g., `libs/livecount/quantity-takeoff/ui`): Contains pure, "dumb" presentation components (often wrapping DevExtreme).
- **`type:api` / `type:model`**: Provide strict TypeScript interfaces, enums, and data contracts that bridge domains without causing circular dependencies.

## 4. Structural Rules and Conventions

Any new initiative scoped to LiveCount must obey the following workspace architectural rules, strictly enforced by `@nx/enforce-module-boundaries` in `.eslintrc.json`:

1. **Unidirectional Type Layering**: 
   - `type:ui` may only depend on `type:ui`, `type:util`, and `type:model`. It cannot inject NgRx state or API calls.
   - `type:data-access` may only depend on `type:data-access`, `type:util`, `type:model`, and `type:api`. It cannot depend on any UI or Feature components.
   - `type:api` may only depend on `type:model`.
   - `type:feature` (implicitly) sits at the top and can orchestrate the layers below it.
2. **Component Conventions**:
   - Angular components must use the `mep-` prefix for element selectors and camelCase `mep` for directive selectors.
   - Modules must follow standard Nx naming (e.g., `LivecountQuantityTakeoffFeatureModule`).
3. **State Management**:
   - All complex state must be managed via NgRx. Cross-domain state interaction should be mediated through Facade services or Actions/Selectors, never by directly mutating state across boundaries.

## 5. Key Subsystems within LiveCount

### Quantity Takeoff Manager (`libs/livecount/quantity-takeoff/*`)
- **Responsibility**: The heart of LiveCount's user interface. It provides the split-screen layout (`TakeoffContainerComponent`) that marries the drawing/model viewer with the tabular data grid of measured quantities. It handles workflows like "Define Takeoff Items" and "Merge Takeoff Items".
- **State Management**: NgRx (`QuantityTakeoffDataAccessModule`). 
- **Dependencies**: Tightly integrates with `shared/estimating/graphical-takeoff/feature` (for the 2D view), `livecount/connect-viewer/feature` (for the 3D view), and `shared/estimating/grid-views/feature`. 

### Graphical Takeoff Engine (`libs/shared/estimating/graphical-takeoff/*`)
- **Responsibility**: The core 2D measurement engine. It handles rendering PDFs/images onto an HTML5 canvas and provides all the interactive tools (Length, Area, Count, Scale Calibration, Auto-Count). 
- **State Management**: Highly complex. Uses a mix of NgRx for application-level state and a heavy object-oriented framework (`canvas-manager.ts`, `active-canvas.ts`, `events.processor.ts`) wrapping `Fabric.js` for high-performance canvas state.
- **Dependencies**: Relies heavily on third-party `fabric.js` and `pdfjs-dist`.

### SignalR Sync Engine (`libs/livecount/quantity-takeoff-signalr/data-access`)
- **Responsibility**: Maintains persistent WebSocket connections to the backend for real-time collaborative estimating and host-application synchronization. 
- **State Management**: Uses NgRx Effects (`quantity-takeoff-signalr.effects.ts`) to listen to local state changes and dispatch them over the `QuantityTakeoffHub`, and conversely dispatches NgRx actions when events are received from the `OrchestratorHub`.

### Connect Viewer (`libs/livecount/connect-viewer/feature`)
- **Responsibility**: Provides the 3D model viewing capability by embedding Trimble Connect's 3D viewer iframe and bridging its events into the LiveCount data flow.

## 6. Cross-Cutting Dependencies

LiveCount is not an isolated silo; it acts as a host application that consumes heavily from the `libs/shared` domains:
- **`libs/shared/estimating/**`**: LiveCount consumes standard estimating concepts across the monorepo, primarily `drawings`, `annotations`, `autocount`, `estimates`, and `schedules`. The graphical takeoff engine itself lives in `shared` because its underlying canvas capabilities might be consumed by other apps, even if LiveCount is its primary user.
- **`libs/shared/platform/**`**: Provides core infrastructural capabilities like `mep-authenticate` (Trimble ID), `mep-license` (validation), `gainsight` / `logrocket` (analytics and telemetry), and `mep-chat-bot`.
- **`libs/shared/user-interface/**`**: Provides the shared MEP design system wrappers, including `mep-grid`, `mep-dialog`, `mep-spinner`, and `mep-chips`.

## 7. Notable Constraints and Gotchas

An engineer designing a new feature for LiveCount must account for the following architectural constraints:

1. **Embedded Chromium Environment**: Because LiveCount is embedded inside Accubid Classic using older Chromium wrappers (e.g., Chromium 67 for Accubid Classic 15), **modern CSS/JS features must be used with extreme caution**. The application explicitly maintains build configurations (e.g., `npm run build-livecount:dev-local`) to test output against older browser engines. Do not assume modern Web APIs (like `ResizeObserver` or advanced CSS Grid capabilities) will work flawlessly without polyfills or fallback testing.
2. **Split-Brain State (NgRx vs Fabric.js)**: The `graphical-takeoff` subsystem maintains state in two places: the reactive NgRx store and the imperative `Fabric.js` canvas object model. Code modifying takeoff annotations must ensure both the canvas objects and the NgRx store remain in absolute sync. Direct mutation of the canvas without dispatching corresponding NgRx actions will cause grid desynchronization.
3. **Heavy Third-Party License Validation**: LiveCount depends on DevExtreme for its complex data grids and Wijmo. Both require strict initialization routines (`validateDevExtremeLicense()`, `validateWijmoLicense()`) that must run before the application bootstraps. 
4. **Feature Flag Routing**: Major structural changes to the application (like 3D quantity takeoff) are deeply embedded into the routing layer via feature flag guards (`featureFlagGuard: { name: 'LC_3dQuantityTakeoff' ... }`). New high-level workflows should follow this pattern to allow safe, targeted rollouts.

---

## Appendix: livecount Resolved Dependency Closure

Full, code-resolved list (from real `@hcworkspace/*` imports, not name-guessing or LLM summarization) - 136 lib(s):

- App: `apps/livecount`
- `libs/shared/estimating/annotations/tokens`
- `libs/shared/estimating/autocount/tokens`
- `libs/shared/estimating/drawings/tokens`
- `libs/shared/estimating/drawing-compare/tokens`
- `libs/shared/estimating/estimates/tokens`
- `libs/shared/estimating/symbol-points/tokens`
- `libs/shared/platform/terms-of-service/tokens`
- `libs/shared/application-settings/tokens`
- `libs/livecount/quantity-takeoff/tokens`
- `libs/shared/platform/mep-authenticate/tokens`
- `libs/shared/platform/mep-license/tokens`
- `libs/shared/estimating/content/assembly-library/tokens`
- `libs/shared/estimating/schedules/tokens`
- `libs/shared/content/list-management/tokens`
- `libs/livecount/jobs/feature`
- `libs/livecount/models/feature`
- `libs/livecount/projects/feature`
- `libs/livecount/quantity-takeoff/feature`
- `libs/livecount/utilities/routing`
- `libs/shared/platform/mep-authenticate/feature`
- `libs/shared/application/navigation/model`
- `libs/shared/estimating/attachments/feature`
- `libs/shared/estimating/drawings/feature`
- `libs/shared/estimating/estimates/feature`
- `libs/shared/legacy/utils-common`
- `libs/shared/platform/mep-license/feature`
- `libs/shared/platform/projects/feature`
- `libs/shared/utilities/routing`
- `libs/livecount/message/data-access`
- `libs/shared/platform/mep-authenticate/data-access`
- `libs/shared/application-settings/data-access`
- `libs/shared/application/navigation/data-access`
- `libs/shared/estimating/estimates/data-access`
- `libs/shared/feature-flags/api`
- `libs/shared/platform/gainsight/util`
- `libs/shared/platform/logrocket/data-access`
- `libs/shared/platform/projects/data-access`
- `libs/shared/platform/projects/model`
- `libs/shared/feature-flags/model`
- `libs/livecount/connect-viewer/feature`
- `libs/livecount/jobs/data-access`
- `libs/livecount/models/data-access`
- `libs/livecount/projects/data-access`
- `libs/livecount/quantity-takeoff-signalr/data-access`
- `libs/livecount/quantity-takeoff/data-access`
- `libs/shared/platform/mep-authenticate/api`
- `libs/shared/platform/mep-chat-bot/data-access`
- `libs/shared/platform/mep-chat-bot/feature`
- `libs/shared/platform/mep-email/data-access`
- `libs/shared/application/guard/data-access`
- `libs/shared/application/login-orchestration/data-access`
- `libs/shared/application/navigation/feature`
- `libs/shared/application/network/feature`
- `libs/shared/content/list-management/model`
- `libs/shared/estimating/annotation-layers/data-access`
- `libs/shared/estimating/annotation-layers/feature`
- `libs/shared/estimating/annotation-styles/feature`
- `libs/shared/estimating/annotations/data-access`
- `libs/shared/estimating/annotations/feature`
- `libs/shared/estimating/autocount/data-access`
- `libs/shared/estimating/autocount/feature`
- `libs/shared/estimating/drawing-compare/data-access`
- `libs/shared/estimating/drawing-scales/data-access`
- `libs/shared/estimating/drawing-scales/feature`
- `libs/shared/estimating/drawing-views/data-access`
- `libs/shared/estimating/drawings/data-access`
- `libs/shared/estimating/graphical-takeoff/api`
- `libs/shared/estimating/graphical-takeoff/data-access`
- `libs/shared/estimating/graphical-takeoff/feature`
- `libs/shared/estimating/grid-views/data-access`
- `libs/shared/estimating/grid-views/feature`
- `libs/shared/estimating/industries/api`
- `libs/shared/estimating/industries/model`
- `libs/shared/estimating/measurements/api`
- `libs/shared/estimating/schedules/data-access`
- `libs/shared/estimating/user-company-settings/api`
- `libs/shared/estimating/user-company-settings/data-access`
- `libs/shared/feature-flags/data-access`
- `libs/shared/legacy/ui`
- `libs/shared/platform/application-settings-group/data-access`
- `libs/shared/platform/mep-license/api`
- `libs/shared/platform/mep-license/data-access`
- `libs/shared/platform/terms-of-service/data-access`
- `libs/shared/platform/tokens`
- `libs/shared/platform/user-settings/data-access`
- `libs/shared/user-interface/mep-spinner`
- `libs/shared/user-profile/api`
- `libs/shared/utilities/logger`
- `libs/data-models/estimate-models`
- `libs/shared/platform/mep-license/model`
- `libs/shared/estimating/annotation-styles/data-access`
- `libs/shared/estimating/symbol-points/data-access`
- `libs/livecount/message/api`
- `libs/shared/estimating/drawings/api`
- `libs/livecount/models/model`
- `libs/shared/estimating/estimates/model`
- `libs/shared/estimating/annotations/model`
- `libs/shared/estimating/grid-views/model`
- `libs/shared/estimating/drawings/model`
- `libs/shared/estimating/annotation-layers/model`
- `libs/shared/estimating/drawing-scales/model`
- `libs/shared/estimating/user-company-settings/model`
- `libs/shared/estimating/symbol-points/model`
- `libs/shared/estimating/estimates/api`
- `libs/shared/platform/projects/api`
- `libs/shared/platform/terms-of-service/api/index`
- `libs/shared/user-interface/mep-dialog`
- `libs/shared/estimating/industries/data-access`
- `libs/shared/utilities/transloco`
- `libs/shared/user-interface/breadcrumb-data`
- `libs/shared/application-settings/api`
- `libs/shared/platform/projects/utilities/connect-folder-name-validator`
- `libs/shared/user-interface/mep-grid`
- `libs/shared/user-interface/mep-infographic`
- `libs/shared/platform/project-files/feature`
- `libs/shared/user-interface/mep-progress-dialog`
- `libs/livecount/quantity-takeoff/model`
- `libs/shared/user-interface/mep-toolbar`
- `libs/shared/user-interface/mep-toast`
- `libs/shared/platform/project-files/util`
- `libs/livecount/quantity-takeoff/ui`
- `libs/shared/estimating/drawing-compare/feature`
- `libs/shared/estimating/graphical-takeoff-main/feature`
- `libs/shared/user-interface/mep-chips`
- `libs/shared/user-interface/mep-dynamic-form`
- `libs/shared/user-interface/toggle-button`
- `libs/shared/utilities/svg-loader`
- `libs/livecount/models/api`
- `libs/shared/estimating/annotations/api`
- `libs/shared/estimating/annotations/util`
- `libs/shared/estimating/grid-views/api`
- `libs/shared/utilities/web-storage`
- `libs/livecount/signalr/data-access`
- `libs/livecount/message/tokens`
- `libs/shared/estimating/annotation-styles/model`
- `libs/livecount/quantity-takeoff/api`
