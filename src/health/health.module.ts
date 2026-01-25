import { Module, OnModuleInit } from '@nestjs/common';

import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  controllers: [HealthController],
  providers: [HealthService],
  exports: [HealthService],
})
export class HealthModule implements OnModuleInit {
  public onModuleInit(): void {
    // Module initialized - Health check services ready
  }
}
