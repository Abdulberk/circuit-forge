/**
 * Versions Module
 */
import { Module } from '@nestjs/common';
import { VersionsController } from './versions.controller';
import { VersionsService } from './versions.service';
import { ProjectsModule } from '../projects/projects.module';

@Module({
    imports: [ProjectsModule],
    controllers: [VersionsController],
    providers: [VersionsService],
    exports: [VersionsService],
})
export class VersionsModule { }