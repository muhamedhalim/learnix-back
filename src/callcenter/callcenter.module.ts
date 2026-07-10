import { Module } from '@nestjs/common';

import { GuardiansModule } from '../guardians/guardians.module';
import { StudentsModule } from '../students/students.module';
import { UsersModule } from '../users/users.module';
import { CallCenterController } from './callcenter.controller';

@Module({
  imports: [StudentsModule, UsersModule, GuardiansModule],
  controllers: [CallCenterController],
})
export class CallCenterModule {}
