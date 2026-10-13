import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Settings for the AWS video pipeline. Everything comes from the environment (task definition +
 * Secrets Manager); nothing is baked in. `isConfigured()` is the single "is AWS video on" switch.
 */
@Injectable()
export class VideoConfig {
  constructor(private readonly config: ConfigService) {}

  private get(key: string): string {
    return this.config.get<string>(key)?.trim() ?? '';
  }

  public get sourceBucket(): string {
    return this.get('VIDEO_SOURCE_BUCKET');
  }

  public get outputBucket(): string {
    return this.get('VIDEO_OUTPUT_BUCKET');
  }

  public get mediaConvertRoleArn(): string {
    return this.get('MEDIACONVERT_ROLE_ARN');
  }

  public get mediaConvertQueueArn(): string | undefined {
    return this.get('MEDIACONVERT_QUEUE_ARN') || undefined;
  }

  public get region(): string {
    return this.get('AWS_REGION') || this.get('S3_REGION') || 'eu-central-1';
  }

  /** SQS queue receiving MediaConvert job-state events (EventBridge -> SQS). Optional: a reconcile cron is the fallback. */
  public get eventsQueueUrl(): string {
    return this.get('MEDIA_EVENTS_QUEUE_URL');
  }

  public get keyPairId(): string {
    return this.get('CLOUDFRONT_KEY_PAIR_ID');
  }

  /** PEM private key. Accepts literal PEM, `\n`-escaped PEM, or base64 of the PEM (`CLOUDFRONT_PRIVATE_KEY_B64`). */
  public get privateKey(): string {
    const b64 = this.get('CLOUDFRONT_PRIVATE_KEY_B64');
    if (b64 !== '') return Buffer.from(b64, 'base64').toString('utf8');
    return this.get('CLOUDFRONT_PRIVATE_KEY').replace(/\\n/g, '\n');
  }

  public get signingAlgorithm(): 'SHA1' | 'SHA256' {
    return this.get('CLOUDFRONT_SIGNING_ALGORITHM') === 'SHA256' ? 'SHA256' : 'SHA1';
  }

  /**
   * Viewer-facing origin that serves `/video/*`: the API's CloudFront host (api.<domain>), not the frontend.
   * The signed cookies are issued by an API response, so they are host-only cookies of this origin; the player
   * on the Vercel-hosted frontend reaches it cross-origin (same site) with credentials.
   */
  public get publicOrigin(): string {
    const explicit = this.get('VIDEO_PUBLIC_ORIGIN') || this.get('BACKEND_URL');
    return explicit.replace(/\/+$/, '');
  }

  public isConfigured(): boolean {
    return (
      this.sourceBucket !== '' &&
      this.outputBucket !== '' &&
      this.mediaConvertRoleArn !== '' &&
      this.keyPairId !== '' &&
      this.privateKey !== '' &&
      this.publicOrigin !== ''
    );
  }
}
