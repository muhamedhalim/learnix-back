import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { StorageService } from '../../storage/storage.service';
import type { HealthIndicator } from '../health-indicator.interface';
import { errorCode, sanitiseMessage } from '../health-sanitizer.util';
import { withHealthTimeout } from '../health-timeout.util';
import type { HealthComponentResult } from '../health.types';
import { componentResult } from './indicator-result.util';

@Injectable()
export class StorageHealthIndicator implements HealthIndicator {
  public readonly id = 'object-storage';

  constructor(
    private readonly storage: StorageService,
    private readonly config: ConfigService,
  ) {}

  public async check(): Promise<HealthComponentResult> {
    const startedAt = Date.now();
    const key = `health-checks/${randomUUID()}.txt`;
    const payload = Buffer.from('learnix-health-check', 'utf8');
    let uploaded = false;
    let read = false;
    let deleted = false;
    let signedUrl = false;
    const operationLatency: Record<string, number> = {};

    try {
      let operationStarted = Date.now();
      await withHealthTimeout(
        this.id,
        this.storage.upload({
          buffer: payload,
          path: key,
          contentType: 'text/plain',
          visibility: 'private',
        }),
        8_000,
      );
      operationLatency['uploadMs'] = Date.now() - operationStarted;
      uploaded = true;

      operationStarted = Date.now();
      const object = await withHealthTimeout(this.id, this.storage.getObject(key), 8_000);
      const chunks: Buffer[] = [];
      for await (const chunk of object.stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
        if (Buffer.concat(chunks).length > 1_024) break;
      }
      object.stream.destroy();
      read = Buffer.concat(chunks).equals(payload);
      operationLatency['readMs'] = Date.now() - operationStarted;

      operationStarted = Date.now();
      const url = await withHealthTimeout(this.id, this.storage.getSignedUrl(key, 60), 5_000);
      signedUrl = typeof url === 'string' && url.length > 0;
      operationLatency['signedUrlMs'] = Date.now() - operationStarted;

      operationStarted = Date.now();
      await withHealthTimeout(this.id, this.storage.delete(key), 8_000);
      deleted = !(await withHealthTimeout(this.id, this.storage.exists(key), 5_000));
      operationLatency['deleteMs'] = Date.now() - operationStarted;

      const status = read && deleted && signedUrl ? 'healthy' : 'degraded';
      const provider = this.storage.name;
      const production = this.config.get<string>('NODE_ENV') === 'production';
      const policyWarnings = [
        ...(production && provider === 'local'
          ? ['Local disk storage is not suitable for a multi-instance production deployment.']
          : []),
        ...(provider === 'bunny'
          ? ['Bunny public storage cannot enforce private paid-object access in production.']
          : []),
      ];

      return componentResult({
        id: this.id,
        name: provider === 'r2' ? 'Cloudflare R2' : provider === 's3' ? 'Amazon S3' : `${provider} storage`,
        category: 'storage',
        status: policyWarnings.length > 0 && status === 'healthy' ? 'warning' : status,
        startedAt,
        message:
          status === 'healthy'
            ? 'Temporary upload, read, signed URL, and cleanup checks passed.'
            : 'One or more storage operations failed validation.',
        metadata: {
          configured: provider !== 'local' || !production,
          provider,
          bucket:
            this.config.get<string>('S3_BUCKET') ??
            this.config.get<string>('R2_BUCKET') ??
            this.config.get<string>('BUNNY_STORAGE_ZONE') ??
            null,
          uploadTest: uploaded,
          readTest: read,
          deleteTest: deleted,
          signedUrlTest: signedUrl,
          ...operationLatency,
          averageOperationLatencyMs:
            Object.values(operationLatency).reduce((sum, value) => sum + value, 0) /
            Math.max(Object.values(operationLatency).length, 1),
        },
        warnings: policyWarnings,
        recommendation:
          status === 'healthy'
            ? null
            : 'Verify bucket permissions for object read/write/delete and signed URL generation.',
        critical: true,
      });
    } catch (error) {
      return componentResult({
        id: this.id,
        name: `${this.storage.name} storage`,
        category: 'storage',
        status: 'down',
        startedAt,
        message: sanitiseMessage(error),
        metadata: {
          provider: this.storage.name,
          uploadTest: uploaded,
          readTest: read,
          deleteTest: deleted,
          signedUrlTest: signedUrl,
          ...operationLatency,
        },
        errorCode: errorCode(error, 'STORAGE_UNAVAILABLE'),
        recommendation:
          'Verify storage credentials, bucket policy, provider availability, and object permissions.',
        critical: true,
      });
    } finally {
      if (uploaded && !deleted) {
        await this.storage.tryDelete(key);
      }
    }
  }
}
