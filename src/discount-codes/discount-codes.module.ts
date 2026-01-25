import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import {
  AdminDiscountCodesController,
  DiscountCodesController,
} from './controllers';
import { DiscountCodesService } from './discount-codes.service';
import { DiscountCode, DiscountCodeUsage } from './entities';

@Module({
  imports: [TypeOrmModule.forFeature([DiscountCode, DiscountCodeUsage])],
  controllers: [DiscountCodesController, AdminDiscountCodesController],
  providers: [DiscountCodesService],
  exports: [DiscountCodesService],
})
export class DiscountCodesModule {}
