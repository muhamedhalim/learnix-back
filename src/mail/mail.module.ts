import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { areQueuesEnabled, QUEUE_CONFIGS, QUEUE_NAMES } from '../queues/queues.constants';
import { registerQueues } from '../queues/register-queues.util';
import { MailProcessor } from './mail.processor';
import { MailService } from './mail.service';
import { NotificationDelivery } from '../notifications/entities';

@Global()
@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([NotificationDelivery]),
    registerQueues({ name: QUEUE_NAMES.EMAIL, config: QUEUE_CONFIGS[QUEUE_NAMES.EMAIL] }),
  ],
  providers: [MailService, ...(areQueuesEnabled() ? [MailProcessor] : [])],
  exports: [MailService],
})
export class MailModule {}
