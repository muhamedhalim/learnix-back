import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';

import { MetricsController } from './metrics.controller';
import { MetricsBearerGuard } from './metrics-bearer.guard';
import { RequestPerformanceMiddleware } from './request-performance.middleware';

@Module({
  controllers: [MetricsController],
  providers: [MetricsBearerGuard, RequestPerformanceMiddleware],
})
export class ObservabilityModule implements NestModule {
  public configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestPerformanceMiddleware).forRoutes('*');
  }
}
