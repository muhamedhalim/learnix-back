import { Module } from '@nestjs/common';
import { CallCenterController } from './callcenter.controller';
import { StudentsModule } from '../students/students.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [StudentsModule, UsersModule],
  controllers: [CallCenterController],
})
export class CallCenterModule {}
