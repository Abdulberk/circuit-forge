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
| `POST /auth/refresh` | `200` | `RefreshDto` | **Rotating and single-use.** Verifies the token, then atomically claims its server-side `RefreshToken` row by `jti` and issues a fresh pair. Bad signature / missing `jti` / no row / hash mismatch / expired / revoked → `401`. |
| `POST /auth/logout` | `204` | `LogoutDto` | **Server-side revocation.** Verifies the refresh token (expired ones still accepted, so a stale session can be cleaned up) and revokes its family — or every session for the user when `allDevices` is set. |

Consequences accurate to the code:

- **Refresh tokens ARE revocable.** Each carries a `jti` keyed to a `RefreshToken` row (`jti`, `familyId`,
  `tokenHash`, `usedAt`, `revokedAt`). Logout revokes; so does an admin's force-logout.
- **Reuse is detected and punished.** Presenting an already-used refresh token is treated as theft: the
  **entire family** is revoked and the event is audited (`refresh_reuse_detected`). The legitimate holder is
  logged out too — deliberately, because at that point we cannot tell which party is the attacker, and
  ending both sessions is the safe answer.
- **Access tokens remain stateless.** A leaked access token is valid until its 15-minute expiry; there is no
  per-request denylist, and adding one would put a datastore read in front of every authenticated call. The
  15-minute window is the mitigation, and it is a deliberate trade.

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

> **There are two independent authorization axes, and this section describes only the first.**
>
> **Tenant** authorization (`OrgMembership.role`) governs access to an org's own data and is what the rest
> of this section covers. **Platform** authorization (`User.platformRole`: `NONE` < `SUPPORT` < `OPERATOR` <
> `ADMIN`) governs the cross-tenant operator surface at `/admin/*`, which deliberately **ignores org
> membership** — that is its whole purpose.
>
> It is enforced declaratively by `@PlatformRoles(min)` + `PlatformAdminGuard`, with three properties that
> matter for a security review: the role is resolved **live from the database on every request**, so
> revoking it takes effect immediately rather than when a JWT expires; the guard **fails closed**; and every
> mutation is written to `AuditLog` with the request id and a before/after snapshot. Those audit rows are
> `SetNull` on both `userId` and `orgId`, so they **outlive** the user or org they describe — deleting the
> subject cannot erase the evidence.

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

> **OWNER and ADMIN are NOT equivalent.** Member management ships (`GET`/`PATCH`/`DELETE /orgs/:orgId/members/...`) and enforces two role-level rules beyond the controller gate: only an **OWNER** may grant or revoke the OWNER role — an ADMIN can shuffle MEMBER/ADMIN but can neither mint nor unseat an owner — and **an org may never lose its last OWNER**, so the final owner cannot be demoted or removed and orphan an organization. Both write a tenant audit row.
>
> Org deletion and ownership transfer are still not exposed as endpoints.

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
ThrottlerModule.forRoot({
    throttlers: [
        { name: 'default', ttl: 60000, limit: 120 },  // sustained, route-overridable
        { name: 'burst',   ttl: 1000,  limit: 30  },  // burst guard, NOT route-overridable
    ],
    skipIf: () => process.env.NODE_ENV === 'test',
}),
```

| Tier | Window (`ttl`) | Limit | Intent |
|------|----------------|-------|--------|
| `default` | 60 s | 120 req | sustained per-route budget; a `@Throttle({ default: {…} })` decorator overrides it for that route |
| `burst` | 1 s | 30 req | universal short-window guard; deliberately **not** route-overridable, so no endpoint can opt out of it |

Both tiers apply simultaneously (a request must satisfy every named throttler). On breach the throttler
returns `429 Too Many Requests` — with `code: 'TOO_MANY_REQUESTS'`, which is how a client tells it apart
from a `QUOTA_EXCEEDED` 429 (an org limit, a different remedy).

**Enforcement is global:** `{ provide: APP_GUARD, useClass: ThrottlerGuard }` in `app.module.ts` — without
that registration every `@Throttle` decorator would be inert. Throttling is skipped under `NODE_ENV=test`
so a suite firing bursts from one IP is not rate-limited by its own speed.

**Sensitive routes carry their own overrides**, tightened well below the default:

| Route | Limit |
|---|---|
| `POST /auth/login` | 10 / 60 s |
| `POST /auth/register`, `/auth/verify-email` | 20 / hour |
| `POST /auth/forgot-password`, `/auth/resend-verification` | 5 / hour |
| `POST /auth/reset-password` | 10 / hour |
| `POST /layouts` | 5 / 60 s |

> Remaining gap: the `RATE_LIMIT_TTL` / `RATE_LIMIT_LIMIT` env vars are **not read** — the tiers are
> hardcoded. Changing a limit is a code change, not a deploy-time one.

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
- **Kernel resource limits + non-root user (Linux).** [sandbox.ts](../apps/worker-sim/src/simulation/sandbox.ts) wraps the spawn as `bash -c 'ulimit -v <mem> -t <cpu> -f <fsize> -u <procs>; exec [su-exec <user>] "$@"'`, so the kernel caps virtual memory (RLIMIT_AS), CPU seconds (RLIMIT_CPU), output-file size (RLIMIT_FSIZE) and process/thread count (RLIMIT_NPROC) per run. The default worker image runs the **whole worker process — and therefore the ngspice it spawns — as a single dedicated non-root user (`ngsim`, via `USER ngsim`)**, so there is no su-exec branch (`exec "$@"`) and the container needs no Linux capabilities. The legacy **two-user** mode (a root worker that su-exec-drops only the ngspice child to a separate `SIM_SANDBOX_USER`) is still supported by the wrapper but is no longer the image default. Args ride as argv (`"$@"`), never interpolated, so the netlist can't inject shell. No-op on non-Linux dev. **Verified on Alpine (two-user mode):** an over-CPU loop and an over-size write are terminated (SIGXCPU / SIGXFSZ, file capped) and the privilege drop yields the dedicated user.
- **Guaranteed cleanup.** A `finally` block runs `fs.rm(jobDir, { recursive: true, force: true })` whether the job succeeds, fails, or throws — no per-job artifacts persist.

Relevant config defaults (validated by Zod in [config.ts](../apps/worker-sim/src/config.ts)):

| Var | Default | Meaning |
|-----|---------|---------|
| `SIM_TIMEOUT_MS` | `10000` (10 s) | wall-clock limit → SIGKILL |
| `SIM_MAX_OUTPUT_BYTES` | `5242880` (5 MB) | max parsed output size |
| `SIM_TEMP_DIR` | `/tmp/sim` | base dir for per-job folders |
| `NGSPICE_PATH` | `ngspice` | executable (resolved from `PATH`) |
| `SIM_SANDBOX` | `auto` | `rlimit` on Linux, `none` elsewhere — kernel resource caps for ngspice |
| `SIM_SANDBOX_{MEMORY_MB,CPU_SEC,FSIZE_MB,NPROC}` | 2048 / ~2×timeout / 256 / 64 | RLIMIT_AS / CPU / FSIZE / NPROC. The worker image sets `SIM_SANDBOX_NPROC=256` — with one uid the worker's own threads share the per-uid budget, and container `pids_limit` is the hard cap. |
| `SIM_SANDBOX_USER` | (unset) | **Optional** legacy two-user mode: su-exec-drop the ngspice child to this user (needs a **root** worker; runner.ts then loosens the job dir to 0777 so that user can write output). The default image runs the whole worker as non-root `ngsim`, so this is unset. |

The worker config self-validates with Zod at startup and `process.exit(1)` on any invalid/missing required var (e.g., `DATABASE_URL`, S3 keys), so a misconfigured worker fails fast rather than running insecurely.

### 5.3 Container-level isolation (deployment) — [docker-compose.yml](../docker-compose.yml)

The `worker-sim` service runs the untrusted-ngspice tier under **host-independent** container controls that stack UNDER the in-process rlimit wrapper + non-root user (§5.2). Unlike a user-namespace sandbox (bubblewrap), these need no seccomp relaxation or host unprivileged-userns support, so they apply on any container runtime:

- **Read-only root + tmpfs.** `read_only: true` with `tmpfs: [/tmp/sim:mode=1777, /tmp:mode=1777]`. The only writable paths are the per-job temp areas: `SIM_TEMP_DIR=/tmp/sim` (job dirs) and `/tmp` (ngspice spools `.control` blocks there via libc `tmpfile()`, which ignores `$TMPDIR`). `mode=1777` lets the non-root `ngsim` user create per-job dirs in the overlaid tmpfs. The built image needs no other runtime writes.
- **No capabilities.** `cap_drop: [ALL]` with **no re-add** — the single-uid worker performs no privilege transition (no su-exec), so it needs zero Linux capabilities; NET_RAW, SYS_ADMIN, SETUID, CHOWN, … are all removed.
- **No privilege escalation.** `security_opt: [no-new-privileges:true]` — a setuid-bit binary can never grant privileges, belt-and-suspenders on top of the dropped caps.
- **Process + memory ceilings.** `pids_limit: 256` caps total processes container-wide (the hard backing for the per-uid RLIMIT_NPROC); `mem_limit: 2g` is a cgroup RSS cap — stronger than the per-process RLIMIT_AS (virtual address space) the wrapper sets, and it OOM-kills before the host is starved.
- **Networking kept.** The worker KEEPS normal networking (it must reach Postgres/Redis/MinIO). ngspice itself needs no network; isolating the *child's* network is the optional bubblewrap follow-up below — not the worker container's.

> Validation caveat: these keys are config-validated and reasoned-correct but were **not** runtime-validated in-container here. Before a production rollout, smoke-test the built image: the worker boots as `ngsim`, a sim creates its dir in the `/tmp/sim` tmpfs and writes `output.csv`, and the per-uid `RLIMIT_NPROC` does not false-trip under `CONCURRENCY` load (the worker's own threads share the single uid).

> Note: the worker now runs the **whole process as a non-root user** (`ngsim`) with **kernel resource limits** (§5.2) UNDER **container-level read-only-root, ALL capabilities dropped, no-new-privileges, and process/memory ceilings** (§5.3). The stronger **user-namespace / network-egress** sandbox of the ngspice child (rootless bubblewrap) is implemented as an **opt-in** layer — see §5.4.

### 5.4 Bubblewrap namespace cage for ngspice (OPTIONAL, opt-in) — [sandbox.ts](../apps/worker-sim/src/simulation/sandbox.ts)

A defense-in-depth layer that wraps **only the ngspice child** (not the worker process) in a rootless [bubblewrap](https://github.com/containers/bubblewrap) namespace cage. Default **OFF**; enabled with `SIM_BWRAP=1`. When active, each ngspice run gets a fresh **user / mount / PID / IPC / UTS + NETWORK** namespace over a **read-only host root**, with the per-job dir as the only writable real path:

- **Composes with §5.2/§5.3, doesn't replace them.** bwrap is the *outer* wrapper; the `bash` ulimit preamble runs *inside* it, so the RLIMIT_AS/CPU/FSIZE/NPROC caps still apply (rlimits inherit across the bwrap exec). "bwrap = where it can reach; ulimit = how much it can consume."
- **What it adds.** The genuinely new control is `--unshare-net`: the ngspice child has **no network** (only loopback). The worker process keeps its network (it must reach Postgres/Redis/MinIO) — only the spawned ngspice is netns-isolated. So if ngspice were ever exploited (a memory bug), the attacker lands in a no-network box with a read-only root and no host-FS view beyond the job dir. Flags: explicit `--unshare-user` (never the silent `--unshare-all`/`-try`), `--unshare-net/-pid/-ipc/-uts`, `--die-with-parent --new-session`, `--clearenv` + minimal `PATH`/`HOME` (the worker's DB/Redis/S3 env never reaches ngspice), `--ro-bind / /`, `--proc /proc --dev /dev`, `--tmpfs /tmp` (ngspice spools `.control` blocks there), `--bind <jobDir> <jobDir>`, `--chdir <jobDir>`.
- **Single uid.** A rootless bwrap userns maps one uid, so su-exec (the legacy two-user mode) is suppressed under bwrap; ngspice runs as the same non-root user. Timeouts SIGKILL the whole process group (the child is spawned `detached`), and `--unshare-pid` tears down the inner namespace so no descendant is orphaned.
- **Host-conditional + fail-safe.** Rootless userns is blocked by Docker's **default seccomp** profile and may be disabled at the host-kernel level. So enabling needs a host you control (self-managed EC2 / K8s nodes): a relaxed seccomp profile (`seccomp=unconfined` on a trusted host, or a custom profile allowing `clone`/`unshare` with `CLONE_NEWUSER`) **and** `kernel.unprivileged_userns_clone=1` / `user.max_user_namespaces>0` (on by default on AL2023). The worker runs a **startup preflight** (`bwrap --unshare-user --unshare-net --ro-bind / / -- /bin/true`); if it fails it logs loudly and **falls back to the §5.2/§5.3 hardening**, so turning it on can never break job processing on an incapable host. **Not for managed serverless** (Fargate / Cloud Run / restricted K8s), where it will simply stay inert (fallback).

> Validation status: **verified locally** on Docker Desktop's Linux VM (`seccomp=unconfined`): the built image compiles (`tsc` passes), the compiled `sandboxedCommand` emits the correct bwrap argv, ngspice runs **inside the cage** and produces correct output, `--unshare-net` leaves the child with **only loopback** (`/proc/net/dev` → `[lo]` vs the container's `[lo, eth0]`), and under the **default** seccomp the preflight fails (`No permissions to create new namespace`) so the worker falls back. Still **confirm on your actual EC2/K8s target before enabling in prod** — the host kernel + seccomp profile differ from the local VM — but since it is off by default this is a pre-enable check, not a release gate. Enabling guidance is in [docker-compose.yml](../docker-compose.yml) (worker-sim env).

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
- [x] **CORS is an explicit allowlist** — never a wildcard. `CORS_ORIGINS` (comma-separated) drives `origin`, falling back to `http://localhost:3000` / `http://localhost:5173` when unset, with `credentials: true` and only `Content-Type` / `Authorization` allowed. **Set `CORS_ORIGINS` in production**: the localhost fallback is a dev convenience, not a production policy.
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
