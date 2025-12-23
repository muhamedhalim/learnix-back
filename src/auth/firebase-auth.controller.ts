import { Controller, Post, UseGuards, Request, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { FirebaseAuthGuard } from './guards/firebase-auth.guard';
import { User } from '../users/entities/user.entity';

interface AuthenticatedRequest extends Request {
  user: User;
}

@ApiTags('Firebase Authentication')
@Controller('auth/firebase')
export class FirebaseAuthController {
  @Post('verify')
  @ApiOperation({ summary: 'Verify Firebase token and sync user' })
  @UseGuards(FirebaseAuthGuard)
  verifyFirebaseToken(@Request() req: AuthenticatedRequest) {
    return {
      message: 'Firebase token verified successfully',
      user: {
        id: req.user.id,
        email: req.user.email,
        username: req.user.username,
        full_name: `${req.user.first_name} ${req.user.last_name}`.trim(),
        role: req.user.role,
        isActive: req.user.is_active,
      },
    };
  }

  @Get('profile')
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiBearerAuth('JWT-auth')
  @UseGuards(FirebaseAuthGuard)
  getProfile(@Request() req: AuthenticatedRequest) {
    return {
      user: {
        id: req.user.id,
        email: req.user.email,
        username: req.user.username,
        full_name: `${req.user.first_name} ${req.user.last_name}`.trim(),
        role: req.user.role,
        isActive: req.user.is_active,
        firebase_uid: req.user.firebase_uid,
      },
    };
  }
}
