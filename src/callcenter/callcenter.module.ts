import { Module } from '@nestjs/common';

import { StudentsModule } from '../students/students.module';
import { UsersModule } from '../users/users.module';

import { CallCenterController } from './callcenter.controller';

@Module({
  imports: [StudentsModule, UsersModule],
  controllers: [CallCenterController],
})
export class CallCenterModule {}
