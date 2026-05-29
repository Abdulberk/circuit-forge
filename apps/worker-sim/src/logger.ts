/**
 * Structured logger for the worker
 */
import pino from 'pino';
import { config } from './config';

export const logger = pino({
    level: config.LOG_LEVEL,
    transport:
        config.NODE_ENV === 'development'
            ? {
                target: 'pino-pretty',
                options: {
                    colorize: true,
                    translateTime: 'SYS:standard',
                    ignore: 'pid,hostname',
                },
            }
            : undefined,
    base: {
        service: 'worker-sim',
    },
});

export type Logger = typeof logger;