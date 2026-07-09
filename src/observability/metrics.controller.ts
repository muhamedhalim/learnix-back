import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';

import { MetricsBearerGuard } from './metrics-bearer.guard';
import { performanceMetrics } from './performance-metrics.registry';

@ApiExcludeController()
@Controller('metrics')
@UseGuards(MetricsBearerGuard)
export class MetricsController {
  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  public getMetrics(): string {
    return performanceMetrics.renderPrometheus();
  }
}
