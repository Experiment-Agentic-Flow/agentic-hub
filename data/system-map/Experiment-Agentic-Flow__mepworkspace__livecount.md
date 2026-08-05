# LiveCount Application & Libraries: Architectural System Map

LiveCount is a high-performance, enterprise-grade estimating and takeoff solution developed by Trimble. It is managed as a modern Angular-based system within an **Nx Monorepo** (`mepworkspace`). LiveCount supports both **2D drawing takeoffs** (via a highly optimized WebAssembly engine) and **3D model takeoffs** (via Trimble Connect integration).

This document serves as a comprehensive system map of the LiveCount applications, their internal library boundaries, external integrations, host communication protocols, state management, and core architectural patterns.

---

## 1. High-Level System Architecture

LiveCount is built with high modularity and strict boundary separation. It divides code into cohesive, single-responsibility libraries according to the Nx workspace architectural guidelines.

```
                  +----------------------------------------------+
                  |               Host Application               |
                  |          (e.g., Accubid Anywhere)            |
                  +----------------------+-----------------------+
                                         |
                       WebView2 / iframe / SignalR (Client-side API)
                                         |
                                         v
+---------------------------------------------------------------------------------+
| apps/livecount                         | apps/livecount-studio                  |
| (Main guest app)                       | (Developer integration & test harness) |
+-------------------+--------------------+----------------------------------------+
                    |
                    v
+---------------------------------------------------------------------------------+
| libs/livecount/... (Specialized domains)                                        |
| [jobs] [projects] [models] [connect-viewer] [quantity-takeoff] [message] [...]  |
+-------------------+--------------------+----------------------------------------+
                    |
                    v
+---------------------------------------------------------------------------------+
| libs/shared/estimating/... (Shared Domain Engine)                               |
| [annotations] [drawings] [graphical-takeoff] (2D Canvas) [measurements] [...]   |
+-------------------+--------------------+----------------------------------------+
                    |
                    v
+---------------------------------------------------------------------------------+
| libs/shared/estimating/graphical-takeoff/wasm (Performance Core)                |
| Rust-compiled WebAssembly rendering and geometry engine (sgto_bg.wasm)           |
+---------------------------------------------------------------------------------+
```

### Core Architecture & Monorepo Subsystems
- **The Guest Model**: LiveCount is primarily designed as a guest application embedded in a parent host (e.g., Accubid Anywhere or MEP Estimation suites) via a WebView2 control, iframe, or SignalR tunnel. It can also operate standalone.
- **The Shared Domain**: Highly complex domain functions (such as annotations, drawings, measurement geometry, scale calibrations, and rendering) are decoupled into `/libs/shared/estimating/...` so they can be shared across multiple Trimble products (LiveCount, Estimation MEP, and Estimation Construct).
- **WebAssembly Engine**: High-performance mathematical computations and rendering routines are compiled from Rust into WebAssembly.

---

## 2. Key Applications

LiveCount consists of two primary applications inside the `apps/` directory:

### A. LiveCount Guest App (`apps/livecount`)
*   **Purpose**: The core user-facing application providing job organization, drawing/sheet management, and 2D/3D takeoff editors.
*   **Tech Stack**: Angular 21, NgRx (Store, Effects, Router-Store), Bootstrap, DevExtreme, and Modus Web Components (Trimble Design System).
*   **Key Files**:
    *   `src/app/app.module.ts`: Global initialization, dependency injection registrations, third-party module bindings, and feature-flag-based configurations.
    *   `src/app/app-routing.module.ts`: Controls view activation based on job and project state constraints.

### B. LiveCount Studio (`apps/livecount-studio`)
*   **Purpose**: A testing, diagnostic, and developer integration harness. It simulates a host application (like Accubid Anywhere) embedding the core LiveCount guest.
*   **Key Files**:
    *   `src/components/main/main.component.ts`: Embedded `iframe` orchestration layer. Resolves Trimble Identity (TID) access tokens, loads `/embed/login` in the iframe, and publishes/listens to real-time messages.
    *   `src/utils/livecount-message.api.ts`: Wraps direct window-to-window `postMessage` calls for testing the WebView / iframe integration protocol.

---

## 3. Libraries Mapping (`libs/livecount/...`)

All library modules reside under `libs/livecount` and are registered in `tsconfig.base.json` under `@hcworkspace/livecount/...`.

| Library Name | Directory Path | Nx Role | Description |
| :--- | :--- | :--- | :--- |
| **`message`** | `libs/livecount/message` | `api`, `data-access` | Orchestrates client-host communication (WebView, SignalR, iframe protocols). Declares message contracts and manages state synchronization. |
| **`connect-viewer`** | `libs/livecount/connect-viewer` | `feature` | Integrates Trimble Connect's 3D viewer directly inside LiveCount via an embedded 3D iframe structure. |
| **`models`** | `libs/livecount/models` | `feature`, `data-access`, `model`, `api` | Manages 3D BIM/CAD files imported from Trimble Connect. Tracks conversion state and versions. |
| **`quantity-takeoff`** | `libs/livecount/quantity-takeoff` | `feature`, `data-access`, `ui`, `model`, `api` | Coordinates 3D/2D quantity takeoff (QTO) interfaces, featuring DevExtreme tree-grids and component-state selectors. |
| **`quantity-takeoff-signalr`**| `libs/livecount/quantity-takeoff-signalr` | `data-access` | Core SignalR hubs specific to synchronizing QTO structures. |
| **`jobs`** | `libs/livecount/jobs` | `feature`, `data-access` | Manages estimation jobs, sub-job trees, and job configuration models (industry, unit of measure, metadata). |
| **`projects`** | `libs/livecount/projects` | `feature`, `data-access` | Handles top-level Project structures linked to Trimble Connect workspaces. |
| **`signalr`** | `libs/livecount/signalr` | `data-access` | Generic NgRx-wrapped SignalR connection state management layer. |
| **`utilities/routing`** | `libs/livecount/utilities/routing` | `util` | Exposes application-wide routing constants (`ROUTE_PATHS`) and router state-helpers. |

---

## 4. Decoupling Pattern: Dependency Inversion

To keep feature libraries independent, LiveCount uses a **Dependency Inversion** pattern via interface-based State Services. 

1. **The Library (`libs/livecount/jobs/feature` or `libs/shared/estimating/...`)** defines an abstract abstract class / token representing a state service interface:
   ```typescript
   export abstract class StateService {
     abstract activeJobId$: Observable<string>;
     abstract setActiveJob(id: string): void;
   }
   ```
2. **The App (`apps/livecount`)** implements the service concretely inside its `/src/app/module-services/` directory using NgRx Store facades, and registers it in `app.module.ts` providers:
   ```typescript
   { provide: JobsFeatureStateServiceInterface, useExisting: LivecountJobsFeatureStateService }
   ```

This enforces perfect architectural decoupling: libraries remain completely ignorant of the main app's global store implementations and actions.

---

## 5. Host-Guest Communication Protocols

When embedded inside a host application (such as Accubid Anywhere), LiveCount provides real-time two-way communication using three distinct protocols managed by the `livecount/message` library:

### Protocol Options
1.  **WebView (`/embed/login` - *Recommended*)**:
    *   Requires embedding LiveCount inside a Microsoft Edge `WebView2` control.
    *   Communication is fully client-side using native JavaScript WebView2 host-guest message posting (`window.chrome.webview.postMessage`). This is highly robust and avoids network-based message losses.
2.  **SignalR (`/home/login2` - *Deprecated*)**:
    *   Connects both host and guest to a cloud-based Azure SignalR hub (`/notifications`).
    *   Suffers from latency and disconnection drops; host apps are strongly encouraged to migrate to WebView.
3.  **iframe (Internal Testing)**:
    *   Embeds LiveCount inside a standard web `iframe` and communicates using HTML5 `window.postMessage` APIs. Used primarily in **LiveCount Studio**.

---

## 6. Message Contract API

The structured message envelope passed between the host and guest via WebView contains:
```typescript
{
  "api": "livecount-message",
  "message": { "action": "...", "actionParams": { ... } }
}
```

### A. Sent Messages (LiveCount Guest $\rightarrow$ Host Application)
Sent in response to user actions on the drawing canvas or state updates inside LiveCount:

| Action Name | Payload Structure (`actionParams`) | Description |
| :--- | :--- | :--- |
| **`connectionReady`** | `{}` | Sent when LiveCount is fully loaded and ready to accept host messages. |
| **`scaleChanged`** | `{ drawingId: string }` | Sent when scale calibration or UOM is adjusted in the guest canvas. |
| **`setDrawingActive`** | `{ drawingId: string }` | Sent when the user opens or switches drawings in the viewer. |
| **`setDrawingDeleted`** | `{ drawingId: string, deleted: boolean, message: string }` | Sent when a drawing sheet is removed from the job. |
| **`updateTakeoffData`** | `[{ takeoffId: string, measurements: [{ measurementId: string, pointCount: number, segmentCount: number, length: number, uom: string, area: number }] }]` | Published as takeoff segments/nodes are drawn, modified, or updated, providing computed quantities to the host database. |
| **`selectTakeoff`** | `{ takeoffId: string[] }` | Sent when takeoff annotations are highlighted/selected on the canvas. |
| **`cancelTakeoff`** | `{}` | Sent when active drawing/takeoff processes are cancelled. |

### B. Received Messages (Host Application $\rightarrow$ LiveCount Guest)
Received from the host to manipulate views or dictate workflow:

| Action Name | Payload Structure (`actionParams`) | Description |
| :--- | :--- | :--- |
| **`setJobActive`** | `{ id: string, filterJobId?: string, filterJobName?: string }` | Loads and activates a specific job scope within LiveCount. |
| **`updateJob`** | `{ id: string, name: string, systemOfMeasurement: string, industry: string }` | Dynamically updates job configuration. |
| **`setDrawingActive`** | `{ drawingId: string }` | Commands the guest drawing canvas to open and center on a drawing. |
| **`addTakeoff`** | `{ takeoffId: string, takeoffMode: string, drawingId: string, systemId: string, systemName: string }` | Commands LiveCount to initiate a takeoff operation (e.g. Area, Length, Count) on a specified sheet. |
| **`cancelTakeoff`** | `{ takeoffId: string }` | Explicitly aborts a takeoff sequence. |
| **`enableTakeoffEditing`** | `any` | Unlocks annotation creation tools on the canvas. |
| **`disableTakeoffEditing`**| `any` | Puts the canvas in view-only mode, locking editor panels. |
| **`updateAccessToken`** | `{ accessToken: string }` | Updates the active JWT bearer token to prevent session expiry. |
| **`softDeleteTakeoff`** | `{ takeoffId: string[] }` | Marks takeoff annotations on active sheets as soft-deleted. |
| **`restoreTakeoff`** | `{ takeoffId: string[] }` | Un-deletes specified takeoff groups. |
| **`unlinkTakeoff`** | `{ takeoffId: string, measurementId: string }` | Separates a measurement record from its underlying geometry. |
| **`selectTakeoff`** | `{ takeoffId: string[], drawingId?: string }` | Highlights specified takeoff annotations on the canvas. |
| **`filterTakeoff`** | `{ takeoffId: string[] }` | Isolates and filters the sheet viewport to show only matching annotations. |
| **`updateDescription`** | `{ takeoffId: string, description: string }` | Renames the visual label/description associated with a takeoff. |
| **`deleteMeasurement`** | `{ measurementIds: string[] }` | Deletes individual measurements under a takeoff run. |
| **`refresh`** | `{ type: RefreshType }` (e.g. `'drawings'`) | Triggers LiveCount to sync and refresh data from the cloud API. |

---

## 7. 2D Graphical Takeoff Engine & Mathematics

The core of the 2D canvas takeoff functionality lies within `libs/shared/estimating/graphical-takeoff`. It relies on a high-performance **Rust-compiled WebAssembly module** (`@hcworkspace/shared/estimating/graphical-takeoff/wasm`) loaded from `/assets/estimation/sgto_bg.wasm`. This module optimizes drawing math, geometry calculations, overlay differences, and canvas rendering.

### Vertical Length Takeoff Calculations
While floor plans represent 2D space, estimations must account for vertical piping/conduit drops or rises. The engine implements two structural vertical math behaviors:

#### A. Adders (Point-based Vertical Lengths)
An **Adder** represents a simple straight vertical drop/branch rising from a point, creating a T-junction.
*   **Storage**: Stored in the `adder` property of a `LengthTakeoffCircleAnnotation` (nodes/points).
*   **Math**: Scaled horizontal line lengths + sum of point vertical adders.
```
  Top View:
   adder=5m     adder=15m
      v             v
  O---O------O------O---O     (Points represented by O, segments by ---)
    5m   10m   10m    5m

  Calculated Length = Horizontal Segment Sum (30m) + Vertical Adders (5m + 15m) = 50m
```

#### B. Elevations (Segment-based Vertical Heights)
An **Elevation** represents an absolute height level assigned to points and their connecting segments.
*   **Storage**: Stored as `elevation` on consecutive nodes.
*   **Math**: horizontal segment lengths + absolute sum of delta changes between consecutive points. Each vertical transition adds **one extra count** to the total takeoff.
```
  Side View Representation:
      
      O------O------O       Elev: 10m
    /             \
  O                O---O    Elev: 0m

  Calculated Length = Horizontal Segments + |Elev2 - Elev1| + |Elev3 - Elev2| + ...
```

---

## 8. 3D Quantity Takeoff (QTO) System

LiveCount supports **3D Quantity Takeoffs (QTO)** by enabling the feature flag `LC_3dQuantityTakeoff` (configured in `AppModule`):

```
+-----------------------------------------------------------+
|               libs/livecount/quantity-takeoff             |
|                                                           |
|  +-----------------------------------------------------+  |
|  |                 QuantityTakeoffContainer            |  |
|  |             (Split Screen layout controller)        |  |
|  +---------------------------+-------------------------+  |
|                              |                            |
|            Loads 3D model    |    Lists Elements          |
|                              v                            v
|  +----------------------------------+  +------------------+  |
|  |    libs/livecount/connect-viewer |  | DevExtreme Grids |  |
|  |         (Trimble Connect)        |  | (Element Grid &  |  |
|  |         [3D BIM/CAD Viewer]      |  |  Item Grid)      |  |
|  +----------------------------------+  +------------------+  |
+-----------------------------------------------------------+
```

### Components of 3D Takeoffs
*   **Split View Orchestration (`libs/livecount/quantity-takeoff/feature`)**: Uses `QuantityTakeoffContainerComponent` to coordinate selections between the 3D model view and tabular data grids.
*   **Trimble Connect 3D Viewer (`libs/livecount/connect-viewer`)**: Loads 3D BIM/CAD architectural/mechanical model files using Trimble Connect's visualization engine inside a container iframe.
*   **DevExtreme Data Grids (`quantity-takeoff-item-grid`)**: Renders highly interactive tree tables detailing 3D model takeoff items and physical model components, allowing users to map geometric quantities (volume, area, weight) straight to materials.
*   **Sync Infrastructure (`libs/livecount/quantity-takeoff-signalr`)**: Leverages real-time hubs to synchronize selected items, camera coordinates, and takeoff states among concurrent estimators.