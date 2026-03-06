import { Global, Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { UploadModule } from '../uploads/upload.module';

import { User } from './entities/user.entity';
import { UserSession } from './entities/user-session.entity';
import { SessionsService } from './sessions.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([User, UserSession]), UploadModule],
  controllers: [UsersController],
  providers: [UsersService, SessionsService],
  exports: [UsersService, SessionsService],
})
export class UsersModule implements OnModuleInit {
  public onModuleInit(): void {
    // Module initialized - User services ready
  }
}
