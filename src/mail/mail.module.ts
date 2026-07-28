import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { areQueuesEnabled, QUEUE_CONFIGS, QUEUE_NAMES } from '../queues/queues.constants';
import { registerQueues } from '../queues/register-queues.util';
import { MailProcessor } from './mail.processor';
import { MailService } from './mail.service';

@Global()
@Module({
  imports: [
    ConfigModule,
    registerQueues({ name: QUEUE_NAMES.EMAIL, config: QUEUE_CONFIGS[QUEUE_NAMES.EMAIL] }),
  ],
  providers: [MailService, ...(areQueuesEnabled() ? [MailProcessor] : [])],
  exports: [MailService],
})
export class MailModule {}
