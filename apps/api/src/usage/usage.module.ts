import { Module } from '@nestjs/common';

import { OrgsModule } from '../orgs/orgs.module';

import { UsageController } from './usage.controller';
import { UsageService } from './usage.service';

@Module({
    imports: [OrgsModule],
    controllers: [UsageController],
    providers: [UsageService],
    exports: [UsageService],
})
export class UsageModule {}
