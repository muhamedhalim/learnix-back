import { Controller, Request, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { User } from '../users/entities/user.entity';

import { FirebaseAuthGuard } from './guards/firebase-auth.guard';

interface AuthenticatedRequest extends Request {
  user: User;
}

@ApiTags('Firebase Authentication')
@Controller('auth/firebase')
export class FirebaseAuthController {
  @UseGuards(FirebaseAuthGuard)
  public verifyFirebaseToken(@Request() req: AuthenticatedRequest): {
    message: string;
    user: unknown;
  } {
    return {
      message: 'Firebase token verified successfully',
      user: {
        id: req.user.id,
        email: req.user.email,
        name: req.user.name,
        phone: req.user.phone,
        role: req.user.role,
        isActive: req.user.is_active,
      },
    };
  }

  @UseGuards(FirebaseAuthGuard)
  public getProfile(@Request() req: AuthenticatedRequest): { user: unknown } {
    return {
      user: {
        id: req.user.id,
        email: req.user.email,
        name: req.user.name,
        phone: req.user.phone,
        role: req.user.role,
        isActive: req.user.is_active,
        firebase_uid: req.user.firebase_uid,
      },
    };
  }
}
