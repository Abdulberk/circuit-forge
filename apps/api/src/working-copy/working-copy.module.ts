/**
 * Working-copy module — the project's mutable autosave draft (the "whiteboard" half of the autosave split;
 * VersionsModule owns the immutable "photo archive"). Imports ProjectsModule for membership authz.
 */
import { Module } from '@nestjs/common';
import { WorkingCopyController } from './working-copy.controller';
import { WorkingCopyService } from './working-copy.service';
import { ProjectsModule } from '../projects/projects.module';

@Module({
    imports: [ProjectsModule],
    controllers: [WorkingCopyController],
    providers: [WorkingCopyService],
})
export class WorkingCopyModule {}
