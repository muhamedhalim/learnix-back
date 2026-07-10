import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { StudentGuardiansController } from './controllers';
import { Guardian, GuardianVerification, StudentGuardian } from './entities';
import { GuardianVerificationService } from './guardian-verification.service';
import { GuardiansService } from './guardians.service';

/**
 * Guardian domain: who a student's parents are, whether their phone is proven,
 * and what they have consented to receive.
 *
 * Deliberately depends on **no** notification/channel code. OTP delivery is
 * requested by emitting `GuardianVerificationRequestedEvent` on the app-wide
 * event bus, which the notifications module listens for. That keeps the
 * dependency arrow pointing one way (notifications → guardians) and avoids the
 * `forwardRef` cycle a direct call would force.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Guardian, StudentGuardian, GuardianVerification])],
  controllers: [StudentGuardiansController],
  providers: [GuardiansService, GuardianVerificationService],
  exports: [GuardiansService, GuardianVerificationService],
})
export class GuardiansModule {}
