import { Module } from '@nestjs/common';

import { NetlistController } from './netlist.controller';
import { NetlistService } from './netlist.service';

@Module({
    controllers: [NetlistController],
    providers: [NetlistService],
})
export class NetlistModule {}
