/**
 * Projects Module
 */
import { Module } from '@nestjs/common';

import { OrgsModule } from '../orgs/orgs.module';

import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

@Module({
    imports: [OrgsModule],
    controllers: [ProjectsController],
    providers: [ProjectsService],
    exports: [ProjectsService],
})
export class ProjectsModule { }