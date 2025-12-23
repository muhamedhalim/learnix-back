import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';
import { ErrorHandler } from '../common/utils/error-handler.util';

@Injectable()
export class FirebaseService {
  private readonly logger = new Logger(FirebaseService.name);
  private readonly firebaseApp?: admin.app.App;

  constructor(private configService: ConfigService) {
    const projectId = this.configService.get<string>('FIREBASE_PROJECT_ID');
    const clientEmail = this.configService.get<string>('FIREBASE_CLIENT_EMAIL');
    const privateKey = this.configService.get<string>('FIREBASE_PRIVATE_KEY');

    if (!projectId || !clientEmail || !privateKey) {
      this.logger.warn(
        'Firebase credentials not configured. Firebase authentication will be disabled.',
      );
      return;
    }

    try {
      // Check if Firebase app is already initialized (important for tests)
      if (admin.apps.length === 0) {
        this.firebaseApp = admin.initializeApp({
          credential: admin.credential.cert({
            projectId,
            clientEmail,
            privateKey: privateKey.replace(/\\n/g, '\n'),
          }),
        });
      } else {
        this.firebaseApp = admin.app();
        this.logger.log('Using existing Firebase app instance');
      }
    } catch (error) {
      this.logger.error('Failed to initialize Firebase:', error);
    }
  }

  async verifyToken(idToken: string): Promise<admin.auth.DecodedIdToken> {
    if (!this.firebaseApp) {
      throw new UnauthorizedException('Firebase is not initialized');
    }

    try {
      return await this.firebaseApp.auth().verifyIdToken(idToken);
    } catch (error: unknown) {
      ErrorHandler.logAndThrow(
        this.logger,
        error,
        'Firebase token verification failed',
        new UnauthorizedException('Invalid or expired Firebase token'),
      );
    }
  }
}
