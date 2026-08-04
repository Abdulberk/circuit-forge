/**
 * Root Application Module
 */
import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';

import { AdminModule } from './admin/admin.module';
import { AssetsModule } from './assets/assets.module';
import { AuthModule } from './auth/auth.module';
import { AuditModule } from './common/audit/audit.module';
import { requestContextMiddleware } from './common/context/request-context';
import { validateEnv } from './config/env.validation';
import { DesignChecksModule } from './design-checks/design-checks.module';
import { GenerationModule } from './generation/generation.module';
import { HealthModule } from './health/health.module';
import { InvitationsModule } from './invitations/invitations.module';
import { LayoutModule } from './layout/layout.module';
import { NetlistModule } from './netlist/netlist.module';
import { OrgsModule } from './orgs/orgs.module';
import { PartsModule } from './parts/parts.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProjectsModule } from './projects/projects.module';
import { SimulationModule } from './simulation/simulation.module';
import { TemplatesModule } from './templates/templates.module';
import { UsageModule } from './usage/usage.module';
import { VersionsModule } from './versions/versions.module';
import { WorkingCopyModule } from './working-copy/working-copy.module';

@Module({
    imports: [
        // Config
        ConfigModule.forRoot({
            isGlobal: true,
            // Per-package files win; the monorepo root .env (two levels up) is the fallback.
            envFilePath: ['.env.local', '.env', '../../.env'],
            // Fail fast at boot on missing/weak JWT secrets — never start with forgeable tokens.
            validate: validateEnv,
        }),

        // Rate limiting. Two layers, both enforced by the global ThrottlerGuard registered below
        // (APP_GUARD — WITHOUT it every @Throttle is inert):
        //  - 'default': the sustained per-route budget. Every @Throttle({ default: {…} }) decorator
        //    in the app overrides THIS one (the name must match the decorator key — they were all
        //    'default' but the throttler was misnamed 'medium', so none bound; fixed here). Routes
        //    with no decorator inherit 120/min.
        //  - 'burst': a universal short-window guard against hammering; not route-overridable.
        // skipIf disables throttling under jest so the AppModule integration suites (which fire
        // request bursts from one IP) aren't rate-limited.
        ThrottlerModule.forRoot({
            throttlers: [
                { name: 'default', ttl: 60000, limit: 120 },
                { name: 'burst', ttl: 1000, limit: 30 },
            ],
            skipIf: () => process.env.NODE_ENV === 'test',
        }),

        // Database
        PrismaModule,

        // Cross-cutting: centralized audit writer (global).
        AuditModule,

        // Feature modules
        AuthModule,
        OrgsModule,
        InvitationsModule,
        ProjectsModule,
        VersionsModule,
        WorkingCopyModule,
        DesignChecksModule,
        TemplatesModule,
        AssetsModule,
        SimulationModule,
        GenerationModule,
        LayoutModule,
        PartsModule,
        NetlistModule,
        UsageModule,
        HealthModule,
        AdminModule,
    ],
    providers: [
        // Activates the rate limiter for EVERY route (the @Throttle decorators only override the
        // default per route). Without this provider, nothing in the app is actually throttled.
        { provide: APP_GUARD, useClass: ThrottlerGuard },
    ],
})
export class AppModule implements NestModule {
    // Mint a per-request correlation id (x-request-id) for EVERY route before anything else runs, so
    // guards/services/AuditService all share it. Registered here (not just in main.ts) so the
    // integration tests, which bootstrap AppModule directly, also get request context.
    configure(consumer: MiddlewareConsumer): void {
        consumer.apply(requestContextMiddleware).forRoutes('*');
    }
}
