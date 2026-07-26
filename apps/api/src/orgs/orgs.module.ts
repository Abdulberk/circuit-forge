/**
 * Organizations Module
 */
import { Module } from '@nestjs/common';

import { OrgsController } from './orgs.controller';
import { OrgsService } from './orgs.service';

@Module({
    controllers: [OrgsController],
    providers: [OrgsService],
    exports: [OrgsService],
})
export class OrgsModule {}
