import { Module, Global } from '@nestjs/common';
import { SanitizationService } from './sanitization.service';

/**
 * Global module providing XSS sanitization services
 * Available throughout the application without explicit imports
 */
@Global()
@Module({
  providers: [SanitizationService],
  exports: [SanitizationService],
})
export class SanitizationModule {}
