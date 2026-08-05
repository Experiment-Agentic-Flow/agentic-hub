Here is the system map for the `QuantityTakeoffOrchestratorService` repository. 

# System Map: Quantity Takeoff Orchestrator Service

## 1. Product Overview
The **Quantity Takeoff Orchestrator Service** is the asynchronous, heavy-lifting workflow engine behind the **LiveCount 3D Quantity Takeoff** feature within the MEP (Mechanical, Electrical, and Plumbing) Estimation platform.

**The Business Problem:**
When estimators receive 3D BIM (Building Information Modeling) files, they need an automated way to extract the physical parts, materials, properties, and layers contained in those models into a data-centric structure to generate accurate cost estimates. These 3D models are massive, binary-heavy, and require significant compute and memory to parse.

**Where This Service Fits:**
While the primary user-facing [Quantity Takeoff Service] handles fast API CRUD operations for the UI, this *Orchestrator Service* operates entirely in the background. It is a headless, distributed worker responsible for executing the long-running model conversion pipeline. It listens for conversion requests, downloads the raw 3D models from Trimble Connect, shreds them into millions of discrete elements and metadata definitions, saves the result as compressed JSON in cloud storage, and keeps the user's browser updated on progress in real-time. 

## 2. End-to-End Workflows

### A. 3D Model Conversion Saga (The Core Journey)
This is the primary user journey, initiated when an estimator clicks "Process Model" on a 3D file in the LiveCount UI.

1. **Initiation (External):** A user initiates the takeoff. The UI/API layer encrypts the user's Auth Token and publishes an `IProcessTrimBimModel` event to Azure Service Bus.
2. **Saga Orchestration:** The `ModelConversionStateMachine` (a MassTransit Saga backed by MongoDB) intercepts the event, records the `CorrelationId` and `JobModelId`, and transitions the job to the **Converting** state. It immediately sends a `ModelConversionStarted` event to the user's UI via the Azure SignalR Hub (`QuantityTakeoffOrchestratorHub`).
3. **Decryption & Hand-off:** The `ProcessTrimbleModelConsumer` picks up the message. It uses Azure Key Vault (`DataProtectionService`) and AES (`AesEncryptionService`) to decrypt the user's Access Token safely out of the message header, and hands the request to the `ModelConversionProcessor`.
4. **Model Download:** The `ConnectClientService` calls the Trimble Connect API using the decrypted token to download the raw binary `.trb` (TrimBim) model file. *SignalR progress update: `DownloadingModel`*.
5. **Model Parsing & Shredding:** The `ModelConversionProcessor` uses `TrimBim.Tools.NET` to deserialize the model. It extracts geometric instances, and groups massive collections of properties (Product Information, Presentation Layers, and Reference Objects).
6. **JSON Generation & Compression:** To avoid Out-of-Memory crashes, the processor batches elements (1,000 at a time), serializes them using `Utf8JsonWriter`, and streams them to a local temporary file on disk. The file is then compressed into a `.json.gz` archive. *SignalR progress update: `ExtractingElements`*.
7. **Cloud Upload:** The compressed JSON payload is uploaded to the Trimble File Service for long-term storage. *SignalR progress update: `UploadingContent`*.
8. **Metadata Extraction:** In parallel with the upload, the processor extracts unique Property Set Definitions (PSets) so downstream services know the model's taxonomy without re-parsing it. This is saved to MongoDB via the `ModelMetaDataProcessor`.
9. **Completion:** The consumer publishes an `ITrimBimModelProcessingCompleted` event (or `...Failed` on error). The Saga state machine receives this, marks the Saga as **Completed**, and pushes a final SignalR payload containing the cloud download URL back to the estimator's UI. 

### B. Customer Data Deletion (GDPR / CDH)
1. **Initiation:** The Trimble Platform (Merlin CDH Broker) emits a tenant deletion request (`DeleteComponentCdhRequestMessage`).
2. **Execution:** The `DeleteCustomerDataCdhConsumer` triggers the `CustomerDataProcessor` to wipe all trace of the specified `CustomerId` from the MongoDB metadata and saga repositories.
3. **Completion:** A `DeleteComponentCdhResponseMessage` is pushed back onto the bus to confirm the platform-wide compliance deletion.

## 3. Structural Rules and Conventions

- **Strict Layering & Delegation**: 
  - **Consumers** (e.g., `ProcessTrimbleModelConsumer`) **must not** contain domain logic. Their sole responsibility is message validation, token decryption, executing the stopwatch for telemetry, calling a Processor, and publishing the final integration event.
  - **Processors** contain the business logic, manage temporary files, and orchestrate external Service/Repository calls.
  - **State Machines** handle state transition persistence and SignalR notification hand-offs, but never touch the actual file payload.
- **Token Security Rules**: Access tokens are **never** to be stored in the database or logged. They must be transmitted exclusively in message headers as Base64-encoded strings encrypted via AES/RSA, and decrypted entirely in memory right before making external HTTP calls.
- **Memory Management Mandates**: The codebase strictly enforces stream-based processing for BIM models. Any new data transformation logic must use chunking (e.g., `batchSize = 1000`), local `FileStream` objects instead of string concatenation, and explicitly invoke `GC.Collect()` and `GC.WaitForFullGCComplete()` to prevent Large Object Heap (LOH) fragmentation.
- **Platform SDK Alignment**: All cross-cutting concerns (Auth, MongoDB, Serilog, Feature Flags, CDH) must utilize the shared Trimble MEP NuGet packages (`Mep.Platform.Extensions.*`).

## 4. Key Subsystems / Domains

| Subsystem / Domain | Technical Responsibility | User-Facing Capability | Dependencies |
| :--- | :--- | :--- | :--- |
| **Saga Orchestration**<br/>(`StateMachines/`) | Tracks distributed transaction state (Initial -> Converting -> Completed/Failed) using MassTransit + MongoDB. Correlates messages by `CorrelationId`. | Ensures long-running 3D model parsing jobs survive service restarts and don't fail silently. | SignalR Hub, MongoDB |
| **Model Conversion**<br/>(`Processors/ModelConversionProcessor.cs`) | Downloads `.trb` files, utilizes `TrimBim.Tools.NET`, extracts layer/product properties, manages local disk JSON streaming and `.gz` compression. | Translates a visual 3D model into an estimating-friendly list of quantified parts. | Connect API, Trimble File Service, PSet Extraction |
| **Real-Time Notification**<br/>(`SignalR/`) | Maintains WebSocket connections using Azure SignalR. Pushes stage updates using `NotificationGroupId`. | Shows the estimator exactly what percentage/stage their 3D model is at while they wait. | None (Leaf node) |
| **Metadata Management**<br/>(`Repositories/ModelMetaData*`) | Extracts and stores unique PSet (Property Set) schemas and associates them with the final cloud file ID. | Allows the Takeoff UI to build dynamic property filters without downloading the 500MB+ JSON file. | MongoDB |

## 5. Cross-Cutting Patterns

- **State Management**: Uses **MongoDB** exclusively for persistent state, including MassTransit's native MongoDB saga repository integration for tracking active conversions.
- **Observability**: 
  - **New Relic APM**: Method-level tracing via the `[Trace]` attribute, and custom trace parameters (`NewRelicHelper.AddCustomLoggingAttributes`). 
  - **Serilog**: Pushes structured logs with injected context (e.g., `Log.ForContext("CorrelationId", ...)`).
- **Security & Authorization**: Uses Trimble Identity (TID) parsed via `Mep.Platform.Authorization.Middleware`. Azure Key Vault is used to maintain RSA keys for token decryption (`DataProtectionService`).
- **Parallelism & Concurrency**: Uses `Task.Run()` and `ParallelQuery` (`AsParallel().ForAll()`) during property extraction. Concurrency maps (e.g. `ConcurrentDictionary`) and explicit object locking (`lock(lockObject)`) are used to safely merge disparate BIM property sets across threads. 

## 6. Notable Constraints & Gotchas

- **Severe Memory Limits (LOH Exhaustion Risk)**: Generating flat JSON from a highly normalized 3D BIM model creates an exponential explosion of data in memory. The `ModelConversionProcessor` is heavily optimized to combat Out-Of-Memory exceptions. Any architectural change to *how* the `ExpandoObject` JSON is built must respect the local `FileStream` batching architecture and explicit garbage collection triggers, or the service will crash under load.
- **Local File System Reliance**: Because of the memory constraint, this container/service *requires* write access to local disk (`Path.GetTempPath()`) to spool up `[RandomFileName].json` and `[RandomFileName].json.gz` files before pushing to Trimble File Service.
- **Parallel Dictionary Contention**: The method `ProcessModelProperties` attempts to extract Product, Reference, Layer, and Other properties concurrently. It relies on a `lock (lockObject)` block to merge these back into a single dictionary. This is a potential CPU bottleneck if altered carelessly.
- **External Dependencies & Timeouts**: This architecture acts as a middleman transferring gigabytes of data between Trimble Connect (source) and Trimble File Service (destination). It is susceptible to network timeouts and external service degradation, handled currently by explicit retry delays (e.g., `GetFileDownloadUrlFromFileService`).