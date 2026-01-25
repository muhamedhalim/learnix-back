import { Global, Module, OnModuleInit } from '@nestjs/common';

import { FirebaseService } from './firebase.service';

@Global()
@Module({
  providers: [FirebaseService],
  exports: [FirebaseService],
})
export class FirebaseModule implements OnModuleInit {
  public onModuleInit(): void {
    // Module initialized - Firebase services ready
  }
}
