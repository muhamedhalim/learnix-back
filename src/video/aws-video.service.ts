import { Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';

import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  type S3Client,
} from '@aws-sdk/client-s3';
import {
  CreateJobCommand,
  GetJobCommand,
  MediaConvertClient,
  type Job,
} from '@aws-sdk/client-mediaconvert';
import { DataSource, In, LessThan, Repository } from 'typeorm';

import { CronSingleRunner } from '../common/utils/cron-lock.util';
import { biBody } from '../i18n/error-translator.util';
import { MediaService } from '../media/media.service';
import { StorageService } from '../storage/storage.service';
import type { CompletedDirectUpload } from '../uploads/direct/direct-uploads.service';
import {
  buildMediaConvertJob,
  MASTER_PLAYLIST_PATH,
  OUTPUT_PREFIX,
} from './mediaconvert-job.util';
import { buildPlaybackCookies, type PlaybackCookie } from './playback-cookies';
import { VideoAsset } from './entities/video-asset.entity';
import { VideoConfig } from './video.config';

/** Marketplace lessons keep their existing `video_id` column; AWS videos are stored as `aws:<asset id>`. */
export const AWS_REF_PREFIX = 'aws:';
export const isAwsRef = (ref: string | null | undefined): ref is string =>
  typeof ref === 'string' && ref.startsWith(AWS_REF_PREFIX);
export const awsAssetId = (ref: string): string => ref.slice(AWS_REF_PREFIX.length);
export const toAwsRef = (assetId: string): string => `${AWS_REF_PREFIX}${assetId}`;

/** Playback is granted in short slices; the player renews before expiry. */
export const PLAYBACK_TTL_SECONDS = 15 * 60;
const ERROR_MESSAGE_MAX = 480;

/** What we need from a finished MediaConvert job, whether it arrived as an event or via GetJob. */
export interface JobOutcome {
  assetId?: string;
  jobId: string;
  status: 'COMPLETE' | 'ERROR' | 'CANCELED' | 'OTHER';
  errorMessage?: string;
  durationSeconds?: number;
  width?: number;
  height?: number;
  /** `s3://bucket/key` of the first poster frame, when MediaConvert reported one. */
  posterUri?: string;
}

export interface PlaybackGrant {
  platform: 'aws';
  /** Path on the viewer origin, e.g. `/video/<id>/hls/index.m3u8`. Requires the cookies below. */
  hls_url: string;
  expires_at: string;
  playback_cookies: PlaybackCookie[];
}

/** Subset of the EventBridge `MediaConvert Job State Change` detail we read. */
interface JobStateDetail {
  status?: string;
  jobId?: string;
  errorMessage?: string;
  userMetadata?: { assetId?: string };
  outputGroupDetails?: Array<{
    outputDetails?: Array<{
      durationInMs?: number;
      videoDetails?: { widthInPx?: number; heightInPx?: number };
      outputFilePaths?: string[];
    }>;
  }>;
}

export function outcomeFromEvent(detail: JobStateDetail): JobOutcome | null {
  if (!detail.jobId) return null;
  const status =
    detail.status === 'COMPLETE' || detail.status === 'ERROR' || detail.status === 'CANCELED'
      ? detail.status
      : 'OTHER';
  const groups = detail.outputGroupDetails ?? [];
  const outputs = groups.flatMap((g) => g.outputDetails ?? []);
  // The video ladder outputs report dimensions; the poster output reports a file path only.
  const video = outputs.find((o) => o.videoDetails?.heightInPx !== undefined && o.durationInMs);
  const best = outputs.reduce<(typeof outputs)[number] | undefined>(
    (acc, o) =>
      (o.videoDetails?.heightInPx ?? 0) > (acc?.videoDetails?.heightInPx ?? 0) ? o : acc,
    video,
  );
  const poster = outputs
    .flatMap((o) => o.outputFilePaths ?? [])
    .find((p) => /\/thumb\/.*\.jpe?g$/i.test(p));
  return {
    ...(detail.userMetadata?.assetId !== undefined ? { assetId: detail.userMetadata.assetId } : {}),
    jobId: detail.jobId,
    status,
    ...(detail.errorMessage !== undefined ? { errorMessage: detail.errorMessage } : {}),
    ...(video?.durationInMs !== undefined
      ? { durationSeconds: Math.round(video.durationInMs / 1000) }
      : {}),
    ...(best?.videoDetails?.widthInPx !== undefined ? { width: best.videoDetails.widthInPx } : {}),
    ...(best?.videoDetails?.heightInPx !== undefined ? { height: best.videoDetails.heightInPx } : {}),
    ...(poster !== undefined ? { posterUri: poster } : {}),
  };
}

export function outcomeFromJob(job: Job): JobOutcome | null {
  if (!job.Id) return null;
  return outcomeFromEvent({
    ...(job.Status !== undefined ? { status: job.Status } : {}),
    jobId: job.Id,
    ...(job.ErrorMessage !== undefined ? { errorMessage: job.ErrorMessage } : {}),
    ...(job.UserMetadata?.['assetId'] !== undefined
      ? { userMetadata: { assetId: job.UserMetadata['assetId'] } }
      : {}),
    outputGroupDetails: (job.OutputGroupDetails ?? []).map((g) => ({
      outputDetails: (g.OutputDetails ?? []).map((o) => ({
        ...(o.DurationInMs !== undefined ? { durationInMs: o.DurationInMs } : {}),
        ...(o.VideoDetails?.WidthInPx !== undefined || o.VideoDetails?.HeightInPx !== undefined
          ? {
              videoDetails: {
                ...(o.VideoDetails?.WidthInPx !== undefined ? { widthInPx: o.VideoDetails.WidthInPx } : {}),
                ...(o.VideoDetails?.HeightInPx !== undefined ? { heightInPx: o.VideoDetails.HeightInPx } : {}),
              },
            }
          : {}),
      })),
    })),
  });
}

@Injectable()
export class AwsVideoService {
  private readonly logger = new Logger(AwsVideoService.name);
  private mediaConvert: MediaConvertClient | null = null;

  constructor(
    @InjectRepository(VideoAsset) private readonly assets: Repository<VideoAsset>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly cfg: VideoConfig,
    private readonly storage: StorageService,
    private readonly media: MediaService,
  ) {}

  public isEnabled(): boolean {
    return this.cfg.isConfigured() && this.s3() !== null;
  }

  private s3(): S3Client | null {
    return this.storage.getDirectUploadBackend()?.client ?? null;
  }

  private mc(): MediaConvertClient {
    this.mediaConvert ??= new MediaConvertClient({ region: this.cfg.region });
    return this.mediaConvert;
  }

  /* --------------------------- upload -> transcode --------------------------- */

  /** Create the asset row for a verified source upload and start transcoding it. */
  public async registerUpload(upload: CompletedDirectUpload, ownerId: string): Promise<VideoAsset> {
    if (!this.cfg.isConfigured()) {
      throw new ServiceUnavailableException(
        biBody('Video processing is not configured', 'معالجة الفيديو غير مُهيَّأة'),
      );
    }
    const asset = await this.assets.save(
      this.assets.create({
        owner_user_id: ownerId,
        source_bucket: upload.bucket,
        source_key: upload.key,
        output_bucket: this.cfg.outputBucket,
        status: 'uploaded',
        size_bytes: upload.size,
      }),
    );
    asset.output_prefix = OUTPUT_PREFIX(asset.id);
    await this.assets.save(asset);
    await this.startTranscode(asset);
    return (await this.assets.findOneByOrFail({ id: asset.id }));
  }

  /** Submit the MediaConvert job. On failure the asset is marked failed so the UI can say so. */
  public async startTranscode(asset: VideoAsset): Promise<void> {
    try {
      const response = await this.mc().send(
        new CreateJobCommand(
          buildMediaConvertJob({
            assetId: asset.id,
            inputUri: `s3://${asset.source_bucket}/${asset.source_key}`,
            outputBucket: asset.output_bucket ?? this.cfg.outputBucket,
            roleArn: this.cfg.mediaConvertRoleArn,
            ...(this.cfg.mediaConvertQueueArn !== undefined
              ? { queueArn: this.cfg.mediaConvertQueueArn }
              : {}),
          }),
        ),
      );
      await this.assets.update(asset.id, {
        status: 'processing',
        mediaconvert_job_id: response.Job?.Id ?? null,
        error_message: null,
      });
    } catch (err) {
      const message = this.truncate(err instanceof Error ? err.message : String(err));
      this.logger.error(`MediaConvert job for asset ${asset.id} failed to start: ${message}`);
      await this.assets.update(asset.id, { status: 'failed', error_message: message });
    }
  }

  /* ------------------------------- job results ------------------------------- */

  /** Idempotent: a repeated or late event for a finished asset is ignored. */
  public async applyOutcome(outcome: JobOutcome): Promise<void> {
    const asset = await this.findForOutcome(outcome);
    if (asset === null) {
      this.logger.warn(`Job ${outcome.jobId}: no matching video asset (ignored)`);
      return;
    }
    if (asset.status === 'ready' || asset.status === 'failed' || asset.status === 'deleted') return;

    if (outcome.status === 'ERROR' || outcome.status === 'CANCELED') {
      const message = this.truncate(outcome.errorMessage ?? `Transcoding ${outcome.status.toLowerCase()}`);
      await this.assets.update(asset.id, { status: 'failed', error_message: message });
      await this.syncLessons(asset.id, { status: 'failed' });
      return;
    }
    if (outcome.status !== 'COMPLETE') return;

    const thumbnailKey = await this.publishPoster(asset, outcome.posterUri);
    await this.assets.update(asset.id, {
      status: 'ready',
      error_message: null,
      duration_seconds: outcome.durationSeconds ?? null,
      width: outcome.width ?? null,
      height: outcome.height ?? null,
      thumbnail_key: thumbnailKey,
    });
    await this.syncLessons(asset.id, {
      status: 'ready',
      ...(outcome.durationSeconds !== undefined ? { durationSeconds: outcome.durationSeconds } : {}),
      ...(outcome.width !== undefined ? { width: outcome.width } : {}),
      ...(outcome.height !== undefined ? { height: outcome.height } : {}),
      ...(thumbnailKey !== null ? { thumbnailUrl: this.media.buildPublicUrl(thumbnailKey) } : {}),
    });
  }

  private async findForOutcome(outcome: JobOutcome): Promise<VideoAsset | null> {
    if (outcome.assetId !== undefined && /^[0-9a-f-]{36}$/i.test(outcome.assetId)) {
      const byId = await this.assets.findOneBy({ id: outcome.assetId });
      if (byId !== null) return byId;
    }
    return this.assets.findOneBy({ mediaconvert_job_id: outcome.jobId });
  }

  /** Copy the poster to the public thumbnails prefix so course cards can show it without a signed cookie. */
  private async publishPoster(asset: VideoAsset, posterUri: string | undefined): Promise<string | null> {
    const client = this.s3();
    const filesBucket = this.storage.getDirectUploadBackend()?.bucket;
    if (client === null || filesBucket === undefined) return null;
    const outputBucket = asset.output_bucket ?? this.cfg.outputBucket;
    let sourceKey: string | null = null;
    if (posterUri !== undefined) {
      const match = /^s3:\/\/[^/]+\/(.+)$/.exec(posterUri);
      sourceKey = match?.[1] ?? null;
    }
    sourceKey ??= await this.findPosterKey(client, outputBucket, asset.output_prefix ?? OUTPUT_PREFIX(asset.id));
    if (sourceKey === null) return null;
    const targetKey = `thumbnails/videos/${asset.id}.jpg`;
    try {
      await client.send(
        new CopyObjectCommand({
          Bucket: filesBucket,
          Key: targetKey,
          CopySource: `${outputBucket}/${sourceKey}`,
          ContentType: 'image/jpeg',
          MetadataDirective: 'REPLACE',
        }),
      );
      return targetKey;
    } catch (err) {
      this.logger.warn(`Poster copy for asset ${asset.id} failed: ${(err as Error).message}`);
      return null;
    }
  }

  private async findPosterKey(client: S3Client, bucket: string, prefix: string): Promise<string | null> {
    try {
      const listed = await client.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: `${prefix}thumb/`, MaxKeys: 5 }),
      );
      return listed.Contents?.find((o) => o.Key?.toLowerCase().endsWith('.jpg'))?.Key ?? null;
    } catch {
      return null;
    }
  }

  private async syncLessons(
    assetId: string,
    state: {
      status: 'ready' | 'failed';
      durationSeconds?: number;
      width?: number;
      height?: number;
      thumbnailUrl?: string;
    },
  ): Promise<void> {
    await this.dataSource.query(
      `UPDATE "lessons"
          SET "bunny_video_status" = $2,
              "duration" = COALESCE($3, "duration"),
              "video_width" = COALESCE($4, "video_width"),
              "video_height" = COALESCE($5, "video_height"),
              "video_thumbnail" = COALESCE($6, "video_thumbnail")
        WHERE "video_asset_id" = $1`,
      [
        assetId,
        state.status,
        state.durationSeconds ?? null,
        state.width ?? null,
        state.height ?? null,
        state.thumbnailUrl ?? null,
      ],
    );
    if (state.durationSeconds !== undefined) {
      await this.dataSource.query(
        `UPDATE "marketplace_course_lessons" SET "duration_seconds" = $2 WHERE "video_id" = $1`,
        [`aws:${assetId}`, state.durationSeconds],
      );
    }
  }

  /* ------------------------------- reconcile -------------------------------- */

  /**
   * Safety net for lost or delayed EventBridge events: polls MediaConvert for assets still
   * processing, and retries jobs that never started.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  @CronSingleRunner('video.reconcile')
  public async reconcile(): Promise<number> {
    if (!this.isEnabled()) return 0;
    const cutoff = new Date(Date.now() - 2 * 60_000);
    const pending = await this.assets.find({
      where: { status: In(['uploaded', 'processing']), updated_at: LessThan(cutoff) },
      take: 50,
    });
    for (const asset of pending) {
      if (asset.mediaconvert_job_id === null) {
        await this.startTranscode(asset);
        continue;
      }
      try {
        const { Job } = await this.mc().send(new GetJobCommand({ Id: asset.mediaconvert_job_id }));
        const outcome = Job ? outcomeFromJob(Job) : null;
        if (outcome !== null) await this.applyOutcome({ ...outcome, assetId: asset.id });
      } catch (err) {
        this.logger.warn(`Reconcile of asset ${asset.id} failed: ${(err as Error).message}`);
      }
    }
    return pending.length;
  }

  /* -------------------------------- playback --------------------------------- */

  public async getStatus(assetId: string): Promise<VideoAsset> {
    const asset = await this.assets.findOneBy({ id: assetId });
    if (asset === null || asset.status === 'deleted') {
      throw new NotFoundException(biBody('Video not found', 'الفيديو غير موجود'));
    }
    return asset;
  }

  /**
   * Cookie grant for one ready asset. Callers MUST have authorised the viewer first (lesson
   * access policy); this method only turns an authorised request into a signed grant.
   */
  public async grantPlayback(assetId: string): Promise<PlaybackGrant> {
    const asset = await this.getStatus(assetId);
    if (asset.status !== 'ready') {
      throw new ServiceUnavailableException(
        biBody('Video is not ready yet', 'الفيديو غير جاهز بعد'),
      );
    }
    if (!this.cfg.isConfigured()) {
      throw new ServiceUnavailableException(
        biBody('Secure video playback is not configured on the server.', 'التشغيل الآمن للفيديو غير مُهيَّأ على الخادم.'),
      );
    }
    const { cookies, expiresAt } = buildPlaybackCookies(
      {
        keyPairId: this.cfg.keyPairId,
        privateKey: this.cfg.privateKey,
        algorithm: this.cfg.signingAlgorithm,
      },
      this.cfg.publicOrigin,
      asset.id,
      PLAYBACK_TTL_SECONDS,
    );
    return {
      platform: 'aws',
      // Absolute: the player runs on the Vercel-hosted frontend, a different origin from this API/CDN host.
      hls_url: `${this.cfg.publicOrigin}/video/${asset.id}/${MASTER_PLAYLIST_PATH}`,
      expires_at: expiresAt.toISOString(),
      playback_cookies: cookies,
    };
  }

  /* --------------------------------- delete ---------------------------------- */

  /** Remove the source and every output object. Failures are logged; the row is marked deleted regardless. */
  public async deleteAsset(assetId: string): Promise<void> {
    const asset = await this.assets.findOneBy({ id: assetId });
    if (asset === null || asset.status === 'deleted') return;
    const client = this.s3();
    if (client !== null) {
      try {
        await client.send(
          new DeleteObjectCommand({ Bucket: asset.source_bucket, Key: asset.source_key }),
        );
        if (asset.output_bucket !== null && asset.output_prefix !== null) {
          await this.deletePrefix(client, asset.output_bucket, asset.output_prefix);
        }
        if (asset.thumbnail_key !== null) {
          const filesBucket = this.storage.getDirectUploadBackend()?.bucket;
          if (filesBucket !== undefined) {
            await client.send(new DeleteObjectCommand({ Bucket: filesBucket, Key: asset.thumbnail_key }));
          }
        }
      } catch (err) {
        this.logger.warn(`Deleting objects of asset ${assetId} failed: ${(err as Error).message}`);
      }
    }
    await this.assets.update(assetId, { status: 'deleted' });
  }

  private async deletePrefix(client: S3Client, bucket: string, prefix: string): Promise<void> {
    let token: string | undefined;
    do {
      const page = await client.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
      );
      const keys = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
      if (keys.length > 0) {
        await client.send(
          new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys, Quiet: true } }),
        );
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token !== undefined);
  }

  private truncate(message: string): string {
    return message.slice(0, ERROR_MESSAGE_MAX);
  }
}
