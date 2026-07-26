import { ConfigService } from '@nestjs/config';

import { resolveEmailTransport } from './email-transports';

const cfg = (vals: Record<string, string>) => ({ get: (k: string) => vals[k] }) as unknown as ConfigService;

describe('resolveEmailTransport (dynamic provider selection)', () => {
    it('defaults to the log transport when nothing is configured', () => {
        expect(resolveEmailTransport(cfg({})).name).toBe('log');
    });

    it('honors an explicit EMAIL_PROVIDER=log', () => {
        expect(
            resolveEmailTransport(cfg({ EMAIL_PROVIDER: 'log', EMAIL_FROM: 'a@b.com', SES_REGION: 'eu-west-1' })).name,
        ).toBe('log');
    });

    it('selects SES when EMAIL_PROVIDER=ses with EMAIL_FROM + a region', () => {
        expect(
            resolveEmailTransport(cfg({ EMAIL_PROVIDER: 'ses', EMAIL_FROM: 'no-reply@cf.io', SES_REGION: 'eu-west-1' }))
                .name,
        ).toBe('ses');
        // AWS_REGION is an accepted region source too
        expect(
            resolveEmailTransport(cfg({ EMAIL_PROVIDER: 'ses', EMAIL_FROM: 'no-reply@cf.io', AWS_REGION: 'us-east-1' }))
                .name,
        ).toBe('ses');
    });

    it('falls back to log (not crash) when SES is requested but under-configured', () => {
        expect(resolveEmailTransport(cfg({ EMAIL_PROVIDER: 'ses' })).name).toBe('log'); // no from/region
        expect(resolveEmailTransport(cfg({ EMAIL_PROVIDER: 'ses', EMAIL_FROM: 'a@b.com' })).name).toBe('log'); // no region
    });

    it('selects SMTP when EMAIL_PROVIDER=smtp with EMAIL_FROM + SMTP_HOST, else falls back to log', () => {
        expect(
            resolveEmailTransport(cfg({ EMAIL_PROVIDER: 'smtp', EMAIL_FROM: 'a@b.com', SMTP_HOST: 'smtp.mailgun.org' }))
                .name,
        ).toBe('smtp');
        expect(resolveEmailTransport(cfg({ EMAIL_PROVIDER: 'smtp', EMAIL_FROM: 'a@b.com' })).name).toBe('log'); // no host
    });

    it('auto-detect is SES-first: SES wins when both SES and SMTP are configured', () => {
        const both = cfg({ EMAIL_FROM: 'a@b.com', SES_REGION: 'eu-west-1', SMTP_HOST: 'smtp.x.com' });
        expect(resolveEmailTransport(both).name).toBe('ses');
    });

    it('auto-detect falls through to SMTP, then log', () => {
        expect(resolveEmailTransport(cfg({ EMAIL_FROM: 'a@b.com', SMTP_HOST: 'smtp.x.com' })).name).toBe('smtp');
        expect(resolveEmailTransport(cfg({ SES_REGION: 'eu-west-1' })).name).toBe('log'); // region but no EMAIL_FROM → can't send
    });
});
