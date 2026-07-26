/**
 * Versions Module
 */
import { Module } from '@nestjs/common';

import { ProjectsModule } from '../projects/projects.module';

import { BomService } from './bom.service';
import { VersionsController } from './versions.controller';
import { VersionsService } from './versions.service';

@Module({
    imports: [ProjectsModule],
    controllers: [VersionsController],
    providers: [VersionsService, BomService],
    exports: [VersionsService],
})
export class VersionsModule { }