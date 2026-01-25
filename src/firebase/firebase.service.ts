import { Injectable, Logger,UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { logAndThrow } from '../common/utils/error-handler.util';
import * as admin from 'firebase-admin';

@Injectable()
export class FirebaseService {
  private readonly logger = new Logger(FirebaseService.name);
  private readonly firebaseApp?: admin.app.App;

  constructor(private configService: ConfigService) {
    const projectId = this.configService.get<string>('FIREBASE_PROJECT_ID');
    const clientEmail = this.configService.get<string>('FIREBASE_CLIENT_EMAIL');
    const privateKey = this.configService.get<string>('FIREBASE_PRIVATE_KEY');

    if(!projectId || !clientEmail || !privateKey) {
      this.logger.warn(
        'Firebase credentials not configured. Firebase authentication will be disabled.',
      );
      return;
    }

    try {
      // Check if Firebase app is already initialized (important for tests)
      if(admin.apps.length === 0) {
        // Handle private key formatting issues
        let formattedKey = privateKey;

        // Remove wrapping quotes if present (both single and double)
        if(
          (formattedKey.startsWith('"') && formattedKey.endsWith('"')) ||
          (formattedKey.startsWith("'") && formattedKey.endsWith("'"))
        ) {
          formattedKey = formattedKey.slice(1, -1);
        }

        // Replace escaped newlines (\\n) with actual newlines (\n)
        formattedKey = formattedKey.replace(/\\n/g, '\n');

        // Basic validation logging (redacted)
        if(!formattedKey.includes('-----BEGIN PRIVATE KEY-----')) {
          this.logger.error(
            'Firebase Private Key seems to be missing the standard header.',
          );
        }

        this.firebaseApp = admin.initializeApp({
          credential: admin.credential.cert({
            projectId,
            clientEmail,
            privateKey: formattedKey,
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

  public async verifyToken(idToken: string): Promise<admin.auth.DecodedIdToken> {
    if(!this.firebaseApp) {
      throw new UnauthorizedException('Firebase is not initialized');
    }

    try {
      return await this.firebaseApp.auth().verifyIdToken(idToken);
    } catch (error: unknown) {
      logAndThrow(
        this.logger,
        error,
        'Firebase token verification failed',
        new UnauthorizedException('Invalid or expired Firebase token'),
      );
    }
  }
}
