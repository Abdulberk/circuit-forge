# AI Circuit Generator & Simulator - Backend Implementation Plan

## Overview

This document outlines the complete implementation plan for the backend system of the AI Circuit Generator & Simulator. The system is designed as a monorepo with clear module boundaries, supporting multi-tenant organizations, circuit management, and SPICE-based simulation.

---

## Milestone 1: Monorepo Bootstrap

### Files to Create

```
/
├── pnpm-workspace.yaml
├── turbo.json
├── package.json
├── tsconfig.base.json
├── .eslintrc.js
├── .prettierrc
├── .gitignore
├── .env.example
├── docker-compose.yml
├── apps/
│   ├── api/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       └── main.ts
│   └── worker-sim/
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           └── main.ts
├── packages/
│   ├── eda-core/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       └── index.ts
│   └── llm-core/
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           └── index.ts
└── infra/
    └── docker/
        ├── api.Dockerfile
        ├── worker-sim.Dockerfile
        └── init-minio.sh
```

### Key Configurations

#### pnpm-workspace.yaml
```yaml
packages:
  - "apps/*"
  - "packages/*"
```

#### turbo.json
```json
{
  "$schema": "https://turbo.build/schema.json",
  "globalDependencies": [".env"],
  "pipeline": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "lint": {},
    "test": {
      "dependsOn": ["build"]
    },
    "db:migrate": {},
    "db:seed": {}
  }
}
```

#### docker-compose.yml Services
- **postgres**: PostgreSQL 15, port 5432
- **redis**: Redis 7, port 6379
- **minio**: MinIO for S3-compatible storage, ports 9000/9001
- **create-bucket**: Init container to create S3 bucket
- **api**: NestJS API service
- **worker-sim**: Simulation worker with ngspice

---

## Milestone 2: Prisma Schema + Migrations + Seed

### Database Models

```prisma
// Core entities
model User {
  id           String   @id @default(uuid())
  email        String   @unique
  passwordHash String
  name         String
  createdAt    DateTime @default(now())
  
  memberships    OrgMembership[]
  projectVersions ProjectVersion[]
  auditLogs      AuditLog[]
}

model Organization {
  id        String   @id @default(uuid())
  name      String
  createdAt DateTime @default(now())
  
  memberships    OrgMembership[]
  projects       Project[]
  templates      Template[]
  assets         Asset[]
  simulationJobs SimulationJob[]
  auditLogs      AuditLog[]
}

model OrgMembership {
  id        String   @id @default(uuid())
  orgId     String
  userId    String
  role      OrgRole  @default(MEMBER)
  createdAt DateTime @default(now())
  
  org  Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  user User         @relation(fields: [userId], references: [id], onDelete: Cascade)
  
  @@unique([orgId, userId])
}

enum OrgRole {
  OWNER
  ADMIN
  MEMBER
}

model Project {
  id          String   @id @default(uuid())
  orgId       String
  name        String
  description String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  
  org      Organization     @relation(fields: [orgId], references: [id], onDelete: Cascade)
  versions ProjectVersion[]
  
  @@unique([orgId, name])
}

model ProjectVersion {
  id              String   @id @default(uuid())
  projectId       String
  versionNumber   Int
  createdByUserId String
  circuitJson     Json     // Canonical circuit representation
  uiJson          Json     // Layout/UI state
  createdAt       DateTime @default(now())
  
  project        Project         @relation(fields: [projectId], references: [id], onDelete: Cascade)
  createdBy      User            @relation(fields: [createdByUserId], references: [id])
  simulationJobs SimulationJob[]
  
  @@unique([projectId, versionNumber])
}

model Template {
  id          String   @id @default(uuid())
  orgId       String?  // null = public template
  name        String
  tags        String[]
  circuitJson Json
  createdAt   DateTime @default(now())
  
  org Organization? @relation(fields: [orgId], references: [id], onDelete: Cascade)
}

model Asset {
  id          String    @id @default(uuid())
  orgId       String
  type        AssetType
  name        String
  contentType String
  sizeBytes   Int
  s3Key       String
  sha256      String
  createdAt   DateTime  @default(now())
  
  org Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
}

enum AssetType {
  SPICE_MODEL
  SYMBOL_PACK
  OTHER
}

model SimulationJob {
  id               String          @id @default(uuid())
  orgId            String
  projectVersionId String?
  status           SimJobStatus    @default(QUEUED)
  engine           SimEngine       @default(NGSPICE)
  analysisConfig   Json
  netlist          String          @db.Text
  stdout           String?         @db.Text
  stderr           String?         @db.Text
  resultJson       Json?
  resultS3Key      String?
  metrics          Json?
  createdAt        DateTime        @default(now())
  startedAt        DateTime?
  finishedAt       DateTime?
  
  org            Organization    @relation(fields: [orgId], references: [id], onDelete: Cascade)
  projectVersion ProjectVersion? @relation(fields: [projectVersionId], references: [id], onDelete: SetNull)
}

enum SimJobStatus {
  QUEUED
  RUNNING
  SUCCEEDED
  FAILED
  CANCELED
  TIMED_OUT
}

enum SimEngine {
  NGSPICE
}

model AuditLog {
  id         String   @id @default(uuid())
  orgId      String
  userId     String
  action     String
  entityType String
  entityId   String
  meta       Json?
  createdAt  DateTime @default(now())
  
  org  Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  user User         @relation(fields: [userId], references: [id])
  
  @@index([orgId, createdAt])
  @@index([entityType, entityId])
}
```

### Seed Data
- Demo user: `demo@circuitforge.io` / `demo123`
- Demo organization: "Demo Org"
- 5 starter templates:
  1. RC Low-Pass Filter
  2. Voltage Divider
  3. Diode Rectifier
  4. LC Oscillator
  5. BJT Amplifier (basic)

---

## Milestone 3: eda-core Package

### Module Structure

```
packages/eda-core/src/
├── index.ts                 # Public exports
├── types/
│   ├── circuit.ts           # CircuitJson, Component, Net, Pin types
│   ├── analysis.ts          # AnalysisConfig types (tran, ac, dc, op)
│   ├── simulation.ts        # SimulationResult types
│   └── erc.ts               # ERC result types
├── schemas/
│   ├── circuit.schema.ts    # Zod schemas for validation
│   └── analysis.schema.ts   # Zod schemas for analysis config
├── netlist/
│   ├── generator.ts         # CircuitJson -> SPICE netlist
│   ├── templates.ts         # SPICE command templates
│   └── sanitizer.ts         # Include path whitelist, node naming
├── parser/
│   ├── csv-parser.ts        # ngspice wrdata CSV -> JSON
│   ├── raw-parser.ts        # ngspice raw ASCII -> JSON (optional)
│   └── netlist-parser.ts    # SPICE netlist -> CircuitJson (import)
├── erc/
│   ├── rules.ts             # ERC rule definitions
│   ├── checker.ts           # Run ERC checks
│   └── codes.ts             # Error/warning codes
└── utils/
    ├── node-naming.ts       # Sanitize node names
    └── unit-parser.ts       # Parse SPICE units (k, M, u, n, p)
```

### Core Types (TypeScript)

```typescript
// types/circuit.ts
export interface CircuitJson {
  version: string;
  components: Component[];
  nets: Net[];
  metadata?: CircuitMetadata;
}

export interface Component {
  id: string;
  type: ComponentType;
  designator: string;  // R1, C1, V1, etc.
  value?: string;      // "10k", "100n", "5V"
  model?: string;      // For diodes, transistors
  pins: PinConnection[];
  properties?: Record<string, unknown>;
}

export type ComponentType = 
  | 'resistor' | 'capacitor' | 'inductor'
  | 'voltage_source' | 'current_source'
  | 'diode' | 'ground';

export interface PinConnection {
  pinId: string;
  netId: string;
}

export interface Net {
  id: string;
  name: string;
  isGround?: boolean;
}

export interface CircuitMetadata {
  name?: string;
  description?: string;
  author?: string;
  createdAt?: string;
}

// types/analysis.ts
export type AnalysisConfig = TranAnalysis | AcAnalysis | DcAnalysis | OpAnalysis;

export interface TranAnalysis {
  type: 'tran';
  stopTime: string;    // e.g., "10m" for 10ms
  stepTime?: string;   // e.g., "1u" for 1μs
  startTime?: string;
}

export interface AcAnalysis {
  type: 'ac';
  variation: 'dec' | 'oct' | 'lin';
  points: number;
  startFreq: string;
  stopFreq: string;
}

export interface DcAnalysis {
  type: 'dc';
  source: string;      // Source designator
  startVal: string;
  stopVal: string;
  increment: string;
}

export interface OpAnalysis {
  type: 'op';
}

// types/simulation.ts
export interface SimulationResult {
  meta: ResultMeta;
  series: DataSeries[];
}

export interface ResultMeta {
  analysisType: string;
  xLabel: string;
  xUnit?: string;
  pointsCount: number;
}

export interface DataSeries {
  name: string;
  unit?: string;
  points: DataPoint[];
}

export interface DataPoint {
  x: number;
  y: number;
}

// types/erc.ts
export interface ErcResult {
  passed: boolean;
  errors: ErcIssue[];
  warnings: ErcIssue[];
}

export interface ErcIssue {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  relatedIds: string[];
}
```

### Netlist Generator

The generator converts CircuitJson to ngspice-compatible netlist:

```typescript
// Pseudocode for netlist generation
function generateNetlist(circuit: CircuitJson, config: AnalysisConfig): string {
  const lines: string[] = [];
  
  // Title
  lines.push(`* Circuit: ${circuit.metadata?.name || 'Untitled'}`);
  lines.push(`* Generated by eda-core`);
  lines.push('');
  
  // Components
  for (const comp of circuit.components) {
    lines.push(componentToSpice(comp, circuit.nets));
  }
  lines.push('');
  
  // Analysis command
  lines.push(analysisToSpice(config));
  lines.push('');
  
  // Control block for output
  lines.push('.control');
  lines.push('  set filetype=ascii');
  lines.push('  run');
  lines.push(`  wrdata output.csv ${getProbeSignals(circuit)}`);
  lines.push('  quit');
  lines.push('.endc');
  lines.push('');
  lines.push('.end');
  
  return lines.join('\n');
}
```

### ERC Rules (MVP)

| Code | Severity | Rule |
|------|----------|------|
| ERC001 | error | No ground node (node 0) in circuit |
| ERC002 | error | Floating node detected |
| ERC003 | error | Voltage source short circuit (same net on both terminals) |
| ERC004 | warning | Component has unconnected pins |
| ERC005 | error | Invalid component value format |

---

## Milestone 4: worker-sim

### Worker Architecture

```
apps/worker-sim/src/
├── main.ts                  # Entry point, worker initialization
├── config/
│   └── config.ts            # Environment configuration
├── queue/
│   ├── consumer.ts          # BullMQ job consumer
│   └── types.ts             # Job payload types
├── simulation/
│   ├── runner.ts            # ngspice execution logic
│   ├── sandbox.ts           # Temp directory + cleanup
│   ├── include-guard.ts     # Whitelist .include paths
│   └── result-handler.ts    # Parse output + store result
├── storage/
│   └── s3-client.ts         # MinIO/S3 operations
└── utils/
    ├── logger.ts            # Pino logger setup
    └── graceful-shutdown.ts # Cleanup on SIGTERM
```

### Job Processing Flow

```mermaid
sequenceDiagram
    participant Q as BullMQ Queue
    participant W as Worker
    participant DB as PostgreSQL
    participant S3 as MinIO/S3
    participant NG as ngspice

    Q->>W: Receive job (jobId, netlist, config)
    W->>DB: Update status = RUNNING
    W->>W: Create temp dir /tmp/sim/{jobId}
    W->>W: Write circuit.cir
    
    alt Has model assets
        W->>S3: Download model files
        W->>W: Write to job dir
    end
    
    W->>NG: spawn ngspice -b -o stdout.log circuit.cir
    NG-->>W: Exit (success/timeout/error)
    
    alt Success
        W->>W: Parse output.csv -> JSON
        alt Large result
            W->>S3: Upload result
            W->>DB: Update resultS3Key
        else Small result
            W->>DB: Update resultJson
        end
        W->>DB: status = SUCCEEDED
    else Timeout
        W->>DB: status = TIMED_OUT, stderr
    else Error
        W->>DB: status = FAILED, stderr
    end
    
    W->>W: Cleanup temp dir
```

### Security Measures

1. **Include Path Whitelist**: Only allow `.include` of files within job temp directory
2. **Spawn with Array Args**: No shell interpolation
3. **Timeout Enforcement**: configurable SIM_TIMEOUT_MS
4. **Resource Limits**: Best-effort memory limit via spawn options
5. **No Shell Access**: ngspice runs in batch mode only

---

## Milestone 5: API (NestJS)

### Module Structure

```
apps/api/src/
├── main.ts
├── app.module.ts
├── common/
│   ├── decorators/
│   │   ├── current-user.decorator.ts
│   │   └── org-roles.decorator.ts
│   ├── guards/
│   │   ├── jwt-auth.guard.ts
│   │   └── org-membership.guard.ts
│   ├── filters/
│   │   └── http-exception.filter.ts
│   ├── interceptors/
│   │   └── logging.interceptor.ts
│   └── pipes/
│       └── validation.pipe.ts
├── config/
│   └── config.module.ts
├── prisma/
│   ├── prisma.module.ts
│   └── prisma.service.ts
├── auth/
│   ├── auth.module.ts
│   ├── auth.controller.ts
│   ├── auth.service.ts
│   ├── strategies/
│   │   └── jwt.strategy.ts
│   └── dto/
│       ├── register.dto.ts
│       ├── login.dto.ts
│       └── refresh.dto.ts
├── orgs/
│   ├── orgs.module.ts
│   ├── orgs.controller.ts
│   ├── orgs.service.ts
│   └── dto/
├── projects/
│   ├── projects.module.ts
│   ├── projects.controller.ts
│   ├── projects.service.ts
│   └── dto/
├── versions/
│   ├── versions.module.ts
│   ├── versions.controller.ts
│   ├── versions.service.ts
│   └── dto/
├── templates/
│   ├── templates.module.ts
│   ├── templates.controller.ts
│   ├── templates.service.ts
│   └── dto/
├── assets/
│   ├── assets.module.ts
│   ├── assets.controller.ts
│   ├── assets.service.ts
│   └── dto/
├── simulation/
│   ├── simulation.module.ts
│   ├── simulation.controller.ts
│   ├── simulation.service.ts
│   ├── simulation.producer.ts  # BullMQ producer
│   └── dto/
└── health/
    ├── health.module.ts
    └── health.controller.ts
```

### API Endpoints Summary

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| POST | /auth/register | Register new user | No |
| POST | /auth/login | Login | No |
| POST | /auth/refresh | Refresh tokens | No |
| POST | /auth/logout | Logout | Yes |
| GET | /orgs | List user's orgs | Yes |
| POST | /orgs | Create org | Yes |
| GET | /orgs/:orgId | Get org details | Yes + Member |
| GET | /orgs/:orgId/projects | List projects | Yes + Member |
| POST | /orgs/:orgId/projects | Create project | Yes + Member |
| GET | /projects/:projectId | Get project | Yes + Member |
| PATCH | /projects/:projectId | Update project | Yes + Member |
| DELETE | /projects/:projectId | Delete project | Yes + Admin |
| POST | /projects/:projectId/versions | Save version | Yes + Member |
| GET | /projects/:projectId/versions | List versions | Yes + Member |
| GET | /versions/:versionId | Get version | Yes + Member |
| GET | /templates | List templates | Partial |
| POST | /templates | Create template | Yes + Admin |
| GET | /templates/:templateId | Get template | Partial |
| POST | /orgs/:orgId/assets/models/presign | Get upload URL | Yes + Member |
| POST | /orgs/:orgId/assets/models/commit | Confirm upload | Yes + Member |
| GET | /orgs/:orgId/assets/models | List assets | Yes + Member |
| POST | /versions/:versionId/simulations | Start simulation | Yes + Member |
| POST | /simulations/quick | Quick sim (netlist) | Yes |
| GET | /simulations/:jobId | Get job status | Yes + Member |
| GET | /simulations/:jobId/result | Get result | Yes + Member |
| GET | /health | Health check | No |

### Authentication Flow

```mermaid
sequenceDiagram
    participant C as Client
    participant A as API
    participant DB as PostgreSQL

    C->>A: POST /auth/register {email, password, name}
    A->>A: Validate input
    A->>A: Hash password (argon2)
    A->>DB: Create User
    A->>A: Generate JWT access + refresh tokens
    A-->>C: {accessToken, refreshToken, user}

    C->>A: POST /auth/login {email, password}
    A->>DB: Find user by email
    A->>A: Verify password
    A->>A: Generate tokens
    A-->>C: {accessToken, refreshToken, user}

    C->>A: GET /orgs (Authorization: Bearer {accessToken})
    A->>A: Validate JWT
    A->>DB: Get user's orgs
    A-->>C: {orgs: [...]}
```

---

## Milestone 6: Tests

### Test Structure

```
/
├── apps/
│   ├── api/
│   │   └── test/
│   │       ├── auth.e2e-spec.ts
│   │       ├── orgs.e2e-spec.ts
│   │       ├── projects.e2e-spec.ts
│   │       ├── simulation.e2e-spec.ts
│   │       └── jest-e2e.json
│   └── worker-sim/
│       └── test/
│           ├── runner.spec.ts
│           └── integration.spec.ts
└── packages/
    └── eda-core/
        └── test/
            ├── netlist-generator.spec.ts
            ├── csv-parser.spec.ts
            ├── erc-checker.spec.ts
            └── schemas.spec.ts
```

### Test Categories

1. **Unit Tests (eda-core)**
   - Netlist generation for each component type
   - CSV parsing edge cases
   - ERC rule validation
   - Zod schema validation

2. **Integration Tests (API + Worker)**
   - Full simulation flow: enqueue -> process -> result
   - Auth + authz combinations
   - Error handling scenarios

3. **E2E Smoke Test**
   - Complete user journey: register -> create org -> create project -> save version -> simulate -> get result

---

## Milestone 7: Documentation

### docs/ARCHITECTURE.md
- System overview diagram
- Module boundaries and responsibilities
- Data flow for simulation jobs
- Queue architecture

### docs/API.md
- Complete endpoint reference
- Request/response examples
- Error codes

### docs/SIMULATION.md
- ngspice integration details
- Netlist format and generation
- Output parsing
- Supported analyses

### docs/SECURITY.md
- Authentication mechanism
- Authorization model (RBAC)
- Input validation
- Rate limiting
- Sandbox approach for simulations
- Include path whitelist

### docs/ASSUMPTIONS.md
- Design decisions made without explicit requirements
- Trade-offs and rationale

---

## Environment Variables

```bash
# Database
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/circuitforge

# Redis
REDIS_URL=redis://localhost:6379

# JWT
JWT_SECRET=your-jwt-secret-min-32-chars
JWT_REFRESH_SECRET=your-refresh-secret-min-32-chars
JWT_ACCESS_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d

# S3/MinIO
S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin
S3_BUCKET=circuitforge
S3_REGION=us-east-1
S3_FORCE_PATH_STYLE=true

# Simulation
SIM_TIMEOUT_MS=10000
SIM_MAX_OUTPUT_BYTES=5242880

# Rate Limiting
RATE_LIMIT_TTL=60
RATE_LIMIT_LIMIT=120

# Logging
LOG_LEVEL=info
```

---

## Quick Start Commands

```bash
# Install dependencies
pnpm install

# Start infrastructure
docker-compose up -d postgres redis minio create-bucket

# Run migrations
pnpm db:migrate

# Seed database
pnpm db:seed

# Start development
pnpm dev

# Run tests
pnpm test

# Build all
pnpm build
```

---

## Docker Compose Services

| Service | Image | Ports | Purpose |
|---------|-------|-------|---------|
| postgres | postgres:15-alpine | 5432 | Primary database |
| redis | redis:7-alpine | 6379 | BullMQ queue backend |
| minio | minio/minio | 9000, 9001 | S3-compatible storage |
| create-bucket | minio/mc | - | Init bucket on startup |
| api | custom | 3000 | NestJS API |
| worker-sim | custom | - | Simulation worker |

---

## File Counts by Milestone

| Milestone | Estimated Files | Priority |
|-----------|-----------------|----------|
| 1. Bootstrap | ~15 | P0 |
| 2. Prisma | ~5 | P0 |
| 3. eda-core | ~20 | P0 |
| 4. worker-sim | ~12 | P0 |
| 5. API | ~50 | P0 |
| 6. Tests | ~15 | P1 |
| 7. Docs | ~6 | P1 |

---

## Implementation Notes

1. **No GPL Dependencies**: ngspice is GPL but runs as external binary (not linked). Core codebase uses MIT/Apache-compatible libraries only.

2. **Graceful Shutdown**: Both API and worker implement proper SIGTERM handling for clean container restarts.

3. **Structured Logging**: Pino logger with JSON output for production observability.

4. **Strict TypeScript**: `strict: true`, no `any` types, explicit return types.

5. **Zod Validation**: Runtime validation for all external inputs (API DTOs, circuitJson, analysisConfig).

---

*This plan will be executed milestone by milestone. Switch to Code mode to begin implementation.*