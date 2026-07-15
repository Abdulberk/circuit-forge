/**
 * Invitations module — the "add a teammate" (invite → accept) subsystem. Imports OrgsModule for the
 * OWNER/ADMIN membership gate and EmailModule to send the invite link; AuditService is @Global.
 */
import { Module } from '@nestjs/common';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';
import { OrgsModule } from '../orgs/orgs.module';
import { EmailModule } from '../email/email.module';

@Module({
    imports: [OrgsModule, EmailModule],
    controllers: [InvitationsController],
    providers: [InvitationsService],
})
export class InvitationsModule {}
