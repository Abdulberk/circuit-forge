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
- **Decision**: 120 requests per 60 seconds per user
- **Rationale**: Generous for normal use; prevents abuse

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
- **Decision**: Single concurrent job per worker instance
- **Rationale**: ngspice is CPU-bound; scale horizontally

---

## Security

### A27: Include Path Whitelist
- **Decision**: `.include` statements in netlists can only reference files in the job's temp directory
- **Rationale**: Prevent arbitrary file read attacks

### A28: Netlist Validation
- **Decision**: Basic validation (no shell metacharacters); rely on ngspice error handling
- **Rationale**: ngspice batch mode is sandboxed; focus on preventing injection

### A29: CORS
- **Decision**: Disabled in MVP (no frontend); enable with allowlist when needed
- **Rationale**: Backend-only focus; configure when frontend is added

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

These items are explicitly deferred:

1. **Email verification**: Not required in MVP
2. **Password reset**: Not implemented
3. **OAuth providers**: Not implemented (email/password only)
4. **Team invitations**: Org membership created directly in MVP
5. **Billing/quotas**: Not implemented
6. **Subcircuit import**: Not implemented (flat circuits only)
7. **AC/DC sweep with multiple sources**: Single source only
8. **Monte Carlo analysis**: Not supported
9. **Schematic layout algorithms**: Basic grid placement only
10. **Collaborative editing**: Single user edit model

---

*Last updated: Initial version*