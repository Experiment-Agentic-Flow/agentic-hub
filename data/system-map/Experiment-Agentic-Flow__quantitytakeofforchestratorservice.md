# System Map & Architectural Reference
## QuantityTakeoffOrchestratorService

This document provides a deep-dive architectural reference and system map for the **QuantityTakeoffOrchestratorService**. It is designed for engineers seeking to understand, maintain, or extend the system's design patterns, workflows, and implementation details.

---

## 1. System Purpose & Value Proposition

The **QuantityTakeoffOrchestratorService** is an event-driven, microservice-based orchestration layer. Its primary responsibility is managing the lifecycle of converting **TRIMBIM** (Trimble BIM) 3D design models from **Trimble Connect** into structured, queryable data optimized for downstream quantity takeoff and estimating operations.

Key value propositions include:
- **Asynchronous, Resilient Processing**: Utilizes a State Machine Saga pattern to manage multi-step, long-running model conversion workflows.
- **Resource Efficiency**: Implements stream-based model extraction, GZip compression, and parallel chunked uploads to handle large BIM files without memory starvation.
- **Real-Time Client Updates**: Pushes active progress stages (1 to 5) and terminal states directly to frontend clients via **Azure SignalR**.
- **GDPR Compliance**: Integrates with the Merlin Customer Data Hub (CDH) to safely remove customer-related saga and metadata records.

---

## 2. Core Architectural Blueprint

The service follows an event-driven, saga-orchestrated architecture built on **.NET 6+** and **MassTransit** over **Azure Service Bus**.

### High-Level Components & Message Flow
```
                   +-----------------------+
                   |  Azure Service Bus    |
                   +-------+-------^-------+
                           |       |
       IProcessTrimBimModel|       | ITrimBimModelProcessingCompleted / Failed
                           v       |
+--------------------------+-------+------------------------------------------+
| QuantityTakeoffOrchestratorService                                          |
|                                                                             |
|  +------------------------------+       +--------------------------------+  |
|  | ProcessTrimbleModelConsumer  |       |  ModelConversionStateMachine   |  |
|  +--------------+---------------+       +---------------+----------------+  |
|                 |                                       |                   |
|                 | Decrypts token                        | Pushes progress / |
|                 v                                       | final status      |
|  +--------------+---------------+                       v                   |
|  |   ModelConversionProcessor   |               +-------+--------+          |
|  +--------------+---------------+               | Azure SignalR  |          |
|                 |                               +-------+--------+          |
|                 | Downloads / parses                    |                   |
|                 v                                       v                   |
|  +--------------+---------------+               +-------+--------+          |
|  |     Trimble Connect API      |               | Client UI /    |          |
|  +--------------+---------------+               | Browser        |          |
|                 |                               +----------------+          |
|                 | Stream JSON / GZip                                        |
|                 v                                                           |
|  +--------------+---------------+                                           |
|  |    Trimble File Service      |                                           |
|  +--------------+---------------+                                           |
|                 |                                                           |
|                 v Updates reference                                         |
|  +--------------+---------------+                                           |
|  |     MongoDB Metadata         |                                           |
|  +------------------------------+                                           |
+-----------------------------------------------------------------------------+
```

---

## 3. Component Breakdown

### 3.1. Entry Point & Bootstrapping (`Program.cs`)
The service bootstraps using the WebApplication builder, integrating custom extensions from `ServiceCustomExtensions.cs` to configure its various sub-components:
- **Azure App Configuration**: Namespaces registered (`MepAuthorization`, `MepAuthentication`, `QuantityTakeoff`, `Estimating`) to retrieve environment-specific configurations.
- **MongoDB Configuration**: Configures MongoDB collection conventions (camelCase) and registers state and metadata collections.
- **Service Registration**: Registers core business engines (`ModelConversionProcessor`, `TrimbleFileService`, `ConnectClientService`, `ModelMetaDataProcessor`, etc.) to the DI container.
- **Routing & Endpoints**: Sets up controller mapping and maps the SignalR hub endpoint at `/quantitytakeoffhub`.

### 3.2. Messaging & Event-Driven Architecture (`MassTransit`)
The messaging topology is managed using **MassTransit** over **Azure Service Bus**:
- **`ModelConversionStateMachine` (Saga)**: Tracks and drives the state of conversion.
- **`ProcessTrimbleModelConsumer`**: Listens to `IProcessTrimBimModel`. Initiates processing and publishes completion/failure messages back to the bus.
- **`DeleteCustomerDataCdhConsumer`**: Listens to Merlin CDH delete requests to handle customer data removal asynchronously.

### 3.3. Core State Machine Saga (`ModelConversionStateMachine.cs`)
Tracks the current state of a model conversion request using `ModelConversionState` stored in **MongoDB**.

#### Saga Lifecycle States:
- **`Initial`**: Waiting for a processing request.
- **`Converting`**: Active processing of the TRIMBIM model.
- **`Completed`**: Terminal state indicating successful processing and metadata generation.
- **`Failed`**: Terminal state indicating that the conversion threw an error or failed validation.

#### Event Handling:
- **`ModelConversionStarted` (Correlated by `CorrelationId`)**: Transitions state from `Initial` to `Converting`, updates metadata timestamps, and notifies the client group via SignalR that processing has started.
- **`ModelConversionCompleted` (Correlated by `CorrelationId`)**: Updates completion times and sends the generated file download URL to the client before transitioning to `Completed` (and is eventually finalized).
- **`ModelConversionFailed` (Correlated by `CorrelationId`)**: Captures the failure exception, logs it with New Relic / Serilog tracing attributes, notifies the client via SignalR, and transitions to `Failed`.

---

## 4. Operational & Storage Repositories

### 4.1. Model Conversion State Store (`ModelConversionStateRepository.cs`)
- **Collection Name**: `ModelConversionStateMachine` (MongoDB)
- **Saga Properties Persisted**:
  - `CorrelationId` (Primary Key Guid)
  - `CurrentState` (Converting, Completed, Failed)
  - `CustomerId`, `TrimbleConnectModelId`, `VersionId`
  - `JobId`, `JobModelId`, `NotificationGroupId`
  - `EventReceivedOn` & `EventCompletedOn`
  - `Version` (for optimistic concurrency control / `ISagaVersion`)

### 4.2. Model Metadata Store (`ModelMetaDataRepository.cs`)
Handles persistence of the structural layout of processed models.
- **Collection Name**: `ModelMetaData` (MongoDB)
- **Operations**:
  - `UpdateFileIdAndPSetDefinitionsForConnectModel`: Atomically updates or upserts (isUpsert = true) the file reference ID pointing to the compressed `.json.gz` payload in Trimble File Service, alongside extracted Property Set Definitions (`PSetDefinitions`), updating audit metadata.

---

## 5. End-to-End Data Flows

### 5.1. Model Conversion Pipeline (Happy Path)

```
Client         ASB / Saga       Consumer      Trimble Connect      File Service      MongoDB (Metadata)
  |                |               |                 |                   |                   |
  |-- Initiate --->|               |                 |                   |                   |
  |   (REST API)   |               |                 |                   |                   |
  |                |-- IProcess -->|                 |                   |                   |
  |                |   TrimBim     |                 |                   |                   |
  |<-- SignalR ----|               |                 |                   |                   |
  |   Started      |               |-- Get Model --->|                   |                   |
  |                |               |   Bytes         |                   |                   |
  |                |               |<-- Bytes -------|                   |                   |
  |                |               |                                     |                   |
  |                |               |-- Parse TRIMBIM & Extract properties                     |
  |                |               |-- GZip compress Stream              |                   |
  |                |               |-- Upload compressed JSON ---------->|                   |
  |                |               |<-- File ID -------------------------|                   |
  |                |               |                                                         |
  |                |               |-- (Parallel) Run unique properties extract & fetch Url --|
  |                |               |-- Get Download Url ---------------->|                   |
  |                |               |<-- Expirable URL -------------------|                   |
  |                |               |                                                         |
  |                |               |-- Update metadata & property set definitions ---------->|
  |                |               |<-- Success ACK -----------------------------------------|
  |                |               |                                     |                   |
  |                |-- Complete -->|                                     |                   |
  |<-- SignalR ----|               |                                     |                   |
  |   Completed    |               |                                     |                   |
```

1. **Request Reception**: An external client initiates a request. The saga initiates, transitions to `Converting`, and writes state to MongoDB. SignalR sends progress stage `1` (Started).
2. **Model Retrieval**: `ProcessTrimbleModelConsumer` consumes `IProcessTrimBimModel`. It decodes the access token from the message headers (Base64 decrypted).
3. **Download & Process**: The consumer invokes `ModelConversionProcessor.ConvertTrimBimModelAndUploadToFileService`. It queries the `ConnectClientService` to stream down the TRIMBIM model. SignalR sends stage `2` (DownloadingModel).
4. **Takeoff Element Extraction**: Properties (Product, Reference Object, Presentation Layer Psets) are extracted. A temporary JSON file containing structured takeoff element nodes is generated. SignalR sends stage `3` (ExtractingElements).
5. **Compression & Storage Upload**: The temporary JSON is compressed into `.json.gz` via an optimal `GZipStream` and uploaded chunk-by-chunk to **Trimble File Service** via `TrimbleFileService` client. The temporary files are eagerly deleted inside `finally` blocks. SignalR sends stage `4` (UploadingContent).
6. **Data Refinement & DB Sync**:
   - Spawns parallel tasks: `ProcessModelAndFetchUniquePropertyDefinitions` (parses distinct properties) and `GetFileDownloadUrlFromFileService` (creates a 4-hour expirable download URL).
   - Writes the unique property set definitions and file references into MongoDB's `ModelMetaData` collection.
7. **Completion Notification**: SignalR sends stage `5` (Completed). The consumer publishes `ITrimBimModelProcessingCompleted` onto Azure Service Bus. The state machine transitions to `Completed` and finalizes.

---

## 6. Developer Experience: Topology Isolation

To prevent conflicts when multiple developers share a single/common Azure Service Bus namespace during local development, the service features custom MassTransit naming overrides:

```
                  +-----------------------------------+
                  |      Shared Azure Service Bus     |
                  +-----------------+-----------------+
                                    |
            +-----------------------+-----------------------+
            | (Topic: local-IProcessTrimBimModel)           | (Topic: local-IProcessTrimBimModel)
            v                                               v
+-----------------------+                       +-----------------------+
| Dev Machine: Alice    |                       | Dev Machine: Bob      |
| Queue: alice-process- |                       | Queue: bob-process-   |
|   trim-bim-model      |                       |   trim-bim-model      |
+-----------------------+                       +-----------------------+
```

1. **`IsUserBasedTransportNamingEnabled` Settings Toggle**: Enabled on localhost configuration profiles (`appsettings.localhost.json`).
2. **`UserNameBasedQueueTopologyFormatter`**: Prefixes all generated queues and endpoint consumers with the local workstation username (e.g., `alice-process-trimble-model-consumer` instead of `process-trimble-model-consumer`).
3. **`LocalBasedTopicTopologyFormatter`**: Intercepts topic generation, prefixing all topics with a `local-` prefix.
4. **Subscription Rules**: Auto-injects a `UserName` header on published messages and dynamically creates a SQL Rule Filter on Azure Service Bus subscription endpoints (e.g., `UserName = 'alice'`), ensuring developers receive only their own triggered messages.

---

## 7. Testing Architecture

The codebase maintains strict validation layers divided across three test projects:

### 7.1. Unit Tests (`QuantityTakeoffOrchestratorService.UnitTests`)
Focuses on isolation and fast verification of internal processing units.
- **Framework Choice**: **xUnit** for runner capabilities and assertions; **NSubstitute** for robust, clear mocking of IO services.
- **Fixtures & Mock Data**:
  - `MockModelDataFixture`: Loads binary payloads from `Asset/MockModelData.txt` containing raw TRIMBIM binary outputs to pass straight to the parser engines.
  - `ModelConversionRequestFixture`: Standardizes common valid test requests.
  - `AutoMoqDataAttribute`: Speeds up writing unit tests by auto-wiring mocked dependencies into test constructors.

### 7.2. Integration Tests (`QuantityTakeoffOrchestratorService.IntegrationTests`)
Designed to verify end-to-end integration boundaries. Utilizes **Testcontainers** to spin up lightweight MongoDB instances locally to test repository persistence without requiring an active cloud cloud cluster.

### 7.3. Smoke Tests (`QuantityTakeoffOrchestratorService.SmokeTests`)
Validates high-level endpoint routing, SignalR hubs, and configurations in actual target environments post-deployment. Uses Xunit collections (`SmokeCollection`) to synchronize execution.