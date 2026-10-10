import { Global, Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { registerCronLockDataSource } from './cron-lock.util';

/** Hands the DataSource to the cron-lock helper at boot (see cron-lock.util.ts). */
@Global()
@Module({})
export class CronLockModule implements OnModuleInit, OnModuleDestroy {
  public constructor(private readonly dataSource: DataSource) {}

  public onModuleInit(): void {
    registerCronLockDataSource(this.dataSource);
  }

  public onModuleDestroy(): void {
    registerCronLockDataSource(null);
  }
}
