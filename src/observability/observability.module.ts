import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';

import { MetricsController } from './metrics.controller';
import { MetricsBearerGuard } from './metrics-bearer.guard';
import { QueueMetricsPublisher } from './queue-metrics.publisher';
import { RequestPerformanceMiddleware } from './request-performance.middleware';
import { ScheduledJobMonitorService } from './scheduled-job-monitor.service';

@Module({
  controllers: [MetricsController],
  providers: [
    MetricsBearerGuard,
    RequestPerformanceMiddleware,
    ScheduledJobMonitorService,
    // CloudWatch queue-backlog metric (worker autoscaling); inert unless QUEUE_METRICS_NAMESPACE is set.
    QueueMetricsPublisher,
  ],
  // Exported so the payment-critical `@Cron` jobs can be wrapped in execution
  // monitoring without those modules depending on HealthModule (which imports
  // PaymentsModule, so the reverse edge would be a cycle).
  exports: [ScheduledJobMonitorService],
})
export class ObservabilityModule implements NestModule {
  public configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestPerformanceMiddleware).forRoutes('*');
  }
}
