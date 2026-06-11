/**
 * Root Application Module
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { OrgsModule } from './orgs/orgs.module';
import { ProjectsModule } from './projects/projects.module';
import { VersionsModule } from './versions/versions.module';
import { TemplatesModule } from './templates/templates.module';
import { AssetsModule } from './assets/assets.module';
import { SimulationModule } from './simulation/simulation.module';
import { GenerationModule } from './generation/generation.module';
import { PartsModule } from './parts/parts.module';
import { NetlistModule } from './netlist/netlist.module';
import { HealthModule } from './health/health.module';

@Module({
    imports: [
        // Config
        ConfigModule.forRoot({
            isGlobal: true,
            // Per-package files win; the monorepo root .env (two levels up) is the fallback.
            envFilePath: ['.env.local', '.env', '../../.env'],
        }),

        // Rate limiting
        ThrottlerModule.forRoot([
            {
                name: 'short',
                ttl: 1000,
                limit: 10,
            },
            {
                name: 'medium',
                ttl: 60000,
                limit: 120,
            },
        ]),

        // Database
        PrismaModule,

        // Feature modules
        AuthModule,
        OrgsModule,
        ProjectsModule,
        VersionsModule,
        TemplatesModule,
        AssetsModule,
        SimulationModule,
        GenerationModule,
        PartsModule,
        NetlistModule,
        HealthModule,
    ],
})
export class AppModule { }