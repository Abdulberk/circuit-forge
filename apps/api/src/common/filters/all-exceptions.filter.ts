/**
 * Global exception filter — every error response leaves the API in ONE consistent envelope, and an
 * unexpected (non-HttpException) failure can never leak internals to the client.
 *
 * Envelope: { statusCode, code, message, timestamp, path, ...structuredFields }
 *  - HttpException with a STRING body  → message = that string.
 *  - HttpException with an OBJECT body → its fields are PRESERVED (so the structured 429
 *    { code:'QUOTA_EXCEEDED', metric, used, limit, period } and class-validator's { message:[...], error }
 *    survive intact), with statusCode/timestamp/path normalized and a `code` guaranteed.
 *  - Anything else (a bug, a thrown non-HttpException) → 500 with a GENERIC message; the real error +
 *    stack is logged server-side ONLY. No stack, no DB error, no internals ever reach the client.
 *
 * `code` is a stable, machine-readable string (e.g. 'NOT_FOUND', 'QUOTA_EXCEEDED') so a client can branch
 * on it without parsing prose — an explicit `code` in the exception body always wins over the status default.
 */
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';

const CODE_BY_STATUS: Record<number, string> = {
    400: 'BAD_REQUEST',
    401: 'UNAUTHORIZED',
    403: 'FORBIDDEN',
    404: 'NOT_FOUND',
    405: 'METHOD_NOT_ALLOWED',
    409: 'CONFLICT',
    413: 'PAYLOAD_TOO_LARGE',
    415: 'UNSUPPORTED_MEDIA_TYPE',
    422: 'UNPROCESSABLE_ENTITY',
    429: 'TOO_MANY_REQUESTS',
    500: 'INTERNAL_ERROR',
    502: 'BAD_GATEWAY',
    503: 'SERVICE_UNAVAILABLE',
    504: 'GATEWAY_TIMEOUT',
};

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
    private readonly logger = new Logger('ExceptionFilter');

    catch(exception: unknown, host: ArgumentsHost): void {
        const ctx = host.switchToHttp();
        const res = ctx.getResponse<Response>();
        const req = ctx.getRequest<Request>();

        const isHttp = exception instanceof HttpException;
        // body-parser rejects an oversized body with a plain Error carrying `status`/`statusCode` and
        // `type: 'entity.too.large'` — it is not an HttpException, so everything below classified it as an
        // internal fault. A client sending too much data was told the server had broken, forever: an editor
        // autosaving a large design would fail with a 500 and nothing to act on, when the truthful answer is
        // 413 and "your document exceeds the limit". Trusted only when the value is a real client-error
        // status, so a genuine crash carrying a stray `status` field cannot disguise itself as a 4xx.
        const raw = exception as { status?: unknown; statusCode?: unknown };
        const declared =
            typeof raw?.status === 'number' ? raw.status : typeof raw?.statusCode === 'number' ? raw.statusCode : null;
        const status = isHttp
            ? exception.getStatus()
            : declared !== null && declared >= 400 && declared < 500
              ? declared
              : HttpStatus.INTERNAL_SERVER_ERROR;

        const envelope: Record<string, unknown> = {
            statusCode: status,
            code: CODE_BY_STATUS[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'ERROR'),
            message: 'Internal server error',
            timestamp: new Date().toISOString(),
            path: req?.originalUrl,
        };

        if (isHttp) {
            const body = exception.getResponse();
            if (typeof body === 'string') {
                envelope.message = body;
            } else if (body && typeof body === 'object') {
                // Preserve structured fields (QUOTA_EXCEEDED extras, validator message array, …) but keep our
                // normalized statusCode. Strip the framework's duplicate `statusCode`/`error` scaffolding.
                const { statusCode: _ignored, error, ...rest } = body as Record<string, unknown>;
                Object.assign(envelope, rest);
                envelope.statusCode = status;
                if (typeof (rest as { code?: unknown }).code === 'string')
                    envelope.code = (rest as { code: string }).code;
                if (rest.message === undefined && typeof error === 'string') envelope.message = error;
            }
        } else if (status < 500) {
            // A client error that arrived as a plain Error — body-parser's oversized-body rejection is the
            // one that matters. Its own message ("request entity too large") is the useful thing to say, and
            // saying it is not a leak: the client is being told about its OWN request, not about our
            // internals. Not logged as an unhandled fault either, because it is not one.
            envelope.message = exception instanceof Error ? exception.message : 'Request rejected.';
        } else {
            // Unexpected: log the real cause (with stack) server-side; the client gets only the generic body.
            this.logger.error(
                `Unhandled exception on ${req?.method} ${req?.originalUrl}: ` +
                    (exception instanceof Error ? (exception.stack ?? exception.message) : String(exception)),
            );
        }

        res.status(status).json(envelope);
    }
}
