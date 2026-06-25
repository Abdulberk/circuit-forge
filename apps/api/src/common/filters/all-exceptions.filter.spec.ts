import { ArgumentsHost, BadRequestException, HttpException, Logger, NotFoundException } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';

/** Drive the filter with a mock host; capture the status + JSON body it writes. */
function run(exception: unknown, url = '/api/x', method = 'GET') {
    const json = jest.fn((_body: unknown) => undefined);
    const status = jest.fn((_code: number) => ({ json }));
    const host = {
        switchToHttp: () => ({
            getResponse: () => ({ status }),
            getRequest: () => ({ originalUrl: url, method }),
        }),
    } as unknown as ArgumentsHost;
    new AllExceptionsFilter().catch(exception, host);
    return { statusArg: status.mock.calls[0]?.[0], body: json.mock.calls[0]?.[0] as Record<string, unknown> };
}

describe('AllExceptionsFilter', () => {
    it('HttpException with a string body → normalized envelope (statusCode/code/message/timestamp/path)', () => {
        const { statusArg, body } = run(new NotFoundException('Design job not found'));
        expect(statusArg).toBe(404);
        expect(body).toMatchObject({ statusCode: 404, code: 'NOT_FOUND', message: 'Design job not found', path: '/api/x' });
        expect(typeof body.timestamp).toBe('string');
    });

    it('PRESERVES a structured body (the 429 QUOTA_EXCEEDED fields survive intact)', () => {
        const quota = new HttpException(
            { code: 'QUOTA_EXCEEDED', metric: 'design_jobs', used: 5, limit: 5, period: '2026-06', message: 'Quota exceeded for design_jobs: 5 of 5 used this period.' },
            429,
        );
        const { statusArg, body } = run(quota);
        expect(statusArg).toBe(429);
        expect(body).toMatchObject({
            statusCode: 429,
            code: 'QUOTA_EXCEEDED', // explicit code wins over the status default (TOO_MANY_REQUESTS)
            metric: 'design_jobs',
            used: 5,
            limit: 5,
            period: '2026-06',
        });
        expect(body.message).toMatch(/Quota exceeded/);
    });

    it('PRESERVES a class-validator 400 (message array kept; code added; framework scaffolding stripped)', () => {
        const validator = new BadRequestException({ statusCode: 400, message: ['name must be longer than 2 chars'], error: 'Bad Request' });
        const { statusArg, body } = run(validator);
        expect(statusArg).toBe(400);
        expect(body.statusCode).toBe(400);
        expect(body.code).toBe('BAD_REQUEST');
        expect(body.message).toEqual(['name must be longer than 2 chars']);
        expect(body.error).toBeUndefined(); // duplicate scaffolding removed
    });

    it('an HttpException 5xx (our own, intentional) keeps its message', () => {
        const { statusArg, body } = run(new HttpException('Circuit design failed.', 502));
        expect(statusArg).toBe(502);
        expect(body).toMatchObject({ statusCode: 502, code: 'BAD_GATEWAY', message: 'Circuit design failed.' });
    });

    it('an UNEXPECTED (non-HttpException) error → generic 500, NO leak, logged server-side with the stack', () => {
        const logSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        const { statusArg, body } = run(new Error('connect ECONNREFUSED 10.0.0.5:5432 — prisma internals'), '/api/projects', 'POST');
        expect(statusArg).toBe(500);
        expect(body).toMatchObject({ statusCode: 500, code: 'INTERNAL_ERROR', message: 'Internal server error' });
        // the real cause must NOT reach the client...
        expect(JSON.stringify(body)).not.toMatch(/ECONNREFUSED|prisma/);
        // ...but MUST be logged server-side (with the route + stack)
        expect(logSpy).toHaveBeenCalledTimes(1);
        expect(logSpy.mock.calls[0]![0]).toMatch(/POST \/api\/projects/);
        expect(logSpy.mock.calls[0]![0]).toMatch(/ECONNREFUSED/);
        logSpy.mockRestore();
    });
});
