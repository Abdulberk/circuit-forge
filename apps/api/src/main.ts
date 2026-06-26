/**
 * API Main Entry Point
 */
// MUST stay first: starts OpenTelemetry (when configured) before any instrumented module loads.
import './observability/instrumentation';
import { shutdownTelemetry } from './observability/telemetry';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

async function bootstrap() {
    const app = await NestFactory.create<NestExpressApplication>(AppModule, {
        logger: ['error', 'warn', 'log', 'debug', 'verbose'],
        bodyParser: true,
    });
    // Raise the JSON body limit above Express's 100KB default so the documented 200KB netlist
    // contract (netlist/import) is actually reachable; 1MB also bounds large circuitJson uploads.
    // (Without this, a 150KB netlist is rejected by Express with a raw 413 before validation.)
    app.useBodyParser('json', { limit: '1mb' });

    const isProd = process.env.NODE_ENV === 'production';

    // Security headers (HSTS, X-Frame-Options, nosniff, …). CSP is left off so the Swagger UI (when
    // enabled) renders; the API itself serves JSON, not HTML.
    app.use(helmet({ contentSecurityPolicy: false }));

    // Proxy trust is OPT-IN: only when TRUST_PROXY is set do we read the client IP from
    // X-Forwarded-For. Default OFF (req.ip = socket address) — otherwise, when the API is reachable
    // without a header-stripping proxy, anyone could spoof X-Forwarded-For to poison audit/session
    // IPs and rotate the rate-limiter key to dodge the per-IP login throttle. Set TRUST_PROXY to the
    // number of trusted hops (e.g. 1) or 'true' ONLY when a proxy is guaranteed to overwrite XFF.
    const trustProxy = process.env.TRUST_PROXY;
    if (trustProxy) {
        const hops = Number(trustProxy);
        app.getHttpAdapter().getInstance().set('trust proxy', Number.isInteger(hops) && hops > 0 ? hops : true);
    }

    // Global validation pipe
    app.useGlobalPipes(
        new ValidationPipe({
            whitelist: true,
            transform: true,
            forbidNonWhitelisted: true,
        }),
    );

    // Global exception filter: one consistent error envelope for every response + no internal leak on an
    // unexpected 500 (the real error is logged server-side only). Registered after the pipe so validation
    // 400s flow through it too.
    app.useGlobalFilters(new AllExceptionsFilter());

    // CORS: allow only configured origins. CORS_ORIGINS is a comma-separated allowlist; with none set
    // we fall back to localhost dev origins (never a wildcard, which would defeat the point).
    const allowedOrigins = (process.env.CORS_ORIGINS ?? '')
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean);
    app.enableCors({
        origin: allowedOrigins.length > 0 ? allowedOrigins : ['http://localhost:3000', 'http://localhost:5173'],
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization'],
        maxAge: 3600,
    });

    // Swagger: never expose the full API surface in production unless explicitly opted in.
    const swaggerEnabled = !isProd || process.env.ENABLE_SWAGGER === 'true';
    if (swaggerEnabled) {
        const config = new DocumentBuilder()
            .setTitle('Circuit Forge API')
            .setDescription('AI Circuit Generator & Simulator API')
            .setVersion('1.0')
            .addBearerAuth()
            .build();
        const document = SwaggerModule.createDocument(app, config);
        SwaggerModule.setup('docs', app, document);
    }

    const port = process.env.PORT || 3000;
    await app.listen(port);

    console.log(`Application is running on: http://localhost:${port}`);
    if (swaggerEnabled) console.log(`Swagger docs: http://localhost:${port}/docs`);

    // Graceful shutdown: close the HTTP server + Nest lifecycle hooks, then flush telemetry, then exit.
    // Telemetry registers no signal handler of its own, so this is the single owner of process exit.
    const shutdown = async (signal: string) => {
        console.log(`Received ${signal}, shutting down...`);
        try {
            await app.close();
        } catch (e) {
            console.error('Error during app.close():', e instanceof Error ? e.message : e);
        }
        await shutdownTelemetry();
        process.exit(0);
    };
    process.once('SIGTERM', () => void shutdown('SIGTERM'));
    process.once('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap();