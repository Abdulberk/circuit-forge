/**
 * Templates Module
 */
import { Module } from '@nestjs/common';

import { OrgsModule } from '../orgs/orgs.module';

import { TemplatesController } from './templates.controller';
import { TemplatesService } from './templates.service';

@Module({
    imports: [OrgsModule],
    controllers: [TemplatesController],
    providers: [TemplatesService],
    exports: [TemplatesService],
})
export class TemplatesModule {}
