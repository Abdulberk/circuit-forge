# Security Reference

This document describes the security model of Circuit Forge **as implemented in the source tree** (verified 2026-05-29). Every claim below is tied to a specific file. Where the code differs from what the configuration files imply, that gap is called out explicitly rather than glossed over.

The system is split across three packages that matter for security:

| Concern | Where it lives |
|---------|----------------|
| Authentication, authorization, input validation, rate limiting | [apps/api](../apps/api) (NestJS) |
| Netlist sanitization / SPICE injection defense | [packages/eda-core](../packages/eda-core) |
| Simulation process isolation | [apps/worker-sim](../apps/worker-sim) |

---

## 1. Authentication

Authentication is implemented in [apps/api/src/auth](../apps/api/src/auth) using NestJS + Passport + `@nestjs/jwt` and the `argon2` library.

### 1.1 Password hashing (argon2)

Passwords are hashed with `argon2.hash()` on registration and verified with `argon2.verify()` on login. See [auth.service.ts](../apps/api/src/auth/auth.service.ts):

```ts
// register()
const passwordHash = await argon2.hash(password);

// login()
const valid = await argon2.verify(user.passwordHash, password);
if (!valid) {
    throw new UnauthorizedException('Invalid credentials');
}
```

Notes accurate to the code:

- `argon2.hash(password)` is called with **default options** — no explicit `type`, `memoryCost`, `timeCost`, `parallelism`, or `hashLength` is passed. The `argon2` npm package defaults to **argon2id** with its built-in cost parameters. (If you want the tuned 64 MB / 3-pass profile, you must pass an options object — it is not currently configured.)
- The plaintext password is never stored; only `passwordHash` is persisted on the `User` record.
- `login()` returns the same `Invalid credentials` `UnauthorizedException` whether the email is unknown or the password is wrong, avoiding user enumeration via the error message. (Note: argon2 verification only runs when the user exists, so a timing side-channel between "no such user" and "wrong password" is theoretically present.)

### 1.2 JWT access + refresh tokens

Token payload (both tokens use the same payload shape), from [auth.service.ts](../apps/api/src/auth/auth.service.ts):

```ts
export interface JwtPayload {
    sub: string;   // user id
    email: string;
}
```

| | Access token | Refresh token |
|---|---|---|
| Signed in | `generateTokens()` via `jwtService.signAsync(payload)` | `generateTokens()` via `jwtService.signAsync(payload, { secret: JWT_REFRESH_SECRET, expiresIn: '7d' })` |
| Secret | `JWT_SECRET` (configured on `JwtModule` in [auth.module.ts](../apps/api/src/auth/auth.module.ts)) | `JWT_REFRESH_SECRET` (passed inline at sign time) |
| Expiry | **`15m`** — hardcoded in `JwtModule.signOptions.expiresIn` | **`7d`** — hardcoded inline |
| Verified by | `JwtStrategy` ([jwt.strategy.ts](../apps/api/src/auth/strategies/jwt.strategy.ts)) | `jwtService.verify(token, { secret: JWT_REFRESH_SECRET })` in `refresh()` |

The access token is signed by the `JwtModule` configured in [auth.module.ts](../apps/api/src/auth/auth.module.ts):

```ts
JwtModule.registerAsync({
    useFactory: async (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
        signOptions: { expiresIn: '15m' },
    }),
    inject: [ConfigService],
}),
```

> **Important config gap — `JWT_ACCESS_EXPIRES_IN` / `JWT_REFRESH_EXPIRES_IN` are NOT read by the code.** Both [.env](../.env) and [.env.example](../.env.example) define `JWT_ACCESS_EXPIRES_IN=15m` and `JWT_REFRESH_EXPIRES_IN=7d`, but no source file references these variables (verified by grep across `apps/`). The expiries are hardcoded as `15m` (access, in `auth.module.ts`) and `7d` (refresh, inline in `auth.service.ts`). Editing those env vars has **no effect** today. The secrets `JWT_SECRET` and `JWT_REFRESH_SECRET` *are* read via `ConfigService`.

### 1.3 Login / refresh / logout handling

From [auth.controller.ts](../apps/api/src/auth/auth.controller.ts) and [auth.service.ts](../apps/api/src/auth/auth.service.ts):

| Endpoint | Method / status | DTO | Behavior |
|----------|-----------------|-----|----------|
| `POST /auth/register` | `201` | `RegisterDto` | Rejects duplicate email with `409 ConflictException`; hashes password; creates `User` **and** a personal `Organization` with the user as `OWNER`; returns tokens + user. |
| `POST /auth/login` | `200` (`@HttpCode(200)`) | `LoginDto` | Looks up user by email, `argon2.verify`, returns tokens. Failures → `401 Invalid credentials`. |
| `POST /auth/refresh` | `200` | `RefreshDto` | `jwtService.verify(refreshToken, { secret: JWT_REFRESH_SECRET })`; loads the user by `payload.sub`; **issues a brand-new access AND refresh token** (`generateTokens(user)`). Any verify failure → `401 Invalid refresh token`. |
| `POST /auth/logout` | `204` | none | **No-op on the server.** The handler body is empty; the comment states "Client should delete tokens." There is no server-side token blacklist / revocation store. |

Consequences accurate to the code:

- **Tokens are stateless and non-revocable.** There is no `tokenVersion` column, no `RefreshToken` table, and no jti/denylist. A leaked access token is valid until its 15-minute expiry; a leaked refresh token is valid for 7 days. Logout cannot invalidate either.
- **Refresh is not rotating with reuse-detection** in the security sense — it does mint a new refresh token each call, but the old one remains valid until it expires (no server record exists to revoke it).

### 1.4 Passport strategies and guards

| Artifact | File | Purpose |
|----------|------|---------|
| `JwtStrategy` | [strategies/jwt.strategy.ts](../apps/api/src/auth/strategies/jwt.strategy.ts) | Extracts bearer token (`ExtractJwt.fromAuthHeaderAsBearerToken()`), `ignoreExpiration: false`, secret `JWT_SECRET`. `validate()` re-loads the user from DB via `authService.validateUser(payload.sub)` and throws `401` if the user no longer exists. |
| `LocalStrategy` | [strategies/local.strategy.ts](../apps/api/src/auth/strategies/local.strategy.ts) | `usernameField: 'email'`; delegates to `authService.login()`. (Registered but the controller calls `authService.login()` directly rather than via a `LocalAuthGuard`.) |
| `JwtAuthGuard` | [guards/jwt-auth.guard.ts](../apps/api/src/auth/guards/jwt-auth.guard.ts) | Extends `AuthGuard('jwt')`; honors the `@Public()` decorator via `Reflector` to bypass auth on whitelisted routes. |
| `OptionalJwtAuthGuard` | [guards/optional-jwt-auth.guard.ts](../apps/api/src/auth/guards/optional-jwt-auth.guard.ts) | Same as JWT guard but `handleRequest` returns `null` instead of throwing on a missing/invalid token — used for endpoints that work for both anonymous and authenticated callers. |
| `LocalAuthGuard` | [guards/local-auth.guard.ts](../apps/api/src/auth/guards/local-auth.guard.ts) | Thin `AuthGuard('local')` wrapper. |
| `@Public()` | [decorators/public.decorator.ts](../apps/api/src/auth/decorators/public.decorator.ts) | `SetMetadata('isPublic', true)` to mark routes that skip JWT. |
| `@CurrentUser()` | [decorators/current-user.decorator.ts](../apps/api/src/auth/decorators/current-user.decorator.ts) | Param decorator returning `request.user` (the object produced by `JwtStrategy.validate`: `{ id, email, name, createdAt }`). |

> Note: `JwtAuthGuard` is **not** registered as a global `APP_GUARD` in [app.module.ts](../apps/api/src/app.module.ts). Authentication is therefore opt-in per controller/route via `@UseGuards(JwtAuthGuard)`. Verify each protected controller applies the guard.

---

## 2. Authorization (RBAC)

### 2.1 Roles

Roles come from the `OrgRole` enum in [schema.prisma](../apps/api/prisma/schema.prisma):

```prisma
enum OrgRole {
  OWNER
  ADMIN
  MEMBER
}
```

A user's role is scoped to an organization through the `OrgMembership` model, which has a composite unique key `@@unique([orgId, userId])`. A user belongs to many orgs and may hold a different role in each. On registration (and on `OrgsService.create`) the creating user is made `OWNER` of the new org ([auth.service.ts](../apps/api/src/auth/auth.service.ts), [orgs.service.ts](../apps/api/src/orgs/orgs.service.ts)).

### 2.2 Enforcement — `OrgsService.checkMembership`

All org-scoped authorization funnels through one method in [orgs.service.ts](../apps/api/src/orgs/orgs.service.ts):

```ts
async checkMembership(orgId: string, userId: string, requiredRoles?: string[]) {
    const membership = await this.prisma.orgMembership.findUnique({
        where: { orgId_userId: { orgId, userId } },
    });
    if (!membership) {
        throw new ForbiddenException('Not a member of this organization');
    }
    if (requiredRoles && !requiredRoles.includes(membership.role)) {
        throw new ForbiddenException('Insufficient permissions');
    }
    return membership;
}
```

`requireMembership()` is a thin alias of `checkMembership()` used by the templates and assets services. Authorization is enforced **in service methods**, not via a declarative role guard/decorator (there is no `@OrgRoles()` decorator in the codebase). Each service method must call `checkMembership`/`requireMembership` itself — there is no central interceptor that does it automatically.

### 2.3 Resource ownership checks

The pattern across services is: load the resource → derive its `orgId` → assert the caller is a member of that org (optionally with a role floor). Verified call sites:

| Resource / action | File & method | Check performed |
|-------------------|---------------|-----------------|
| List projects in org | [projects.service.ts](../apps/api/src/projects/projects.service.ts) `findAllForOrg` | `checkMembership(orgId, userId)` (any role) |
| Get / update project | `findOne`, `update` | loads project, then `checkMembership(project.orgId, userId)` (any role) |
| Create project | `create` | `checkMembership(orgId, userId)` (any role) |
| **Delete project** | `delete` | `checkMembership(project.orgId, userId, ['OWNER', 'ADMIN'])` — MEMBER is rejected |
| Simulation status / result | [simulation.service.ts](../apps/api/src/simulation/simulation.service.ts) `getStatus`, `getResult` | `checkMembership(job.orgId, userId)` (any role) |
| Templates: create / list / get | [templates.service.ts](../apps/api/src/templates/templates.service.ts) | `requireMembership(orgId, userId)` (any role) |
| **Templates: delete** | `templates.service.ts` | `requireMembership` then explicit `role !== 'OWNER' && role !== 'ADMIN'` → `ForbiddenException`. Public templates (`orgId == null`) cannot be deleted via API at all. |
| Assets: presign / create / list / get | [assets.service.ts](../apps/api/src/assets/assets.service.ts) | `requireMembership(orgId, userId)` (any role) |
| **Assets: delete** | `assets.service.ts` `deleteAsset` | `requireMembership` then explicit `role !== 'OWNER' && role !== 'ADMIN'` → `BadRequestException('Only admins can delete assets')` |

Effective permission matrix (derived strictly from the checks above):

| Action | OWNER | ADMIN | MEMBER |
|--------|:-----:|:-----:|:------:|
| View org / list & view projects | ✓ | ✓ | ✓ |
| Create / update project | ✓ | ✓ | ✓ |
| Delete project | ✓ | ✓ | ✗ |
| Run simulation, view status/result | ✓ | ✓ | ✓ |
| Create / list / view templates & assets | ✓ | ✓ | ✓ |
| Delete template | ✓ | ✓ | ✗ |
| Delete asset | ✓ | ✓ | ✗ |

> There is currently **no distinct OWNER-only tier in code** (e.g., member management / org deletion / ownership transfer are not implemented as guarded endpoints in the services reviewed). OWNER and ADMIN have identical effective privileges over the resources above.

> Asset deletion throws `BadRequestException` (HTTP 400) rather than `ForbiddenException` (403) for the role failure — a cosmetic inconsistency worth noting for API clients.

---

## 3. Input validation

Validation is layered: a global NestJS pipe over class-validator DTOs at the HTTP edge, plus Zod schemas in `eda-core` for circuit/analysis domain objects.

### 3.1 Global `ValidationPipe`

Registered in [main.ts](../apps/api/src/main.ts):

```ts
app.useGlobalPipes(
    new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
    }),
);
```

| Option | Effect |
|--------|--------|
| `whitelist: true` | Strips any request property not declared on the DTO. |
| `forbidNonWhitelisted: true` | **Rejects** the request (400) if it contains undeclared properties — stronger than silent stripping; prevents mass-assignment / unexpected fields. |
| `transform: true` | Coerces the payload into the DTO class instance (and primitive types) so decorators run against typed values. |

### 3.2 class-validator DTOs

Example, [auth/dto/index.ts](../apps/api/src/auth/dto/index.ts):

```ts
export class RegisterDto {
    @IsEmail()                 email!: string;
    @IsString() @MinLength(8) @MaxLength(100)  password!: string;
    @IsString() @MinLength(1) @MaxLength(100)  name!: string;
}
export class LoginDto    { @IsEmail() email!: string; @IsString() password!: string; }
export class RefreshDto  { @IsString() refreshToken!: string; }
```

Accurate notes: the password rule is **min 8 / max 100 chars** (the max bounds DoS via huge argon2 inputs); there are **no composition rules** (no required digit/symbol). `LoginDto.password` is only `@IsString()` (no length bounds), which is fine since it is only compared, not hashed-on-input.

### 3.3 Zod schemas in eda-core

Domain payloads (circuit graphs, analysis configs) are validated by Zod in [packages/eda-core/src/schemas](../packages/eda-core/src/schemas):

- [circuit.schema.ts](../packages/eda-core/src/schemas/circuit.schema.ts) — `CircuitJsonSchema`: bounded arrays (`components`/`nets` `.max(1000)`, `pins` 1–20), `version` must match `^\d+\.\d+$`, component `type` is an enum, `designator` matches `^[A-Z][A-Z0-9]*[0-9]+$/i`, string length caps throughout. Exposes `validateCircuitJson` (throws) and `safeValidateCircuitJson` (returns result).
- [analysis.schema.ts](../packages/eda-core/src/schemas/analysis.schema.ts) — `AnalysisConfigSchema` is a `discriminatedUnion('type', …)` over `tran`/`ac`/`dc`/`op`. `SpiceValueSchema` enforces a numeric-with-unit regex. `ProbeSchema` enforces `v(node)`/`i(device)` format. `SimulationRequestSchema` bounds `probes` (`.max(100)`) and `modelAssets` (UUIDs, `.max(10)`).

> Caveat accurate to code: in [simulation.service.ts](../apps/api/src/simulation/simulation.service.ts), `createFromVersion` / `createQuickSim` accept `analysisConfig` as `Record<string, unknown>` and **cast** it to `AnalysisConfig` for `generateNetlist` rather than calling `validateAnalysisConfig` at the service boundary. Relying on these Zod schemas requires the DTO/controller layer to invoke them; the simulation service itself does not. The netlist string is still sanitized downstream (Section 5).

### 3.4 SQL injection

All DB access is via Prisma Client (parameterized queries / prepared statements). No raw string-concatenated SQL appears in the reviewed services.

---

## 4. Rate limiting

Configured in [app.module.ts](../apps/api/src/app.module.ts) with `@nestjs/throttler` using two named tiers:

```ts
ThrottlerModule.forRoot([
    { name: 'short',  ttl: 1000,  limit: 10  },   // 10 requests / 1 second
    { name: 'medium', ttl: 60000, limit: 120 },   // 120 requests / 60 seconds
]),
```

| Tier | Window (`ttl`) | Limit | Intent |
|------|----------------|-------|--------|
| `short` | 1 s | 10 req | burst protection |
| `medium` | 60 s | 120 req | sustained-rate cap |

Both tiers apply simultaneously (a request must satisfy all named throttlers). On breach, throttler returns `429 Too Many Requests`.

> Accurate gaps to note:
> - `ThrottlerModule` is configured but **`ThrottlerGuard` is not registered as a global `APP_GUARD`** in `app.module.ts`, and no `@UseGuards(ThrottlerGuard)` was found. As written, the limits are defined but **not enforced** unless a guard is wired up. To activate, add `{ provide: APP_GUARD, useClass: ThrottlerGuard }`.
> - The `RATE_LIMIT_TTL` / `RATE_LIMIT_LIMIT` env vars in [.env](../.env) are **not read** — the tiers above are hardcoded in milliseconds. There are no per-endpoint `@Throttle()` overrides on `/auth/login` etc.

---

## 5. Simulation sandboxing (SPICE injection defense + process isolation)

Untrusted netlists are the highest-risk input: ngspice can read files (`.include`) and, in some builds, run shell commands. Defense is split between **content sanitization** in eda-core and **process isolation** in worker-sim.

### 5.1 Netlist sanitization — [sanitizer.ts](../packages/eda-core/src/netlist/sanitizer.ts)

`sanitizeNetlist(netlist, jobDir)` scans the netlist line-by-line before it is written to disk:

- **`.include` whitelisting** — when a line starts with `.include`, the path is extracted (`/\.include\s+["']?([^"'\s]+)["']?/i`) and passed to `validateIncludePath`, which rejects:
  - absolute paths — Unix (`/…`) or Windows (`^[A-Za-z]:`) → `SecurityError('ABSOLUTE_PATH')`
  - path traversal — any `..` → `SecurityError('PATH_TRAVERSAL')`
  - special prefixes — leading `~` or `$` (home/env expansion) → `SecurityError('SPECIAL_PREFIX')`
  - illegal characters — anything outside `^[a-zA-Z0-9_\-./]+$` → `SecurityError('INVALID_CHARS')`
  - The net effect is that includes are constrained to **relative paths inside the per-job directory** (where model files written by the worker live).
- **Dangerous-directive blocking** — any line starting with `.shell` or `.system` → `SecurityError('SHELL_COMMAND')`. This blocks ngspice's command-execution directives outright.
- **`SecurityError`** is a typed `Error` subclass carrying a machine-readable `code` (the values above), so callers can distinguish reasons.

Supporting helpers (defense-in-depth for values/identifiers):

| Helper | Behavior |
|--------|----------|
| `sanitizeNodeName(name)` | Reduces to `[A-Za-z0-9_]`, ensures non-numeric leading char, prefixes reserved words (`all/none/in/out/vcc/vdd/vss/gnd/ground`) with `x_`, never returns empty. |
| `sanitizeValue(value)` | Strips to `[A-Za-z0-9 ()+\-.,_]` — removes shell/SPICE metacharacters from component values. |
| `validateDesignator(d)` | Boolean check `^[A-Za-z][A-Za-z0-9]*[0-9]+$`. |
| `hasShellMetacharacters(str)` | Detects `[;&|`$<>\\!#{}[\]*?'"]` for rejecting shell-injection attempts. |

> Accurate caveat: `validateIncludePath` does **not** call `fs.realpathSync`/symlink-resolution; it is a pure string/regex check (the `_jobDir` argument is unused). Traversal and absolute-path escapes are blocked by the rules above, but symlink-based escapes are not separately resolved. The strongest backstop is that ngspice runs with `cwd` set to the isolated job dir (below).

### 5.2 Process isolation — [runner.ts](../apps/worker-sim/src/simulation/runner.ts)

`runSimulation(input)` and `executeNgspice(netlistPath)` enforce isolation:

- **Per-job temp directory.** `jobDir = path.join(config.SIM_TEMP_DIR, input.jobId)` is created with `fs.mkdir({ recursive: true })`. The sanitized `circuit.cir` and any model files are written only there.
- **Sanitize before write.** `sanitizeNetlist(input.netlist, jobDir)` (Section 5.1) runs before `fs.writeFile`, so a `SecurityError` aborts the job before ngspice ever runs.
- **No shell.** ngspice is launched with `spawn(config.NGSPICE_PATH, ['-b', '-o', 'stdout.log', netlistPath], { cwd, stdio: ['ignore','pipe','pipe'], timeout })` — an **args array, never a shell string**, so netlist content cannot break out into shell. `cwd` is the job dir, confining relative includes.
- **Timeout + hard kill.** Two layers: `spawn(..., { timeout: config.SIM_TIMEOUT_MS })` plus an explicit `setTimeout` that sets `timedOut = true` and calls `process.kill('SIGKILL')` after `SIM_TIMEOUT_MS`. A timed-out job returns `{ success: false, error: 'Simulation timed out' }`.
- **Output cap.** After reading `output.csv`, the runner computes `Buffer.byteLength` and rejects results larger than `config.SIM_MAX_OUTPUT_BYTES` (`Output too large: …`), bounding memory/disk.
- **Guaranteed cleanup.** A `finally` block runs `fs.rm(jobDir, { recursive: true, force: true })` whether the job succeeds, fails, or throws — no per-job artifacts persist.

Relevant config defaults (validated by Zod in [config.ts](../apps/worker-sim/src/config.ts)):

| Var | Default | Meaning |
|-----|---------|---------|
| `SIM_TIMEOUT_MS` | `10000` (10 s) | wall-clock limit → SIGKILL |
| `SIM_MAX_OUTPUT_BYTES` | `5242880` (5 MB) | max parsed output size |
| `SIM_TEMP_DIR` | `/tmp/sim` | base dir for per-job folders |
| `NGSPICE_PATH` | `ngspice` | executable (resolved from `PATH`) |

The worker config self-validates with Zod at startup and `process.exit(1)` on any invalid/missing required var (e.g., `DATABASE_URL`, S3 keys), so a misconfigured worker fails fast rather than running insecurely.

> Note: these are **application-level** controls. There is no container/seccomp/cgroup sandbox or dropped-privilege user configured in the code reviewed; in production, run the worker in a locked-down container with CPU/memory/PID limits as an additional layer (Section 7).

---

## 6. Secrets & configuration

### 6.1 How env is loaded

- **API** ([app.module.ts](../apps/api/src/app.module.ts)): `ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env.local', '.env', '../../.env'] })`. Per-package files win; the **monorepo root [.env](../.env)** is the canonical fallback.
- **worker-sim** ([config.ts](../apps/worker-sim/src/config.ts)): `dotenv.config({ path: path.resolve(process.cwd(), '../../.env') })` then a plain `dotenv.config()` overlay. Because apps run with CWD = their package dir, `../../.env` resolves to the repo root.

### 6.2 Secrets inventory (from [.env](../.env))

| Secret / var | Read by code? | Notes |
|--------------|:-------------:|-------|
| `JWT_SECRET` | ✅ | access-token signing/verification |
| `JWT_REFRESH_SECRET` | ✅ | refresh-token signing/verification |
| `JWT_ACCESS_EXPIRES_IN` | ❌ | **not referenced anywhere** — access expiry is hardcoded `15m` |
| `JWT_REFRESH_EXPIRES_IN` | ❌ | **not referenced anywhere** — refresh expiry is hardcoded `7d` |
| `DATABASE_URL` | ✅ | Postgres connection (Prisma; worker Zod-validated) |
| `REDIS_URL` | ✅ | BullMQ queue |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | ✅ | MinIO/S3 credentials |
| `RATE_LIMIT_TTL` / `RATE_LIMIT_LIMIT` | ❌ | **not referenced** — throttler tiers are hardcoded |
| `PORT` | ✅ | API listen port (`process.env.PORT || 3000`) |
| `API_PORT` / `API_HOST` | ❌ | **`API_PORT` is not read by any code** — the API binds `PORT`. `.env` sets `PORT=3001` locally (3000 was taken). Documented mismatch. |

### 6.3 Weak dev defaults — MUST change for production

The committed [.env](../.env) ships **placeholder/weak secrets** intended only for local development:

```
JWT_SECRET=your-super-secret-jwt-key-min-32-characters
JWT_REFRESH_SECRET=your-super-secret-refresh-key-min-32-characters
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/circuitforge   # password "postgres"
```

These are **known, guessable, and identical to [.env.example](../.env.example)**. In any non-local environment you MUST replace every one of them with strong, unique, randomly generated values (JWT secrets ≥ 32 bytes of entropy each, and distinct from one another). Never commit real secrets; inject them via the deployment environment / secret manager.

---

## 7. Hardening checklist for production

Code-accurate gaps to close before exposing this beyond local dev:

- [ ] **Rotate all secrets.** Replace the dev `JWT_SECRET`, `JWT_REFRESH_SECRET`, `S3_ACCESS_KEY/SECRET_KEY`, and DB credentials with strong random values (Section 6.3). Distinct JWT signing keys.
- [ ] **Enable rate limiting enforcement.** Register `ThrottlerGuard` as a global `APP_GUARD` — it is configured but currently not applied (Section 4). Consider a stricter per-endpoint `@Throttle()` on `/auth/login` and `/auth/register`.
- [ ] **Apply JWT auth globally or audit per-route guards.** `JwtAuthGuard` is not a global guard (Section 1.4); confirm every non-`@Public()` route is protected, or register it as `APP_GUARD`.
- [ ] **Add token revocation.** Implement a refresh-token store or `tokenVersion`, and make `POST /auth/logout` actually invalidate tokens — today it is a no-op and tokens are non-revocable (Section 1.3).
- [ ] **Wire the unused expiry env vars** (`JWT_ACCESS_EXPIRES_IN`, `JWT_REFRESH_EXPIRES_IN`) into `JwtModule`/`generateTokens`, or remove them from `.env` to avoid the false impression they are configurable (Section 1.2 / 6.2).
- [ ] **Validate analysis config at the API boundary.** Call `validateAnalysisConfig` (Zod) in the simulation controller/DTO rather than casting `Record<string, unknown>` (Section 3.3).
- [ ] **Tune argon2 cost** explicitly (memory/time/parallelism) instead of relying on library defaults if your threat model requires it (Section 1.1).
- [ ] **Sandbox the worker at the OS level.** Run worker-sim in a hardened container with CPU/memory/PID/disk limits, a non-root user, read-only root FS, and a writable-only temp dir — app-level timeout/output caps are not a substitute (Section 5.2).
- [ ] **Lock down infrastructure.** S3/MinIO bucket non-public; Postgres and Redis not internet-exposed; TLS terminated in front of the API.
- [ ] **Configure CORS explicitly.** [main.ts](../apps/api/src/main.ts) calls `app.enableCors()` with **no options**, which allows all origins. Restrict to known origins for production.
- [ ] **Add security headers.** No `helmet` is configured in `main.ts`; add it (or equivalent) at the edge/proxy.
- [ ] **Reconcile `PORT` vs `API_PORT`.** Code reads `PORT`; `.env`/compose also carry `API_PORT`, which is ignored — standardize to avoid a port mismatch in deployment (Section 6.2).
- [ ] **Confirm `argon2`/native deps build in the target image**, and keep dependencies patched (`pnpm audit`).

---

## See also

- [README.md](../README.md)
- [docs/ARCHITECTURE.md](ARCHITECTURE.md)
- [docs/API.md](API.md)
- [docs/DATA_MODEL.md](DATA_MODEL.md)
- [docs/EDA_CORE.md](EDA_CORE.md)
- [docs/SIMULATION.md](SIMULATION.md)
- [docs/SECURITY.md](SECURITY.md)
- [LOCAL_SETUP.md](../LOCAL_SETUP.md)
