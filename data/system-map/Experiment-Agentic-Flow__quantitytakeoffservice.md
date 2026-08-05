# QuantityTakeoffService: System Architecture Map

## 1. Product Overview

The **Quantity Takeoff Service** is a central backend service powering **LiveCount's 3D Quantity Takeoff** product within the broader MEP (Mechanical, Electrical, and Plumbing) Estimation platform.

At a business level, estimators use LiveCount 3D to accurately predict material costs for construction projects. They do this by loading 3D building models (usually authored in tools like Revit and stored in Trimble Connect) and extracting exact counts, lengths, and properties of building elements (like pipes, ducts, or conduits). 

The Quantity Takeoff Service acts as the persistent system of record and orchestration layer for this process. It connects estimates (Jobs) to specific versions of 3D models, tracks the extracted quantities, handles manually drawn takeoff items (when 3D models are incomplete), and records granular edit histories for undo/redo functionality. Crucially, it does not live in isolation; it orchestrates data flow between the user's browser, Trimble file storage, background TrimBim extraction workers, and an external Annotation Service (used for 2D manual markups).

## 2. End-to-End Workflows

### 3D Model Linking and Processing
1. **Model Registration:** The user links a 3D model from Trimble Connect to their current estimate.
2. **Implementation:** The frontend calls `Connect3DModelController.Add3DModel`. The `JobModelMetaDataProcessor` saves the model reference to the `JobModelMetaData` MongoDB collection.
3. **Triggering Extraction:** The processor checks if the file has been processed before. If not, it publishes an `IProcessTrimBimModel` message via MassTransit.
4. **External Processing:** An external background worker runs TrimBim tools to extract property sets (PSets) and geometry, publishing `ITrimBimModelProcessingCompleted` upon success.
5. **Ingestion:** The frontend client (using a local OPFS layer for high-performance extraction) computes the raw takeoff quantities from the processed model and pushes the structured takeoff records to the backend via `QuantityTakeoffItemController.PublishTakeoffData`, landing in the `QuantityTakeoff` collection.

### Manual Takeoff Creation (with Annotations)
1. **Manual Entry:** A user draws an element on a 2D sheet or manually types in a takeoff record that wasn't present in the 3D model.
2. **Implementation:** The frontend pushes the data to `ManualTakeoffController.ApplyTakeoffChanges`.
3. **Saga Orchestration:** The `ManualTakeoffProcessor` detects if the user also saved 2D annotations (markups). If so, it dispatches a distributed transaction via MassTransit Courier (`SaveTakeoffEntryConsumer`).
4. **Distributed Steps:** The Courier routing slip first executes a `SaveTakeoffEntryActivity` to persist the takeoff record locally. Next, it executes a `SaveAnnotationActivity`, forwarding the annotation data (via GridFS `MessageData` payload) to the external **Annotation Service**.
5. **Real-time Notification:** Upon completion (or failure/rollback), the backend pushes a status update to the frontend via SignalR (`QuantityTakeoffHub`).

### Editing Quantities (Changesets)
1. **Property Override:** A user overrides a property (e.g., changing a pipe's nominal diameter or modifying a count) to adjust the estimate.
2. **Implementation:** The frontend calls `ChangesetController.UpsertChangeset`. The `ChangesetProcessor` records the delta in the `Changeset` MongoDB collection, providing a full audit trail and enabling undo/redo functionality for estimate revisions.

### Model and Data Cleanup
1. **Deletion:** A user removes a 3D model from an estimate. 
2. **Implementation:** `Connect3DModelController.DeleteModels` triggers the `DeleteModelsConsumer` Courier saga.
3. **Cascade Deletion:** `DeleteModelsActivity` soft-deletes the `JobModelMetaData` and cascades soft-deletes to all associated 3D and manual takeoffs. `DeleteAnnotationActivity` then calls out to the Annotation Service to clean up remote markups.
4. **Tenant Wiping (GDPR):** The platform-wide Common Data Hub (Merlin) emits a `DeleteComponentCdhRequestMessage`. Handled by `DeleteCustomerDataCdhConsumer`, this triggers `CustomerDataProcessor` to forcefully wipe all MongoDB collections for the targeted tenant ID.

## 3. Structural Rules and Conventions

*   **Strict Layering Enforcement:** 
    *   **Controllers** (`Controllers/v1/`) are thin HTTP wrappers. They must never query the database directly or use external SDKs; they solely delegate to Processors.
    *   **Processors** (`Processor/`) contain all core business logic and orchestration. They compose Repositories and utility Services.
    *   **Repositories** (`Repositories/`) are strictly for database access using `Mep.Platform.Extensions.MongoDb`. They contain zero domain orchestration or external API calls.
*   **Asynchronous Sagars (MassTransit Courier):** Any workflow crossing service boundaries (like interacting with the Annotation Service) must use MassTransit Courier routing slips. Activities must be idempotent and implement explicit compensation logic (rollbacks) to ensure eventual consistency.
*   **Large Message Payloads:** Azure Service Bus size limits are bypassed using MassTransit's `MessageData<T>`. Large payloads (like lists of annotation graphics) are stored in MongoDB GridFS behind the scenes before the message is placed on the bus.
*   **SignalR Constraint:** The `QuantityTakeoffHub` is strictly for unidirectional server-to-client notifications (e.g., "Deletion Failed"). Clients do not send business commands over SignalR.
*   **Soft Deletions:** Business entities (Takeoffs, Models) implement a `DeleteMetadata` block. Entities are soft-deleted first during active estimate workflows to support complex rollbacks, rather than being hard-deleted immediately.

## 4. Key Subsystems / Domains

*   **Job & Model Metadata** (`JobModelMetaDataDomain`, `ModelMetaDataDomain`)
    *   *Capability:* Manages the linking of estimates to specific versions of external Trimble Connect files.
    *   *Technical Details:* Tracks processing state and version histories. Depends heavily on the `TrimbleFileService` to resolve file download URLs.
*   **Takeoff Core** (`TakeoffItemDomain`, `ManualTakeoffDomain`)
    *   *Capability:* The primary system of record for material quantities. 
    *   *Technical Details:* Split conceptually into two collections: `QuantityTakeoff` (3D origins, bulk ingested from frontend) and `ManualTakeoff` (2D/manual origins, supports parent/child hierarchical groupings). Both track aggregated values (`Count`).
*   **Changeset System** (`ChangeSetDomain`)
    *   *Capability:* Enables granular undo/redo and auditability of estimates.
    *   *Technical Details:* Stores field-level overrides (`Changeset` deltas) linked to a specific takeoff item and estimate.
*   **Property Normalization** (`MergedPropertyDetailDomain`)
    *   *Capability:* Solves the "BIM authoring tool mismatch" problem. Allows an estimator to create a canonical property (e.g., "Pipe Size") that pulls from Revit's "Nominal Diameter" or Tekla's "Size".
    *   *Technical Details:* Consolidates diverse source property definitions into a single queryable definition. 

## 5. Cross-Cutting Patterns

*   **Messaging & Integration:** MassTransit over Azure Service Bus. `UserNameBasedQueueTopologyFormatter` is used to isolate developer queues during local execution.
*   **Distributed Tracing:** New Relic tracing is injected into HTTP requests and explicitly forwarded through the Service Bus via `TraceHeaders` to stitch together asynchronous consumer workflows.
*   **Database Integration:** MongoDB is the sole persistence layer, standardizing on BSON serialization attributes (e.g., `[BsonRepresentation(BsonType.Decimal128)]` for precise decimal arithmetic on counts).
*   **Authentication & Multi-Tenancy:** Standardized MEP Platform TID-based authorization (`Mep.Platform.Authorization.Middleware`). Almost all endpoints and queries are strictly scoped by `CustomerId` and `EstimateId`.

## 6. Notable Constraints & Gotchas

*   **Client-Side Computation (OPFS):** A new engineer might expect this backend service to parse 3D file geometry and generate takeoff quantities. **It does not.** Heavy processing happens in the browser via OPFS/WASM. The backend acts primarily as a metadata orchestrator, ingestor, and sync mechanism.
*   **Distributed Failure Coupling:** Because takeoff lifecycles are heavily coupled to the external Annotation Service, failures in the Annotation Service will cause takeoff workflows to rollback locally. The UI must rely entirely on SignalR to know the final outcome of a "Save" or "Delete" operation.
*   **Parent Recalculation:** When a single child element is deleted from a manual takeoff, the system must trigger an optional Courier activity (`UpsertUpdatedParentsActivity`) to re-aggregate and patch the parent's count. 
*   **Type Clashes:** There is a known compile-time ambiguity between `Azure.Identity` and `Azure.Core` (regarding `DefaultAzureCredential`) documented in the `.csproj`, solved by explicitly excluding compilation assets from `Azure.Identity`. Refactoring cloud dependencies should be done carefully.