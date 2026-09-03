import { Module } from '@nestjs/common';

import { CommerceModule } from '../commerce/commerce.module';
import { MarketplaceReportingService } from './reporting.service';

/**
 * Console read models and cross-cutting admin ops (plan.md's `admin/`
 * module). Only `MarketplaceReportingService` (T113) exists so far — the
 * rest of Phase 12's admin surfaces land in later tasks. `CommerceModule`'s
 * exported `TypeOrmModule` supplies `Repository<MarketplaceOrder>`.
 */
@Module({
  imports: [CommerceModule],
  providers: [MarketplaceReportingService],
  exports: [MarketplaceReportingService],
})
export class MarketplaceAdminModule {}
