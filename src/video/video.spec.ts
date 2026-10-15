import { generateKeyPairSync } from 'node:crypto';

import { CreateJobCommand, GetJobCommand, MediaConvertClient } from '@aws-sdk/client-mediaconvert';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { mockClient } from 'aws-sdk-client-mock';
import { lastValueFrom, of } from 'rxjs';

import {
  AwsVideoService,
  awsAssetId,
  isAwsRef,
  outcomeFromEvent,
  outcomeFromJob,
  toAwsRef,
} from './aws-video.service';
import { buildMediaConvertJob, MASTER_PLAYLIST_PATH, VIDEO_LADDER } from './mediaconvert-job.util';
import { MediaEventsConsumer } from './media-events.consumer';
import { buildPlaybackCookies, PlaybackCookiesInterceptor } from './playback-cookies';

const ASSET = '3f2b8c1e-7a4d-4e2a-9b1c-0d5e6f7a8b9c';

describe('MediaConvert job', () => {
  const job = buildMediaConvertJob({
    assetId: ASSET,
    inputUri: `s3://src-bucket/source/${ASSET}/original.mp4`,
    outputBucket: 'out-bucket',
    roleArn: 'arn:aws:iam::123456789012:role/mediaconvert',
  });

  it('writes an HLS ladder and a poster under video/<assetId>/', () => {
    const groups = job.Settings!.OutputGroups!;
    const hls = groups[0]!.OutputGroupSettings!.HlsGroupSettings!;
    expect(hls.Destination).toBe(`s3://out-bucket/video/${ASSET}/hls/index`);
    expect(groups[0]!.Outputs).toHaveLength(VIDEO_LADDER.length);
    expect(groups[1]!.OutputGroupSettings!.FileGroupSettings!.Destination).toBe(
      `s3://out-bucket/video/${ASSET}/thumb/poster`,
    );
    expect(MASTER_PLAYLIST_PATH).toBe('hls/index.m3u8');
  });

  it('carries the asset id back in job events and never accelerates (Basic tier)', () => {
    expect(job.UserMetadata).toEqual({ assetId: ASSET });
    expect(job.AccelerationSettings).toEqual({ Mode: 'DISABLED' });
    expect(job.Role).toContain('mediaconvert');
  });

  it('only uses the queue when one is configured', () => {
    expect('Queue' in job).toBe(false);
    const withQueue = buildMediaConvertJob({
      assetId: ASSET,
      inputUri: 's3://a/b',
      outputBucket: 'o',
      roleArn: 'r',
      queueArn: 'arn:queue',
    });
    expect(withQueue.Queue).toBe('arn:queue');
  });
});

describe('job outcomes', () => {
  const detail = {
    status: 'COMPLETE',
    jobId: 'job-1',
    userMetadata: { assetId: ASSET },
    outputGroupDetails: [
      {
        outputDetails: [
          { durationInMs: 125_400, videoDetails: { widthInPx: 640, heightInPx: 360 } },
          { durationInMs: 125_400, videoDetails: { widthInPx: 1280, heightInPx: 720 } },
        ],
      },
      {
        outputDetails: [{ outputFilePaths: [`s3://out/video/${ASSET}/thumb/poster.0000000.jpg`] }],
      },
    ],
  };

  it('reads duration, the largest rendition and the poster from an EventBridge detail', () => {
    expect(outcomeFromEvent(detail)).toMatchObject({
      assetId: ASSET,
      jobId: 'job-1',
      status: 'COMPLETE',
      durationSeconds: 125,
      width: 1280,
      height: 720,
      posterUri: `s3://out/video/${ASSET}/thumb/poster.0000000.jpg`,
    });
  });

  it('classifies errors and ignores progress states', () => {
    expect(
      outcomeFromEvent({ status: 'ERROR', jobId: 'j', errorMessage: 'bad input' }),
    ).toMatchObject({
      status: 'ERROR',
      errorMessage: 'bad input',
    });
    expect(outcomeFromEvent({ status: 'PROGRESSING', jobId: 'j' })!.status).toBe('OTHER');
    expect(outcomeFromEvent({ status: 'COMPLETE' })).toBeNull();
  });

  it('maps a GetJob response the same way', () => {
    const outcome = outcomeFromJob({
      Id: 'job-2',
      Status: 'COMPLETE',
      UserMetadata: { assetId: ASSET },
      OutputGroupDetails: [
        {
          OutputDetails: [
            { DurationInMs: 60_000, VideoDetails: { WidthInPx: 960, HeightInPx: 540 } },
          ],
        },
      ],
    } as never);
    expect(outcome).toMatchObject({ jobId: 'job-2', durationSeconds: 60, height: 540 });
  });
});

describe('aws video refs', () => {
  it('round-trips and rejects legacy ids', () => {
    expect(toAwsRef(ASSET)).toBe(`aws:${ASSET}`);
    expect(isAwsRef(toAwsRef(ASSET))).toBe(true);
    expect(awsAssetId(toAwsRef(ASSET))).toBe(ASSET);
    expect(isAwsRef('0b5c7e1a-legacy-provider-guid')).toBe(false);
    expect(isAwsRef(null)).toBe(false);
  });
});

describe('playback cookies', () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  const creds = { keyPairId: 'K2EXAMPLE', privateKey };
  const now = new Date('2026-10-10T12:00:00Z');

  it('signs a policy scoped to ONE asset path and sets a short expiry', () => {
    const { cookies, expiresAt } = buildPlaybackCookies(
      creds,
      'https://learnix.school',
      ASSET,
      900,
      now,
    );
    expect(expiresAt.toISOString()).toBe('2026-10-10T12:15:00.000Z');
    const names = cookies.map((c) => c.name).sort();
    expect(names).toEqual(['CloudFront-Key-Pair-Id', 'CloudFront-Policy', 'CloudFront-Signature']);
    expect(cookies.every((c) => c.path === `/video/${ASSET}/`)).toBe(true);

    const policyB64 = cookies.find((c) => c.name === 'CloudFront-Policy')!.value;
    const policy = JSON.parse(
      Buffer.from(
        policyB64.replace(/-/g, '+').replace(/_/g, '=').replace(/~/g, '/'),
        'base64',
      ).toString('utf8'),
    ) as {
      Statement: Array<{ Resource: string; Condition: { DateLessThan: Record<string, number> } }>;
    };
    expect(policy.Statement[0]!.Resource).toBe(`https://learnix.school/video/${ASSET}/*`);
    expect(policy.Statement[0]!.Condition.DateLessThan['AWS:EpochTime']).toBe(
      Math.floor(expiresAt.getTime() / 1000),
    );
  });

  it('a different asset gets a different policy (no cross-lesson access)', () => {
    const a = buildPlaybackCookies(creds, 'https://learnix.school', ASSET, 900, now).cookies;
    const b = buildPlaybackCookies(
      creds,
      'https://learnix.school',
      'other-asset',
      900,
      now,
    ).cookies;
    const pol = (cs: typeof a) => cs.find((c) => c.name === 'CloudFront-Policy')!.value;
    expect(pol(a)).not.toBe(pol(b));
  });

  it('interceptor moves cookies into Set-Cookie and strips them from the body', async () => {
    const res = { cookie: jest.fn() };
    const context = {
      switchToHttp: () => ({ getResponse: () => res }),
    } as unknown as ExecutionContext;
    const expires = new Date(Date.now() + 1000);
    const next: CallHandler = {
      handle: () =>
        of({
          hls_url: '/x',
          playback_cookies: [{ name: 'CloudFront-Policy', value: 'v', path: '/video/a/', expires }],
        }),
    };
    const body = await lastValueFrom(new PlaybackCookiesInterceptor().intercept(context, next));
    expect(body).toEqual({ hls_url: '/x' });
    expect(res.cookie).toHaveBeenCalledWith('CloudFront-Policy', 'v', {
      path: '/video/a/',
      expires,
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
    });
  });

  it('interceptor leaves other responses untouched', async () => {
    const res = { cookie: jest.fn() };
    const context = {
      switchToHttp: () => ({ getResponse: () => res }),
    } as unknown as ExecutionContext;
    const out = await lastValueFrom(
      new PlaybackCookiesInterceptor().intercept(context, { handle: () => of({ a: 1 }) }),
    );
    expect(out).toEqual({ a: 1 });
    expect(res.cookie).not.toHaveBeenCalled();
  });
});

describe('AwsVideoService', () => {
  const mc = mockClient(MediaConvertClient);
  const s3 = mockClient(S3Client);

  interface Row {
    id: string;
    status: string;
    [key: string]: unknown;
  }
  let rows: Map<string, Row>;
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  let service: AwsVideoService;

  const cfg = {
    isConfigured: () => true,
    sourceBucket: 'src',
    outputBucket: 'out',
    mediaConvertRoleArn: 'arn:role',
    mediaConvertQueueArn: undefined,
    region: 'eu-central-1',
    keyPairId: 'K',
    privateKey: generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    }).privateKey,
    signingAlgorithm: 'SHA1' as const,
    publicOrigin: 'https://api.learnix.school',
  };

  beforeEach(() => {
    mc.reset();
    s3.reset();
    queries.length = 0;
    rows = new Map();
    const repo = {
      create: (v: Partial<Row>) => ({ ...v }),
      save: (v: Row) => {
        const id = v.id ?? ASSET;
        rows.set(id, { ...(rows.get(id) ?? {}), ...v, id });
        return Promise.resolve(rows.get(id));
      },
      findOneByOrFail: ({ id }: { id: string }) => Promise.resolve(rows.get(id)),
      findOneBy: (where: Record<string, unknown>) =>
        Promise.resolve(
          [...rows.values()].find((r) => Object.entries(where).every(([k, v]) => r[k] === v)) ??
            null,
        ),
      update: (id: string, patch: Partial<Row>) => {
        Object.assign(rows.get(id)!, patch);
        return Promise.resolve();
      },
      find: () => Promise.resolve([...rows.values()]),
    };
    const dataSource = {
      query: (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        return Promise.resolve([]);
      },
    };
    const storage = {
      getDirectUploadBackend: () => ({
        client: new S3Client({ region: 'eu-central-1' }),
        bucket: 'files',
      }),
    };
    const media = {
      buildPublicUrl: (key: string) => `https://learnix.school/api/v1/media/public/${key}`,
    };
    service = new AwsVideoService(
      repo as never,
      dataSource as never,
      cfg as never,
      storage as never,
      media as never,
    );
    (service as unknown as { mediaConvert: MediaConvertClient }).mediaConvert =
      new MediaConvertClient({
        region: 'eu-central-1',
      });
  });

  const upload = {
    id: 'up',
    purpose: 'lesson_video',
    bucket: 'src',
    key: `source/up/original.mp4`,
    name: 'a.mp4',
    contentType: 'video/mp4',
    size: 1000,
  };

  it('creates the asset and submits a MediaConvert job', async () => {
    mc.on(CreateJobCommand).resolves({ Job: { Id: 'job-9' } });
    const asset = await service.registerUpload(upload as never, 'teacher-1');
    expect(asset).toMatchObject({ status: 'processing', mediaconvert_job_id: 'job-9' });
    const input = mc.commandCalls(CreateJobCommand)[0]!.args[0].input;
    expect(input.Settings!.Inputs![0]!.FileInput).toBe('s3://src/source/up/original.mp4');
    expect(input.UserMetadata).toEqual({ assetId: asset.id });
  });

  it('marks the asset failed (not stuck) when MediaConvert rejects the job', async () => {
    mc.on(CreateJobCommand).rejects(new Error('AccessDenied: role cannot be assumed'));
    const asset = await service.registerUpload(upload as never, 'teacher-1');
    expect(asset.status).toBe('failed');
    expect(String(asset['error_message'])).toContain('AccessDenied');
  });

  it('on COMPLETE: marks ready, copies the poster to the public prefix and syncs lessons', async () => {
    mc.on(CreateJobCommand).resolves({ Job: { Id: 'job-9' } });
    s3.on(CopyObjectCommand).resolves({});
    const asset = await service.registerUpload(upload as never, 'teacher-1');

    await service.applyOutcome({
      jobId: 'job-9',
      assetId: asset.id,
      status: 'COMPLETE',
      durationSeconds: 125,
      width: 1280,
      height: 720,
      posterUri: `s3://out/video/${asset.id}/thumb/poster.0000000.jpg`,
    });

    expect(rows.get(asset.id)).toMatchObject({
      status: 'ready',
      duration_seconds: 125,
      thumbnail_key: `thumbnails/videos/${asset.id}.jpg`,
    });
    const copy = s3.commandCalls(CopyObjectCommand)[0]!.args[0].input;
    expect(copy).toMatchObject({
      Bucket: 'files',
      CopySource: `out/video/${asset.id}/thumb/poster.0000000.jpg`,
    });
    const lessonUpdate = queries.find((q) => q.sql.includes('"lessons"'))!;
    expect(lessonUpdate.params.slice(0, 3)).toEqual([asset.id, 'ready', 125]);
    expect(queries.some((q) => q.sql.includes('marketplace_course_lessons'))).toBe(true);
  });

  it('on ERROR: marks failed with the reason; late or duplicate events are ignored', async () => {
    mc.on(CreateJobCommand).resolves({ Job: { Id: 'job-9' } });
    const asset = await service.registerUpload(upload as never, 'teacher-1');
    await service.applyOutcome({
      jobId: 'job-9',
      assetId: asset.id,
      status: 'ERROR',
      errorMessage: 'No video stream',
    });
    expect(rows.get(asset.id)).toMatchObject({
      status: 'failed',
      error_message: 'No video stream',
    });

    queries.length = 0;
    await service.applyOutcome({
      jobId: 'job-9',
      assetId: asset.id,
      status: 'COMPLETE',
      durationSeconds: 5,
    });
    expect(rows.get(asset.id)!.status).toBe('failed');
    expect(queries).toHaveLength(0);
  });

  it('refuses playback until the asset is ready, then signs for that asset only', async () => {
    mc.on(CreateJobCommand).resolves({ Job: { Id: 'job-9' } });
    const asset = await service.registerUpload(upload as never, 'teacher-1');
    await expect(service.grantPlayback(asset.id)).rejects.toThrow(/not ready/i);

    rows.get(asset.id)!['status'] = 'ready';
    const grant = await service.grantPlayback(asset.id);
    expect(grant.hls_url).toBe(`https://api.learnix.school/video/${asset.id}/hls/index.m3u8`);
    expect(grant.playback_cookies.every((c) => c.path === `/video/${asset.id}/`)).toBe(true);
  });

  it('reconcile polls GetJob for processing assets and applies the result', async () => {
    mc.on(CreateJobCommand).resolves({ Job: { Id: 'job-9' } });
    const asset = await service.registerUpload(upload as never, 'teacher-1');
    mc.on(GetJobCommand).resolves({
      Job: {
        Id: 'job-9',
        Status: 'ERROR',
        ErrorMessage: 'bad file',
        UserMetadata: { assetId: asset.id },
      },
    } as never);
    s3.on(ListObjectsV2Command).resolves({});

    expect(await service.reconcile()).toBe(1);
    expect(rows.get(asset.id)!.status).toBe('failed');
  });

  it('deleteAsset removes source and outputs and marks the row deleted', async () => {
    mc.on(CreateJobCommand).resolves({ Job: { Id: 'job-9' } });
    const asset = await service.registerUpload(upload as never, 'teacher-1');
    s3.on(DeleteObjectCommand).resolves({});
    s3.on(ListObjectsV2Command).resolves({ Contents: [], IsTruncated: false });
    await service.deleteAsset(asset.id);
    expect(rows.get(asset.id)!.status).toBe('deleted');
    expect(s3.commandCalls(DeleteObjectCommand).length).toBeGreaterThanOrEqual(1);
  });
});

describe('MediaEventsConsumer.handle', () => {
  const make = (apply: jest.Mock) =>
    new MediaEventsConsumer(
      { eventsQueueUrl: '', region: 'x' } as never,
      { applyOutcome: apply } as never,
    );

  it('applies the EventBridge envelope detail and allows deletion', async () => {
    const apply = jest.fn().mockResolvedValue(undefined);
    const body = JSON.stringify({
      source: 'aws.mediaconvert',
      detail: { status: 'COMPLETE', jobId: 'j1', userMetadata: { assetId: ASSET } },
    });
    expect(await make(apply).handle({ Body: body })).toBe(true);
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'j1', status: 'COMPLETE' }),
    );
  });

  it('keeps the message for redelivery when applying fails', async () => {
    const apply = jest.fn().mockRejectedValue(new Error('db down'));
    const body = JSON.stringify({ detail: { status: 'COMPLETE', jobId: 'j1' } });
    expect(await make(apply).handle({ Body: body })).toBe(false);
  });

  it('drops garbage instead of looping forever', async () => {
    const apply = jest.fn();
    expect(await make(apply).handle({ Body: 'not json' })).toBe(true);
    expect(await make(apply).handle({ Body: '{}' })).toBe(true);
    expect(apply).not.toHaveBeenCalled();
  });
});
