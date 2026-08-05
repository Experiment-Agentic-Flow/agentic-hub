# SYSTEM MAP: quantitytakeoffservice
## Deep Architectural Reference & Core Component Topography

This document serves as a comprehensive, production-grade architectural blueprint of the **Quantity Takeoff Service (`quantitytakeoffservice`)**. Designed for engineering reference, it details how the application coordinates APIs, background event-driven architectures, distributed sagas, real-time communications, and database-level consistency mechanics.

---

## 1. EXECUTIVE SYSTEM PROFILE

The `quantitytakeoffservice` is a microservice responsible for tracking and managing **Quantity Takeoffs (QTO)**—the extraction and management of physical material quantities (length, area, volume, counts) from BIM/3D CAD models or manual estimation workflows. It acts as the backbone of the construction cost estimation lifecycle by bridging CAD models, manual takeoffs, structural alterations, and associated graphics/annotations.

### Core Technology Stack
- **Runtime:** .NET 10.0 Web SDK
- **Database:** MongoDB (via `Mep.Platform.Extensions.MongoDb`)
- **Messaging Service:** Azure Service Bus (orchestrated via MassTransit 8.5.10)
- **Real-Time Layer:** Azure SignalR Service
- **Authentication:** Trimble Identity (TID) Auth Flows (via custom Middleware)
- **Security & Crypto:** Symmetric AES and Asymmetric RSA (Azure Key Vault Cryptography)
- **BIM Core:** TrimBim.Tools.NET 3.1.0 (for Trimble BIM file manipulation)
- **Monitoring:** New Relic Agent APM & Serilog structured logging

---

## 2. SYSTEM-WIDE ARCHITECTURAL STYLE

The microservice employs a hybrid architectural blueprint combining a **Layered Service Style** with an **Asynchronous Event-Driven Architecture (EDA)**.

```
+-------------------------------------------------------------------------------+
|                                    API LAYER                                  |
|         - Controllers (REST endpoints, versioned, token-authorized)           |
+------------------------+------------------------------------+-----------------+
                         |                                    |
                         v                                    v
+------------------------+------------------+ +---------------+-----------------+
|              PROCESSOR LAYER              | |        SIGNALR HUB LAYER        |
|  - Domain orchestrators & business rules  | |  - Real-time client pushes      |
|  - Claim Check uploads to MongoDB GridFS   | |  - Grouped by Client Session Id |
+------------------------+------------------+ +---------------+-----------------+
                         |                                    ^
                         v                                    |
+------------------------+------------------+                 |
|             REPOSITORY LAYER              |                 |
|  - Bulk MongoDb operations & patches      |                 |
|  - Encapsulated transaction logic         |                 |
+------------------------+------------------+                 |
                         |                                    |
                         v                                    |
+------------------------+------------------+                 |
|             DATABASE LAYER (MONGODB)      |                 |
|  - Soft-deletions + automatic 1hr TTL     |                 |
+-------------------------------------------+                 |
                                                              |
+-------------------------------------------------------------+-----------------+
|                     MESSAGE BROKER LAYER (AZURE SERVICE BUS)                  |
|  - MassTransit Sagas & Courier Routing Slips (Dual-Phase Transactions)       |
|  - Developer Environment Queue & Topic Isolation Topologies                    |
+-------------------------------------------------------------------------------+
```

### Key Design Patterns & Topologies

#### 1. Distributed Transactions via MassTransit Courier (Routing Slips)
For complex multi-service workflows (e.g., saving takeoff entries with annotations, deleting model cascades), the system rejects simple two-phase commits in favor of the **Saga Routing Slip Pattern**. It serializes an ordered itinerary of steps (Activities), passing execution states downstream. Each Activity implements dual interfaces (`IActivity<TArgs, TLog>`) defining:
- `Execute`: Applies changes locally (capturing the pre-execution state).
- `Compensate`: Automatically rolls back changes (reverting database state) if a subsequent downstream activity faults.

#### 2. Claim Check Pattern for Async Payloads (GridFS References)
Azure Service Bus has strict message size limits (optimally $<64\text{ kB}$). Payload-heavy items like serialized Annotation groups are stripped from the primary message in the **Processor Layer**, written to MongoDB GridFS via `IMessageDataRepository`, and sent over the broker as a safe `MessageData<byte[]>` pointer. Downstream Courier activities fetch the payload block directly from MongoDB during activity execution.

#### 3. Real-Time Socket Multiplexing (SignalR Hub Context)
Clients connect to a unified WebSocket gateway, `QuantityTakeoffHub`. Connections pass a unique `groupId` query string, organizing clients into isolated real-time channels. Downstream MassTransit consumers inject `IQuantityTakeoffHubContext` to dispatch status messages directly to these groups upon routing slip completion or fault.

#### 4. Developer Transport Isolation
To support multiple developers sharing a single Azure Service Bus namespace locally, the system implements a runtime naming formatter toggled by `IsUserBasedTransportNamingEnabled`:
- **`UserNameBasedQueueTopologyFormatter`**: Prefixes physical queue names with the developer's system username (e.g., `QTS-username-SaveTakeoffEntryRequest`).
- **`LocalBasedTopicTopologyFormatter`**: Prefixes topic definitions with `local-`.
- **SQL Subscription Rules**: Inserts a rule matching the header filter `UserName = 'developer'` to safely route messages only to the publisher's isolated queue.

---

## 3. COMPONENT TOPOGRAPHY

The system's modularity is organized across three primary directories under `src/quantitytakeoffservice/`:

```
quantitytakeoffservice/
├── Controllers/v1/         # Versioned REST Gateways
├── CourierActivities/      # Distributed transaction stages (Execute/Compensate)
├── MassTransitConsumers/   # Queue message handlers & Saga orchestrators
├── Processor/              # Business logic coordinators (Translates View -> Domain)
├── Repositories/           # MongoDB low-level operations, Indexes, and Bulk-writes
├── Services/               # Cryptography, Db Bootstrapping, and file utilities
└── SignalR/                # WebSockets & Push Notifications
```

### 3.1. API Layer (Controllers)
Controllers inherit from `VersionedJsonApiController` and enforce the `[Authorize(Policy = "Customer")]` policy.

| Controller Class | Primary Responsibility | Key Endpoints |
| :--- | :--- | :--- |
| `ManualTakeoffController` | Synchronous manual record manipulation & retrieval. | `POST /ApplyTakeoffChanges`<br>`GET /{estimateId}` |
| `ManageTakeoffController` | Triggers distributed asynchronous deletion routines. | `POST /DeleteTakeoffEntries` |
| `ChangesetController` | Retrieves model differences and revision modifications. | `GET /Changesets/{modelId}` |
| `Connect3DModelController`| Interacts with model associations inside Trimble Connect. | `POST /Connect3DModel` |
| `MergedPropertiesController` | Manages merged geometric metadata property values. | `POST /MergedProperties` |
| `QuantityTakeoffItemController` | Standard operations on atomic takeoff items. | `POST /TakeoffItems` |

### 3.2. Business Logic Layer (Processors)
Processors act as the functional heart of the application, orchestrating the mapping of view requests to domain records, transaction boundaries, and event emission.

- **`ManualTakeoffProcessor`**: Handles manual estimations. If a batch contains both item upserts and graphic annotations, it orchestrates the **Claim Check** workflow: serializes annotations to MongoDB, creates trace headers, and publishes the `SaveTakeoffEntryRequest` over the broker.
- **`JobModelMetaDataProcessor`**: Manages structural 3D model records. Initiates model parsing by publishing `IProcessTrimBimModel` with base64-encoded bearer credentials so background workers can access secured cloud directories.
- **`ChangesetProcessor`**: Compiles revisions of items, ensuring model adjustments are tracked continuously.

### 3.3. Low-Level Storage Layer (Repositories)
Repositories interact directly with MongoDB via the official drivers. A notable implementation pattern exists in `ManualTakeoffRepository.ApplyPatches`:

To patch individual elements or custom values inside a document's `Properties` array (e.g., overriding "Length" or "Volume"), MongoDB requires specialized array filters. The repository builds dynamic, dual bulk write models per field patch to maintain high throughput:
1. **Operation 1 (Update Existing):** Uses `.ElemMatch` targeting `{ PropertyName: fieldPath }` and sets the value using `.FirstMatchingElement().PropertyValue`.
2. **Operation 2 (Push New):** Uses `.Not(ElemMatch)` to append a brand new property model to the array if it did not exist before.

These writes are grouped into a single `BulkWriteAsync` context executed within an `IClientSessionHandle` transaction.

### 3.4. Distributed Consistency Layer (Courier Activities)

#### `SaveTakeoffEntryActivity`
Saves manual takeoff records into MongoDB.
- **`Execute`**:
  1. Queries existing documents in a single trip using the target IDs.
  2. Identifies which documents are updates (capturing and serializing their current states) and which are inserts.
  3. Executes the upsert in a database transaction.
  4. Records the state in `SaveTakeoffEntryLog`.
- **`Compensate`**:
  1. Restores the serialized pre-execution versions.
  2. Physically deletes the newly inserted records using their captured IDs inside a database transaction.

#### `DeleteModelsActivity`
Cascades soft deletion across a model's ecosystem of objects.
- **`Execute`**: Executes soft-deletion routines concurrently over a transaction across four collections: `Changesets`, `ManualTakeoffs`, `TakeoffItems`, and `JobModelMetaData`. Records deleted IDs in `DeleteModelsActivityLog`.
- **`Compensate`**: Restores the items back to an active state by reverting soft deletion flags for all recorded IDs.

#### `UpsertUpdatedParentsActivity`
Handles reaggregations during sub-element deletions.
- **`Execute`**: Captures and stores pre-execution parents inside the transaction log before writing recalculated aggregated values.
- **`Compensate`**: Overwrites the reaggregated values with the original, larger values if annotation deletions fail down the routing slip pipeline.

---

## 4. DATA LAYOUT & STORAGE MODEL (MONGODB)

The service relies entirely on **MongoDB** for persistence. Data model relationships are handled logically through composite references rather than hard relational constraints.

```
+---------------------------------------------------------------------------------+
|                                 DATABASE MAP                                    |
|                                                                                 |
|  [JobModelMetaData] <----+ (Ref: JobModelId)                                    |
|         |                |                                                      |
|         v (Versions)     +--------------------+                                 |
|  [ModelMetaData]                              |                                 |
|                                               |                                 |
|  [Changesets] ---------> [TakeoffItems] ------+----> [MergedProperties]         |
|         ^ (ParentId)                                                            |
|         |                                                                       |
|  [ManualTakeoffs] (ParentId -> Child Element hierarchical tree)                 |
|         |                                                                       |
|         +--------------> [CustomerStorageDetails] (TID Cloud Space IDs)         |
+---------------------------------------------------------------------------------+
```

### 4.1. Core Entity Collections
- **`JobModelMetaData` (`JobModelMetaData` Collection)**: Stores root information about a 3D model attached to a specific Estimate Job, including an embedded array of processed versions.
- **`ModelMetaData` (`ModelMetaData` Collection)**: Deep structural metadata extracted from parsed BIM models.
- **`Changesets` (`Changeset` Collection)**: Revisions representing changes between model uploads.
- **`ManualTakeoffs` (`ManualTakeoff` Collection)**: User-entered estimations. Organizes items hierarchically via `ParentId` representing parent items and child elements.
- **`TakeoffItems` (`TakeoffItems` Collection)**: Individual materials measurements associated with model objects.
- **`MergedProperties` (`MergedProperties` Collection)**: Geometric, user-merged properties associated with specific components.

### 4.2. Automated Soft Deletion Workflow (TTL Indices)
To prevent orphan database files and bypass heavy manual cleanup scripts, the service uses **MongoDB Partial TTL Indices** inside `ConfigureMongoDbIndexesService`.

```csharp
var deleteIndexDef = Builders<ChangesetDomain>.IndexKeys.Ascending(x => x.DeleteMetadata.DeletedDate);

await _changeSetCollection.HandleIndexes([
    new CreateIndexModel<ChangesetDomain>(deleteIndexDef, new CreateIndexOptions<ChangesetDomain> {
        ExpireAfter = TimeSpan.FromHours(1),
        PartialFilterExpression = Builders<ChangesetDomain>.Filter.Eq(x => x.DeleteMetadata.IsDeleted, true)
    })
]);
```

#### Lifecycle of a Soft Deletion
```
[Active Document] 
      |
      |  1. Soft-delete requested
      v
[Document Modified]
   - DeleteMetadata.IsDeleted = true
   - DeleteMetadata.DeletedDate = DateTime.UtcNow
      |
      |  2. Becomes eligible for index matches
      v
[TTL Partial Filter Match]
      |
      |  3. 1 Hour expires
      v
[Permanently Purged by MongoDB Background Thread]
```

This guarantees an immediate logical deletion from client-facing APIs (which filter out `IsDeleted == true`), allows instantaneous rollback via saga compensation within 1 hour, and prevents document bloating via automated physical deletion.

---

## 5. RECURRING REQUEST LIFECYCLES

To demonstrate the runtime behavior of the system, the following lifecycles represent the primary operational paths:

### 5.1. Save Takeoff Entry with Annotations
Coordinates the **Claim Check** payload storage and **Courier routing slip** across services, finishing with a WebSocket UI push.

```
Client App             Web API         Mongo GridFS        Azure Service Bus       Annotation Service      Client Group
   |                      |                 |                       |                       |                   |
   |-- 1. Apply Changes ->|                 |                       |                       |                   |
   |   (Upsert & Annot)   |-- 2. Store ---->|                       |                       |                   |
   |                      |      Annotations|                       |                       |                   |
   |                      |<-- 3. MessageData-----------------------|                       |                   |
   |                      |       Ref       |                       |                       |                   |
   |                      |-- 4. Publish SaveRequest -------------->|                       |                   |
   |                      |                                         |-- 5. Routing Slip Execute                 |
   |                      |                                         |   (SaveTakeoffEntryActivity)              |
   |                      |                                         |                       |                   |
   |                      |                                         |-- 6. Execute SaveAnnotation ------------->|
   |                      |                                         |   (Retrieves payload from GridFS)         |
   |                      |                                         |                       |                   |
   |                      |                                         |<-- 7. Completed Successfully --------------|
   |                      |                                         |                       |                   |
   |                      |<---------------- 8. Success Event ------|                       |                   |
   |                      |                                                                                     |
   |                      |-- 9. Trigger WebSocket Push (SaveTakeoffWithAnnotationsSuccess) ------------------->|
```

1. **Client Request:** User hits `POST /ApplyTakeoffChanges` with items and annotations.
2. **Claim Check:** `ManualTakeoffProcessor` intercepts, serializes annotations, and stores them in GridFS, returning a `MessageData<byte[]>` token.
3. **Trigger Event:** Processor publishes `SaveTakeoffEntryRequest` over Service Bus carrying the record payload and the token.
4. **Routing Slip:** `SaveTakeoffEntryConsumer` creates a Routing Slip carrying two activities:
   - `SaveTakeoffEntryActivity`: Runs locally; writes manual takeoff entries into MongoDB while logging previous versions.
   - `SaveAnnotationActivity`: Points to the downstream Annotation Service's queue, forwarding the GridFS pointer.
5. **Downstream Execution:** The Annotation service picks up the token, fetches the heavy binary array directly from MongoDB GridFS, and saves the records.
6. **Saga Completion:** MassTransit triggers the routing slip's `Completed` subscription, sending a `SaveTakeoffEntrySuccess` event.
7. **Client Notification:** `SaveTakeoffEntryConsumer` intercepts the success message and uses `IQuantityTakeoffHubContext` to emit `SaveTakeoffWithAnnotationsSuccess` to the matching client SignalR group.

---

### 5.2. Cascading Model Deletion
Soft deletes a 3D model and automatically clears and/or rolls back downstream components.

```
Client App             Web API          Azure Service Bus               DeleteModelsActivity             Client Group
   |                      |                     |                                 |                           |
   |-- 1. Delete Model -->|                     |                                 |                           |
   |                      |-- 2. Publish DeleteModelsCommand -------------------->|                           |
   |                      |                     |                                 |                           |
   |                      |                     |-- 3. Transacted Soft Delete --->|                           |
   |                      |                     |   (Changesets, ManualTakeoffs,  |                           |
   |                      |                     |    TakeoffItems, JobModel)      |                           |
   |                      |                     |                                 |                           |
   |                      |                     |<-- 4. Complete DeleteAnnotationActivity                     |
   |                      |                     |                                 |                           |
   |                      |<-- 5. Complete Event----------------------------------|                           |
   |                      |                                                                                   |
   |                      |-- 6. WebSocket Push (DeleteModelsSuccess) --------------------------------------->|
```

1. **API Trigger:** Client calls `POST /DeleteTakeoffEntries` with model IDs to purge.
2. **Message Enqueue:** API starts a transaction tracking session and publishes `DeleteModels`.
3. **Execution Routing Slip:**
   - `DeleteModelsActivity`: Executes inside a MongoDB transaction. Concurrently sets `IsDeleted = true` and `DeletedDate = Now` across `Changesets`, `ManualTakeoffs`, `TakeoffItems`, and `JobModelMetaData`. Records matching IDs inside the transaction log.
   - `DeleteAnnotationActivity`: Purges linked graphic annotation records.
4. **Compensation Fallback:** If `DeleteAnnotationActivity` fails, the routing slip faults. `DeleteModelsActivity.Compensate` is triggered, running a transaction to set `IsDeleted = false` and clearing the deleted timestamp for all logged IDs, leaving the system in its original state.
5. **Real-time Broadcast:** On absolute success, the consumer pushes `DeleteModelsSuccess` to the client's socket group.

---

### 5.3. Trimble BIM Model Processing
How the service orchestrates physical CAD file parsing.

```
Client App            Web API         Service Bus        Model Processor        FailedConsumer       JobModel Repo
   |                     |                 |                    |                     |                     |
   |-- 1. Upload model ->|                 |                    |                     |                     |
   |                     |-- 2. Publish IProcessTrimBimModel -->|                     |                     |
   |                     |   (Headers: Base64 AccessToken)      |                     |                     |
   |                     |                 |                    |                     |                     |
   |                     |                 |-- 3. Parse File -->|                     |                     |
   |                     |                 |   (Trimble Cloud)  |                     |                     |
   |                     |                 |                    |                     |                     |
   |                     |                 |<-- 4. Fault Event--|                     |                     |
   |                     |                 |   (Processing Fail)                      |                     |
   |                     |                 |                                          |                     |
   |                     |                 |-- 5. Consume TrimBimProcessingFailed --->|                     |
   |                     |                 |                                          |-- 6. Rollback ----->|
   |                     |                 |                                          |   - Multi-version:  |
   |                     |                 |                                          |     Revert version  |
   |                     |                 |                                          |   - Single-version: |
   |                     |                 |                                          |     Delete model    |
```

1. **Initiation:** The model is registered via API, and `JobModelMetaDataProcessor` publishes the `IProcessTrimBimModel` contract.
2. **Token Security:** The processor reads the user's current Bearer authorization token from the HTTP request context, encodes it into a Base64 string, and attaches it as an `AccessToken` message header.
3. **Processing Attempt:** The model processor consumes the event, uses the attached token to authenticate against Trimble Connect File Services, downloads the CAD asset, and parses the 3D geometries.
4. **Self-Healing Cleanup:** If the parsing worker faults, it publishes `ITrimBimModelProcessingFailed`. `TrimBimModelProcessingFailedConsumer` intercepts and inspects database history:
   - **Multi-version Model:** If other versions exist, it extracts the failed version number and updates MongoDB to revert the model's active pointer to the previous version.
   - **Single-version Model:** If it was the initial import, it removes the entire metadata record from `JobModelMetaData` and `ModelMetaData`.

---

## 6. CROSS-CUTTING CONCERNS, APM & SECURITY

### 6.1. Microservice Identity & Token Propagation
Since the service is completely stateless, downstream processing queues must make secure cloud requests on behalf of the originating user. When initiating background routines, the Bearer JWT token is extracted from the `HttpContext` via extension helpers, encoded, and stored directly in the MassTransit `PublishContext` headers. Downstream consumers decrypt or decode the header value to authorize external resource fetches.

### 6.2. Advanced Cryptographic Protection
To safeguard sensitive customer details or credentials, the system implements a **Hybrid Encryption Design**:

```
+-----------------------------------------------------------------------------------------+
|                                    HYBRID CRYPTO ENGINE                                 |
|                                                                                         |
|  [Sensitive Plaintext]                                                                  |
|         |                                                                               |
|         |  (Symmetric - High performance)                                               |
|         v                                                                               |
|  [AesEncryptionService] <----+ (Aes Key)                                                |
|         |                    |                                                          |
|         |                    |  (Asymmetric Key Wrap - Cloud Secured)                   |
|         v                    |                                                          |
|  [Encrypted Cipher]   [DataProtectionService] (RSA Key in Azure Key Vault HSM)          |
+-----------------------------------------------------------------------------------------+
```

- **`AesEncryptionService`**: Executes rapid symmetric AES-256 encryption using an explicit byte array key for high-volume payloads.
- **`DataProtectionService`**: Interfaces with **Azure Key Vault Cryptography Client** via `CryptographyClient`. Uses HSM-secured RSA-OAEP asymmetric algorithms to encrypt/decrypt symmetric keys or short credentials, ensuring that raw keys are never stored in plain text or application configurations.

### 6.3. APM Performance Monitoring
Distributed tracing is achieved using New Relic and Serilog:
- `INewRelicAgentConfigurator` continues transactions across message boundaries. When a MassTransit consumer picks up a message, it continues the New Relic transaction using incoming trace headers.
- Health endpoints are registered at `/quantitytakeoff/health` utilizing standard ASP.NET Core indicators mapping dependencies (MongoDB and Azure Service Bus connectivity).

---

## 7. VERIFICATION & TESTING STRATEGY

The codebase employs a robust verification hierarchy divided across three levels:

```
                  +---------------------------------------+
                  |              SMOKE TESTS              |
                  |  - Verifies operational endpoints     |
                  +-------------------+-------------------+
                                      |
                                      v
                  +-------------------+-------------------+
                  |           INTEGRATION TESTS           |
                  |  - Spins up MongoDB in Testcontainers |
                  |  - Executes real network calls        |
                  +-------------------+-------------------+
                                      |
                                      v
                  +-------------------+-------------------+
                  |              UNIT TESTS               |
                  |  - Mocks IO via AutoNSubstitute       |
                  |  - Asserts algorithm correctness      |
                  +---------------------------------------+
```

### 7.1. Unit Testing
- **Framework:** xUnit
- **Mocking Engine:** NSubstitute
- **Test Generation Pattern:** Employs `[AutoNSubstituteData]` attributes to automatically wire and inject mocked class dependencies into the tests, keeping unit tests highly readable and resilient to constructor parameter refactoring.

### 7.2. Integration Testing (Containerized)
- **Database Isolation:** Integration tests utilize **`DotNet.Testcontainers`** or custom `DockerService` hosting configurations. At start-up, the fixture spins up a local instance of MongoDB inside a temporary Docker container, runs `ConfigureMongoDbIndexesService` to apply the current indexing, and mounts a clean database session.
- **API Clients:** Custom integration clients (`ChangesetClient`, `ManualTakeoffClient`, `MergedPropertiesClient`) use `Flurl` to execute real HTTP calls against the test host.
- **Saga Harnesses:** Uses MassTransit `TestHarness` extensions to mock the Azure Service Bus, allowing direct assertion of routing slip completion and activity failures without needing cloud-based queues.

---

## 8. DECONSTRUCTED DIRECTORY INDEX
For swift navigation, here is a index mapping key architectural elements to their physical location in the repository:

```
[API Endpoints]        -> src/quantitytakeoffservice/Controllers/v1/
[Transaction Sagas]    -> src/quantitytakeoffservice/MassTransitConsumers/
[Saga Activities]      -> src/quantitytakeoffservice/CourierActivities/
[Payload GridFS]       -> src/quantitytakeoffservice/Services/MessageDataRepositoryService.cs
[MongoDB Collections]  -> src/quantitytakeoffservice/Services/ConfigureMongoDbIndexesService.cs
[Array Patch Logic]    -> src/quantitytakeoffservice/Repositories/ManualTakeoffRepository.cs
[Real-Time Hub]        -> src/quantitytakeoffservice/SignalR/QuantityTakeoffHub/
[Integration Fixtures] -> test/quantitytakeoffservice.IntegrationTests/Fixtures/
```