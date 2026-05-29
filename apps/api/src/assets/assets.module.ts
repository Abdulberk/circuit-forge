/**
 * Assets Module
 * Handles file uploads for SPICE models, symbols, etc.
 */
import { Module } from '@nestjs/common';
import { AssetsController } from './assets.controller';
import { AssetsService } from './assets.service';
import { OrgsModule } from '../orgs/orgs.module';

@Module({
    imports: [OrgsModule],
    controllers: [AssetsController],
    providers: [AssetsService],
    exports: [AssetsService],
})
export class AssetsModule { }