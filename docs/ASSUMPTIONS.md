# Design Assumptions

This document captures design decisions made during the implementation of the AI Circuit Generator & Simulator backend. These assumptions were made in the absence of explicit requirements to keep the project moving forward.

---

## Authentication & Authorization

### A1: Single User per Email
- **Decision**: One user account per email address (no email reuse)
- **Rationale**: Standard practice for B2B SaaS; simplifies user lookup and recovery flows

### A2: Personal Organization
- **Decision**: Users can exist without an organization initially, but simulation requires org context
- **Rationale**: Allows exploration before commitment; quick simulations use first available org or create personal org

### A3: JWT Token Lifetime
- **Decision**: Access token: 15 minutes, Refresh token: 7 days
- **Rationale**: Balance between security (short access) and UX (reasonable refresh window)

### A4: Password Policy
- **Decision**: Minimum 8 characters, no complexity requirements in MVP
- **Rationale**: Keep MVP simple; can add strength requirements later

---

## Data Model

### A5: CircuitJson Version
- **Decision**: Use internal version "1.0" for circuitJson format
- **Rationale**: Inspired by circuit-json NPM package but simplified for our needs

### A6: Version Numbering
- **Decision**: Auto-increment integer starting from 1 per project
- **Rationale**: Simple, predictable; avoids semantic versioning complexity

### A7: Soft Delete vs Hard Delete
- **Decision**: Hard delete for MVP (cascading deletes via Prisma)
- **Rationale**: Simpler implementation; add soft delete with audit trail in future

### A8: Project Names
- **Decision**: Unique per organization, case-sensitive
- **Rationale**: Common convention; prevents accidental conflicts

---

## Simulation

### A9: Default Analysis
- **Decision**: If no analysisConfig provided, default to `.op` (operating point)
- **Rationale**: Safe, fast, always applicable

### A10: Simulation Timeout
- **Decision**: 10 seconds default (SIM_TIMEOUT_MS)
- **Rationale**: Sufficient for educational circuits; prevents runaway simulations

### A11: Maximum Output Size
- **Decision**: 5MB default (SIM_MAX_OUTPUT_BYTES)
- **Rationale**: Reasonable for typical transient analysis; larger results go to S3

### A12: ngspice Output Format
- **Decision**: Use `wrdata` CSV output instead of raw binary
- **Rationale**: Simpler parsing, human-readable, debuggable

### A13: Default Probes
- **Decision**: If no probes specified, output all node voltages
- **Rationale**: Better than no output; user can refine
- **Status**: Implemented — when a request omits probe names, the worker derives them from the netlist's `wrdata` line via eda-core's `extractProbes` ([runner.ts](../apps/worker-sim/src/simulation/runner.ts)), so version/default sims return populated series.

### A14: Model Files Location
- **Decision**: External models must be uploaded as Assets and referenced by s3Key
- **Rationale**: Security (no arbitrary file includes), traceability

---

## Component Library

### A15: MVP Component Set
- **Decision**: Support only: R, C, L, V (DC/SIN), I (DC), D (Diode), GND
- **Rationale**: Minimum viable set for educational circuits; expand later

### A16: Default Diode Model
- **Decision**: Include minimal built-in diode model (DDEFAULT)
- **Rationale**: Allows basic diode circuits without model upload

### A17: Node Naming
- **Decision**: Auto-generate node names as `n{id}` where id is sanitized net identifier
- **Rationale**: Avoids SPICE reserved names, ensures uniqueness

### A18: Ground Node
- **Decision**: Ground is always node "0" (SPICE convention)
- **Rationale**: SPICE requirement; simplifies netlist generation

---

## API Design

### A19: Error Response Format
- **Decision**: `{ "code": "ERR_XXX", "message": "...", "details": {...} }`
- **Rationale**: Consistent, machine-readable, follows REST best practices

### A20: Pagination
- **Decision**: Use cursor-based pagination for list endpoints (default 20 items)
- **Rationale**: Better for real-time data; offset pagination can miss items

### A21: Rate Limiting
- **Decision**: 120 requests per 60 seconds (`default` limiter; plus a `burst` 30/1s)
- **Rationale**: Generous for normal use; prevents abuse
- **Status**: ✅ Shipped — **enforced**. `ThrottlerGuard` is registered globally via `{ provide: APP_GUARD, useClass: ThrottlerGuard }` in [app.module.ts](../apps/api/src/app.module.ts), so both the sustained `default` budget and the `burst` window apply to every route (per-route `@Throttle` decorators can still override `default`).

### A22: Quick Simulation Scope
- **Decision**: Quick sims (/simulations/quick) require authentication and count against user's first org
- **Rationale**: Prevent abuse; maintain audit trail

---

## Infrastructure

### A23: S3 Path Structure
- **Decision**: `{orgId}/assets/{assetType}/{assetId}/{filename}` and `{orgId}/results/{jobId}/result.json`
- **Rationale**: Organized by org; easy cleanup on org deletion

### A24: Redis Persistence
- **Decision**: Redis configured with RDB snapshots (default Docker config)
- **Rationale**: Acceptable for job queue; jobs can be re-queued if lost

### A25: Database Connection Pool
- **Decision**: Default Prisma pool size (depends on environment)
- **Rationale**: Tune in production; default works for development

### A26: Worker Concurrency
- **Decision**: `CONCURRENCY` jobs per worker instance — **default `2`** ([config.ts](../apps/worker-sim/src/config.ts): `CONCURRENCY.default('2')`), overridable via env
- **Rationale**: ngspice is CPU-bound; keep small per-instance concurrency and scale horizontally

---

## Security

### A27: Include Path Whitelist
- **Decision**: `.include` statements in netlists can only reference files in the job's temp directory
- **Rationale**: Prevent arbitrary file read attacks

### A28: Netlist Validation
- **Decision**: Basic validation (no shell metacharacters); rely on ngspice error handling
- **Rationale**: ngspice batch mode is sandboxed; focus on preventing injection

### A29: CORS
- **Decision**: CORS is **enabled** via `app.enableCors()` ([main.ts](../apps/api/src/main.ts)) with an **explicit origin allowlist** from the comma-separated `CORS_ORIGINS` env var, falling back to localhost dev origins when unset
- **Rationale**: Unblocks a browser frontend during development while never reflecting a wildcard origin.
- **Status**: ✅ Shipped. Origin is never a wildcard — `CORS_ORIGINS` drives the allowlist in production; with no env set it defaults to `http://localhost:3000` / `http://localhost:5173` (dev only).

### A30: Audit Log Retention
- **Decision**: No automatic purge in MVP
- **Rationale**: Simple; add retention policy based on compliance needs

---

## Testing

### A31: Test Database
- **Decision**: Use separate test database (same schema, isolated data)
- **Rationale**: Standard practice; prevents test pollution

### A32: Mock ngspice
- **Decision**: Integration tests use real ngspice; unit tests mock spawn
- **Rationale**: Confidence in real behavior; fast unit tests

---

## Documentation

### A33: API Documentation Tool
- **Decision**: Swagger UI via NestJS swagger module, available at `/docs`
- **Rationale**: Auto-generated from decorators; interactive testing

### A34: README Language
- **Decision**: English
- **Rationale**: International developer audience

---

## Future Considerations (Not Implemented in MVP)

These items were explicitly deferred at MVP time. Several have since shipped — see "Shipped since MVP" below; the rest are still deferred:

1. ~~**Email verification**: Not required in MVP~~ — ✅ shipped (email verification + password reset flows now exist)
2. ~~**Password reset**: Not implemented~~ — ✅ shipped (see above)
3. **OAuth providers**: Not implemented (email/password only)
4. **Team invitations**: Org membership created directly in MVP
5. **Billing/quotas**: Not implemented
6. **Subcircuit import**: Not implemented (flat circuits only)
7. **AC/DC sweep with multiple sources**: Single source only
8. ~~**Monte Carlo analysis**: Not supported~~ — ✅ shipped, see A8 above
9. **Schematic layout algorithms**: Basic grid placement only
10. **Collaborative editing**: Single user edit model

### Shipped since MVP

The following capabilities did not exist at MVP time and have since shipped:

- **Monte-Carlo yield / robustness verdicts** (A8 above): `perturbValue`/`perturbCircuit`/`monteCarloVariants`/`computeYield`/`runMonteCarlo` in eda-core, with a Wilson 95% CI and adaptive-N early stop; the worker runs real ngspice per variant (`runMonteCarloBatch`). The generation "verified" verdict now gates on THD and small-signal GAIN, evaluated both at nominal and robustly across tolerance variants.
- **Rate limiting enforcement** (A21 above) and an **explicit CORS allowlist** (A29 above).
- **Additional ngspice-native analyses**, report-only on `SimulationResult`: Fourier/THD, `.meas` measurements, `.tf` DC transfer function, `.noise`, and `.sens` DC sensitivity.
- **Assertion metric enum expansion**: `AssertionDto`/`AcceptanceCriterion` now supports `min | max | final | pp | avg | rms | cutoff | thd | gain` (was a smaller set at MVP time).
- **SPICE netlist round-trip import**: `parseNetlist` now imports analog and digital/XSPICE netlists, preserving `.model`/`.subckt`/`.options`/`.ic` and re-merging split mixed-signal nets.
- **Durable async design loop**: the design-generation loop now runs on a durable BullMQ `design` queue + worker (with graceful shutdown) instead of an in-process detached runner, plus an orphan design-reaper that cleans up stuck jobs.
- **Readiness probes**: a `/health` readiness check pings DB, Redis, and S3 concurrently and reports 503 on degraded dependencies.

---

*Last updated: 2026-07-01*