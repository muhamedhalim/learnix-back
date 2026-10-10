import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { CronSingleRunner } from '../../common/utils/cron-lock.util';
import { DirectUploadsService } from './direct-uploads.service';

/** Aborts direct-upload sessions that were never finished, freeing their S3 parts. */
@Injectable()
export class DirectUploadsCleanupService {
  private readonly logger = new Logger(DirectUploadsCleanupService.name);

  constructor(private readonly uploads: DirectUploadsService) {}

  @Cron(CronExpression.EVERY_HOUR)
  @CronSingleRunner('uploads.direct_expire')
  public async expireStaleSessions(): Promise<number> {
    const aborted = await this.uploads.expireStale();
    if (aborted > 0) this.logger.log(`Aborted ${String(aborted)} stale direct-upload session(s)`);
    return aborted;
  }
}
