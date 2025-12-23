import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DiscountCode, DiscountCodeUsage } from './entities';
import { DiscountCodesService } from './discount-codes.service';
import {
  DiscountCodesController,
  AdminDiscountCodesController,
} from './controllers';

@Module({
  imports: [TypeOrmModule.forFeature([DiscountCode, DiscountCodeUsage])],
  controllers: [DiscountCodesController, AdminDiscountCodesController],
  providers: [DiscountCodesService],
  exports: [DiscountCodesService],
})
export class DiscountCodesModule {}
