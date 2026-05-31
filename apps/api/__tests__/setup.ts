/**
 * Jest Test Setup
 */

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-key-for-testing-only';
process.env.JWT_REFRESH_SECRET = 'test-jwt-refresh-secret-key-for-testing';
process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/circuitforge_test';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.S3_ENDPOINT = 'http://localhost:9000';
process.env.S3_ACCESS_KEY = 'minioadmin';
process.env.S3_SECRET_KEY = 'minioadmin';
process.env.S3_BUCKET = 'circuitforge-test';
process.env.S3_REGION = 'us-east-1';
process.env.S3_FORCE_PATH_STYLE = 'true';
// TME component catalog (parts module) — dummy creds so the module boots in tests; the TME client is mocked.
process.env.TME_TOKEN = 'test-tme-token';
process.env.TME_SECRET = 'test-tme-secret';
process.env.TME_BASE_URL = 'https://api.tme.eu';

// Increase timeout for integration tests
jest.setTimeout(30000);

// Global test utilities
export const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));