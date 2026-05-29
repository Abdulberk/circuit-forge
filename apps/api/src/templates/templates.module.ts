/**
 * Templates Module
 */
import { Module } from '@nestjs/common';
import { TemplatesController } from './templates.controller';
import { TemplatesService } from './templates.service';
import { OrgsModule } from '../orgs/orgs.module';

@Module({
    imports: [OrgsModule],
    controllers: [TemplatesController],
    providers: [TemplatesService],
    exports: [TemplatesService],
})
export class TemplatesModule { }