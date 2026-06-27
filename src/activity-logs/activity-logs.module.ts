import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ActivityLogsController } from './activity-logs.controller';
import { ActivityLogsService } from './activity-logs.service';
import { ActivityLog, AuditLog } from './entities';
import { ActivityLogListener } from './listeners/activity-log.listener';

@Module({
  imports: [TypeOrmModule.forFeature([ActivityLog, AuditLog])],
  controllers: [ActivityLogsController],
  providers: [ActivityLogListener, ActivityLogsService],
  exports: [ActivityLogsService],
})
export class ActivityLogsModule {}
