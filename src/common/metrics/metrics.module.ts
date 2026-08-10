import { Module } from '@nestjs/common';

import { LearningMetricsService } from './learning-metrics.service';
import { ProductFinancialMetricsService } from './product-financial-metrics.service';

/**
 * The canonical metrics layer behind every Stats/Counts endpoint (DEF-007).
 *
 * Both services talk to the injected `DataSource` with parameterised SQL and
 * import no feature module, so any module can pull this in without risking a
 * circular dependency — which is what lets Lessons, Packages, Students,
 * Subjects and Teachers all share one implementation per metric instead of
 * each inventing its own.
 */
@Module({
  providers: [ProductFinancialMetricsService, LearningMetricsService],
  exports: [ProductFinancialMetricsService, LearningMetricsService],
})
export class MetricsModule {}
