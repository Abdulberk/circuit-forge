/**
 * Audit Module — provides the centralized AuditService app-wide.
 *
 * @Global so any feature service (admin today; business services later) can inject AuditService
 * without importing this module explicitly, mirroring PrismaModule.
 */
import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';

@Global()
@Module({
    providers: [AuditService],
    exports: [AuditService],
})
export class AuditModule {}
