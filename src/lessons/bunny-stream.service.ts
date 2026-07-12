import { createHash } from 'node:crypto';

import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { biBody } from '../i18n/error-translator.util';

export type BunnyVideoStatus = 'created' | 'uploading' | 'processing' | 'ready' | 'failed';

export interface BunnyCreatedVideo {
  videoId: string;
  libraryId: string;
}

export interface BunnyVideoMetadata {
  status: BunnyVideoStatus;
  /** Encoding progress 0–100 while processing. */
  progress: number;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
  thumbnailUrl: string | null;
  playbackUrl: string;
  embedUrl: string;
}

/** Raw shape of the Bunny Stream "get video" response (subset we use). */
interface BunnyVideoResponse {
  guid: string;
  status: number;
  encodeProgress?: number;
  length?: number;
  width?: number;
  height?: number;
  storageSize?: number;
  thumbnailFileName?: string;
}

@Injectable()
export class BunnyStreamService {
  private readonly logger = new Logger(BunnyStreamService.name);
  private readonly apiBase = 'https://video.bunnycdn.com/library';

  constructor(private readonly config: ConfigService) {}

  /** Whether Bunny Stream credentials are configured. */
  public get isConfigured(): boolean {
    return Boolean(this.libraryId && this.apiKey);
  }

  private get libraryId(): string {
    return this.config.get<string>('BUNNY_STREAM_LIBRARY_ID') ?? '';
  }

  private get apiKey(): string {
    // Bunny Stream operations authenticate with the library's API key. Accept
    // either env name so existing deployments (BUNNY_STREAM_API_KEY) and the
    // current config (BUNNY_API_KEY) both work.
    return (
      this.config.get<string>('BUNNY_STREAM_API_KEY') ??
      this.config.get<string>('BUNNY_API_KEY') ??
      ''
    );
  }

  /** Pull-zone hostname for HLS playback + posters, e.g. `vz-xxxx.b-cdn.net`. */
  private get cdnHostname(): string {
    return (
      this.config.get<string>('BUNNY_STREAM_CDN_HOSTNAME') ??
      this.config.get<string>('BUNNY_STREAM_PULL_ZONE') ??
      ''
    );
  }

  private assertConfigured(): void {
    if (!this.isConfigured) {
      throw new ServiceUnavailableException(
        biBody(
          'Video uploads are not available: Bunny Stream is not configured on the server.',
          'رفع الفيديوهات غير متاح حاليًا: لم يتم إعداد خدمة Bunny Stream على الخادم.',
        ),
      );
    }
  }

  private headers(): Record<string, string> {
    return {
      AccessKey: this.apiKey,
      accept: 'application/json',
      'content-type': 'application/json',
    };
  }

  /** Library "Token Authentication Key" (distinct from the API key). */
  private get tokenKey(): string {
    return this.config.get<string>('BUNNY_STREAM_TOKEN_KEY') ?? '';
  }

  public buildEmbedUrl(videoId: string): string {
    return `https://iframe.mediadelivery.net/embed/${this.libraryId}/${videoId}`;
  }

  public generateSignedEmbedUrl(videoId: string, ttlSeconds = 60 * 60): string | null {
    if (!this.tokenKey) return null;
    const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
    const token = createHash('sha256').update(`${this.tokenKey}${videoId}${expires}`).digest('hex');
    return `${this.buildEmbedUrl(videoId)}?token=${token}&expires=${expires}`;
  }

  public buildPlaybackUrl(videoId: string): string {
    if (this.cdnHostname) {
      return `https://${this.cdnHostname}/${videoId}/playlist.m3u8`;
    }
    return this.buildEmbedUrl(videoId);
  }

  private buildThumbnailUrl(videoId: string, thumbnailFileName?: string): string | null {
    if (!this.cdnHostname) return null;
    const file = thumbnailFileName?.trim() || 'thumbnail.jpg';
    return `https://${this.cdnHostname}/${videoId}/${file}`;
  }

  public async createVideo(title: string): Promise<BunnyCreatedVideo> {
    this.assertConfigured();
    const res = await fetch(`${this.apiBase}/${this.libraryId}/videos`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ title: title.slice(0, 200) || 'Untitled' }),
    });
    if (!res.ok) {
      const error = await res.text();

      this.logger.error(`
      Bunny createVideo failed
      Status: ${res.status}
      Response: ${error}
      `);
      throw new BadRequestException(
        biBody(
          'Failed to create video on Bunny Stream.',
          'فشل إنشاء الفيديو على خدمة Bunny Stream.',
        ),
      );
    }
    const data = (await res.json()) as { guid?: string };
    if (!data.guid) {
      throw new BadRequestException(
        biBody(
          'Bunny Stream did not return a video id.',
          'لم تُرجع خدمة Bunny Stream معرّف فيديو.',
        ),
      );
    }
    return { videoId: data.guid, libraryId: this.libraryId };
  }

  public async uploadVideo(videoId: string, body: Buffer): Promise<void> {
    this.assertConfigured();
    const res = await fetch(`${this.apiBase}/${this.libraryId}/videos/${videoId}`, {
      method: 'PUT',
      headers: {
        AccessKey: this.apiKey,
        accept: 'application/json',
        'content-type': 'application/octet-stream',
      },
      body: new Uint8Array(body),
    });
    if (!res.ok) {
      this.logger.error(`Bunny uploadVideo failed (${res.status}) ${videoId}`);
      throw new ServiceUnavailableException(
        biBody(
          'Failed to upload the video to Bunny Stream.',
          'فشل رفع الفيديو إلى خدمة Bunny Stream.',
        ),
      );
    }
  }

  /** Fetch + normalize the current state of a video from Bunny Stream. */
  public async getVideo(videoId: string): Promise<BunnyVideoMetadata> {
    this.assertConfigured();
    const res = await fetch(`${this.apiBase}/${this.libraryId}/videos/${videoId}`, {
      method: 'GET',
      headers: this.headers(),
    });
    if (res.status === 404) {
      throw new BadRequestException(
        biBody('Video not found on Bunny Stream.', 'الفيديو غير موجود على خدمة Bunny Stream.'),
      );
    }
    if (!res.ok) {
      this.logger.error(`Bunny getVideo failed (${res.status})`);
      throw new ServiceUnavailableException(
        biBody('Failed to reach Bunny Stream.', 'تعذّر الاتصال بخدمة Bunny Stream.'),
      );
    }
    const v = (await res.json()) as BunnyVideoResponse;
    return {
      status: this.mapStatus(v.status),
      progress: typeof v.encodeProgress === 'number' ? v.encodeProgress : 0,
      durationSeconds: v.length && v.length > 0 ? Math.round(v.length) : null,
      width: v.width && v.width > 0 ? v.width : null,
      height: v.height && v.height > 0 ? v.height : null,
      sizeBytes: v.storageSize && v.storageSize > 0 ? v.storageSize : null,
      thumbnailUrl: this.buildThumbnailUrl(videoId, v.thumbnailFileName),
      playbackUrl: this.buildPlaybackUrl(videoId),
      embedUrl: this.buildEmbedUrl(videoId),
    };
  }

  /** Delete a video from Bunny Stream. 404 is treated as already-gone. */
  public async deleteVideo(videoId: string): Promise<void> {
    if (!this.isConfigured) return;
    try {
      const res = await fetch(`${this.apiBase}/${this.libraryId}/videos/${videoId}`, {
        method: 'DELETE',
        headers: this.headers(),
      });
      if (!res.ok && res.status !== 404) {
        this.logger.warn(`Bunny deleteVideo failed (${res.status}) ${videoId}`);
      }
    } catch (err) {
      // Cleanup is best-effort — never block the caller on Bunny availability.
      this.logger.warn(`Bunny deleteVideo error for ${videoId}: ${(err as Error).message}`);
    }
  }

  private mapStatus(code: number): BunnyVideoStatus {
    switch (code) {
      case 4:
        return 'ready';
      case 5:
      case 6:
        return 'failed';
      case 0:
        return 'created';
      case 1:
      case 2:
      case 3:
      default:
        return 'processing';
    }
  }
}
