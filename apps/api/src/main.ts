/**
 * API Main Entry Point
 */
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
    const app = await NestFactory.create(AppModule, {
        logger: ['error', 'warn', 'log', 'debug', 'verbose'],
    });

    const isProd = process.env.NODE_ENV === 'production';

    // Security headers (HSTS, X-Frame-Options, nosniff, …). CSP is left off so the Swagger UI (when
    // enabled) renders; the API itself serves JSON, not HTML.
    app.use(helmet({ contentSecurityPolicy: false }));

    // Behind a load balancer the real client IP is in X-Forwarded-For; trust one proxy hop so the
    // rate limiter keys on the client, not the proxy. (Express is the underlying HTTP adapter.)
    app.getHttpAdapter().getInstance().set('trust proxy', 1);

    // Global validation pipe
    app.useGlobalPipes(
        new ValidationPipe({
            whitelist: true,
            transform: true,
            forbidNonWhitelisted: true,
        }),
    );

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
}

bootstrap();