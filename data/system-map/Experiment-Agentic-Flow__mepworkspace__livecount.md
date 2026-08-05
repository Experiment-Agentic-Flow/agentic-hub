# 🗺️ LiveCount Ecosystem System Map

This document provides a comprehensive system and architectural map of the **LiveCount** ecosystem within the `Experiment-Agentic-Flow/mepworkspace` repository. The map details the core applications, library modules, architectural patterns, state orchestration, and high-performance edge-computing features that power the application's multi-window 3D BIM/CAD and 2D drawing takeoff workflows.

---

## 1. High-Level Architectural Topology

The LiveCount system is designed around a decoupled, highly modular architecture utilizing **Angular**, **NgRx** (state management), and a robust **monorepo-style library division** to separate features, models, data access layers, and message protocols.

```
                  ┌───────────────────────────────────────────────┐
                  │              livecount-studio                 │
                  │        (Admin/Developer Harness App)          │
                  └───────────────────────┬───────────────────────┘
                                          │  postMessage (webview / iframe)
                                          ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                       livecount                                        │
│                                (Main Angular Client)                                   │
├────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                        │
│   Routing / Lazy Loading:                                                              │
│   [Customers]  ──►  [Projects]  ──►  [Jobs]  ──►  [Drawings]  ──►  [Graphical Takeoff]  │
│                                                                                        │
│   ┌────────────────────────────────────────────────────────────────────────────────┐   │
│   │                                 Core Libraries                                 │   │
│   ├────────────────────────────────────────────────────────────────────────────────┤   │
│   │   ┌─────────────────────┐   ┌─────────────────────┐   ┌────────────────────┐   │   │
│   │   │       message       │   │   quantity-takeoff  │   │   connect-viewer   │   │   │
│   │   │ (SignalR/WebView API)│  │ (OPFS / Web Workers)│   │  (Trimble 3D Viewer)│  │   │
│   │   └─────────────────────┘   └─────────────────────┘   └────────────────────┘   │   │
│   │                                                                                │   │
│   │   ┌─────────────────────┐   ┌─────────────────────┐   ┌────────────────────┐   │   │
│   │   │      projects       │   │        jobs         │   │       models       │   │   │
│   │   │ (Feature / Data-Acc)│   │ (Feature / Data-Acc)│   │ (Feature / Data-Acc)│  │   │
│   │   └─────────────────────┘   └─────────────────────┘   └────────────────────┘   │   │
│   └────────────────────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Core Applications Detail

### 📱 `apps/livecount` (The Main Client Application)
* **Purpose**: The primary estimation, takeoff, and model management interface. It visualizes both 2D drawings and 3D Trimble Connect BIM models, calculates takeoff measurements, and orchestrates active estimating session states.
* **Bootstrap & Shell Flow**:
  * **Entry Point**: `src/main.ts` bootstraps `AppModule` (`src/app/app.module.ts`).
  * **Core Modules Config**: Implements global setups such as Transloco i18n, LogRocket, Gainsight analytics, DevExtreme widgets support, and multi-window orchestration via `ngx-multi-window`.
  * **Authentication & Embed login**:
    * Implements `/embed/login` route resolved by `LiveCountEmbedLoginComponent`. 
    * This component intercepts an `access_token` query parameter, transitions the app into a WebView/iframe-hosted communication protocol via `LiveCountMessageApi`, and authorizes the session directly through `MepAuthenticateFacade`.
  * **Route Strategy**: Built on paths defined inside `@hcworkspace/livecount/utilities/routing`. Dynamically checks user licensing status, project bounds, and job bounds through specific route guards:
    * `CustomerSelectionGuard`
    * `WithValidSelectedCustomerAndRegionGuard`
    * `WithSelectedProjectGuard`
    * `WithSelectedJobGuard`
    * `WithConnectLicenseGuard`

### 🛠️ `apps/livecount-studio` (Developer & Admin Harness)
* **Purpose**: An isolated dev and validation tool mimicking the parent platform environment hosting LiveCount.
* **Integration Patterns**:
  * It embeds `apps/livecount` inside a secure iframe (`livecountFrame`).
  * Sends access tokens to coordinate authentications.
  * Directs the child `livecount` window using a localized postMessage architecture. 
  * Permits developers to load custom datasets, copy jobs, re-drive active parameters, and audit the raw legacy HTTP and internal APIs in a single dashboard.

---

## 3. Comprehensive Library Blueprint (`libs/livecount/`)

The core capabilities of the ecosystem are extracted into specialized domain-scoped libraries:

### 1️⃣ `message` (Dual-Protocol Message Communication Framework)
Facilitates seamless bidirectional communication between the LiveCount client and the desktop host (e.g., Revit/SysQue add-ins, WebView2, or LiveCount Studio wrapper).
* **Architecture / Layers**:
  * `api/`: Exposes interfaces and public api declarations (`LiveCountMessageApi`).
  * `data-access/`: Core state handlers, protocols, and message wrappers.
* **Key Components & Services**:
  * `LcMessageProtocolProvider` (`lc-message.protocol.ts`): Highly adaptive. Evaluates context to bind either a **SignalR remote control protocol** or a **WebView2/iframe `postMessage` protocol** dynamically.
  * `LiveCountMessageHandler` (`+state/livecount-message.handler.ts`): Dispatches commands directly into corresponding NgRx facades in response to incoming messages.
* **Supported Message Commands**:
  * `addTakeoff` / `cancelTakeoff` (Initiates canvas annotation draw modes)
  * `setJobActive` / `setDrawingActive` (Switches estimating scopes)
  * `updateAccessToken` (Hot-refreshes auth credentials)
  * `softDeleteTakeoff` / `restoreTakeoff` (Hides/unhides graphical annotations)
  * `updateDescriptionsByTakeoffIds` (Modifies metadata on elements)

### 2️⃣ `quantity-takeoff` (Data Processing & Edge Storage Engine)
The most technically advanced library within the workspace. Handles large scale quantities mapping of 3D objects, custom attributes (Properties Sets/PSets), elements hierarchy, and cache storage.
* **Architecture / Layers**:
  * `api/`: Main programmatic export bindings.
  * `model/`: Schema and typing definitions for IFC properties, unit configurations, and custom metadata.
  * `data-access/`: Underpinned by OPFS local storage, worker processing, and state structures.
  * `ui/`: Modular property modification buttons, forms, and custom property panels.
  * `feature/`: High performance grids coordination and takeoffs management views.
* **Performance Enhancing Architectures**:
  * **Origin Private File System (OPFS)** (`opfs.service.ts`):
    * Low-level, extremely fast client-side storage bypassing indexDB overhead.
    * Persists Trimble Connect payload outputs directly from the incoming web response stream. Uses stream piping (`stream.pipeTo(writableStream)`) directly to the file handles, preventing memory inflation or out-of-memory crashes on massive models.
    * Distinguishes between flat (legacy) structures and versioned folder hierarchies.
  * **Multithreaded Web Workers** (`workers/data-processor.worker.ts`):
    * Offloads JSON serialization/parsing, custom property re-computations, change sets processing, and CRC checksum generations from the UI thread.
    * Uses a dedicated `ConnectFileProcessor` instance on a separate OS thread to avoid locking up 3D graphics rendered in the browser.

### 3️⃣ `connect-viewer` (Trimble Connect 3D Viewer Integration)
* **Architecture / Layers**:
  * `feature/`: Contains `ConnectViewerComponent`, which embeds the high-performance WebGL 3D model engine provided by Trimble Connect.
* **Role**: Orchestrates 3D model loads, coordinates selection synchronization between elements selected on the quantity takeoff grid and elements highlighted in the 3D viewport, and synchronizes active viewer perspective updates.

### 4️⃣ `graphical-takeoff` (2D Canvas Drawing Editor)
* **Architecture / Layers**:
  * `feature/`: Core view container (`LivecountGraphicalTakeoffComponent`).
* **Role**: Links drawings views data-access with underlying canvas manipulation engines, driving custom line segment measurements, item counting, and shape takeoffs on 2D PDFs.

### 5️⃣ `jobs` (Active Estimating Jobs State)
* **Architecture / Layers**:
  * `data-access/`: NgRx state setup (actions, reducer, effects, facade, selectors).
  * `feature/`: Core administration components for changing, updating, or copying active job directories.

### 6️⃣ `projects` (Projects Scoping)
* **Architecture / Layers**:
  * `data-access/`: Orchestrates the project hierarchy, linking individual estimating projects to organizational contracts.
  * `feature/`: Components for creating and managing regional projects, with integrated route guards and breadcrumb resolvers.

### 7️⃣ `models` (BIM 3D Model Catalog)
* **Architecture / Layers**:
  * `model/`: Structural model entities.
  * `data-access/`: API services and NgRx actions mapping the file status.
  * `feature/`: Grid layouts displaying loaded 3D models, conversion state-trackers, processing phases, and revision selectors.

### 8️⃣ `signalr` (Generic State-Linked Connection Bus)
* **Role**: A generic NgRx-wrapped SignalR library. Translates hub lifecycles (started, closed, message received) directly into native NgRx actions (`createSignalRHub`, `hubNotFound`), keeping SignalR connection logic highly declarative and fully integrated with the reactive store.

### 9️⃣ `utilities` (Routing Utilities)
* **Role**: Houses routing path constant dictionaries (`ROUTE_PATHS`) and shared environment evaluation functions, avoiding circular dependencies between lazy-loaded libraries.

---

## 4. State Flow & Reactive Architecture

LiveCount relies on a centralized **NgRx Reactive Store** to manage both local user interaction states and host-synchronized command streams:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            STATE ORCHESTRATION                              │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      │
           External Event             ▼
    ┌───────────────────────────────────────────────────┐
    │  LcMessageProtocolProvider (SignalR or WebView)   │
    └─────────────────────────────────┬─────────────────┘
                                      │ dispatches
                                      ▼
    ┌───────────────────────────────────────────────────┐
    │           NgRx Actions / Facades                  │
    │ (e.g., SelectDrawing, SetJobActive, AddTakeoff)   │
    └─────────────────────────────────┬─────────────────┘
                 ┌────────────────────┴────────────────────┐
                 ▼                                         ▼
    ┌───────────────────────────┐             ┌───────────────────────────┐
    │     NgRx Reducers         │             │       NgRx Effects        │
    │  (Update Memory State)    │             │  (Side-effects & OPFS)    │
    └────────────┬──────────────┘             └────────────┬──────────────┘
                 │                                         │
                 ▼                                         ▼
    ┌───────────────────────────┐             ┌───────────────────────────┐
    │     Store Selectors       │             │   Workers / OPFS Storage  │
    │  (Reactive UI Updates)    │             │   (Heavy computations)    │
    └───────────────────────────┘             └───────────────────────────┘
```

* **Persistence Strategy**: Uses meta-reducers (`metaReducers` in `app.reducer.ts`) with custom local storage integration (`ngx-multi-window` or custom serializations) to ensure crucial application states survive intentional multi-window workflows or unexpected page-reloads.
* **Multi-Window Sync**: Employs window synchronization strategies. Multi-window events let secondary detached screens (like a detached drawing viewer monitor) listen to central selection selectors reactively, driving visual highlights in secondary windows without requiring complex cross-tab database synchronization.