import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';

import type { StorageService } from '../storage/storage.service';
import { cleanupVideoObjects, collectStorageManifest } from './prelaunch-reset';

/** A DataSource whose query() answers by SQL fragment; every other table is empty. */
function fakeDataSource(answers: Record<string, unknown[]>) {
  return {
    query: (sql: string) => {
      const match = Object.keys(answers).find((fragment) => sql.includes(fragment));
      return Promise.resolve(match ? answers[match] : []);
    },
  } as never;
}

const storage = {
  isOwnUrl: () => true,
  toKey: (value: string) => value,
} as unknown as StorageService;

describe('collectStorageManifest (object storage)', () => {
  it('treats S3-stored code exports as object keys and keeps legacy paths local', async () => {
    const manifest = await collectStorageManifest(
      fakeDataSource({
        'FROM code_exports': [{ path: 'code-exports/abc.csv' }, { path: 'exports/legacy.csv' }],
      }),
      storage,
    );
    expect(manifest.objectKeys).toContain('code-exports/abc.csv');
    expect(manifest.localExportFiles).toEqual(['exports/legacy.csv']);
  });

  it('lists video sources, HLS prefixes and thumbnails of live assets', async () => {
    const manifest = await collectStorageManifest(
      fakeDataSource({
        'FROM video_assets': [
          {
            source_bucket: 'src',
            source_key: 'uploads/v1.mp4',
            output_bucket: 'out',
            output_prefix: 'video/v1/',
            thumbnail_key: 'thumbnails/v1.jpg',
          },
          // Never transcoded yet: source only.
          { source_bucket: 'src', source_key: 'uploads/v2.mp4', output_bucket: null, output_prefix: null, thumbnail_key: null },
        ],
      }),
      storage,
    );
    expect(manifest.videoObjects).toEqual([
      { bucket: 'src', key: 'uploads/v1.mp4' },
      { bucket: 'out', prefix: 'video/v1/' },
      { bucket: 'src', key: 'uploads/v2.mp4' },
    ]);
    expect(manifest.objectKeys).toContain('thumbnails/v1.jpg');
    expect(manifest.unresolvedReferences).toEqual([]);
  });

  it('refuses an output prefix that could match unrelated objects', async () => {
    const manifest = await collectStorageManifest(
      fakeDataSource({
        'FROM video_assets': [
          { source_bucket: 'src', source_key: 'uploads/v3.mp4', output_bucket: 'out', output_prefix: 'video', thumbnail_key: null },
        ],
      }),
      storage,
    );
    expect(manifest.videoObjects).toEqual([{ bucket: 'src', key: 'uploads/v3.mp4' }]);
    expect(manifest.unresolvedReferences).toEqual(['video_assets.output_prefix:video']);
  });
});

describe('cleanupVideoObjects', () => {
  const s3 = mockClient(S3Client);
  afterEach(() => s3.reset());

  it('deletes existing sources and every object under each output prefix', async () => {
    s3.on(HeadObjectCommand, { Key: 'uploads/v1.mp4' }).resolves({});
    s3.on(HeadObjectCommand, { Key: 'uploads/gone.mp4' }).rejects(Object.assign(new Error('nf'), { name: 'NotFound' }));
    s3.on(DeleteObjectCommand).resolves({});
    s3.on(ListObjectsV2Command)
      .resolvesOnce({ Contents: [{ Key: 'video/v1/hls/index.m3u8' }], IsTruncated: true, NextContinuationToken: 't' })
      .resolvesOnce({ Contents: [{ Key: 'video/v1/hls/seg0.ts' }], IsTruncated: false });
    s3.on(DeleteObjectsCommand).resolves({});

    const deleted = await cleanupVideoObjects(
      [
        { bucket: 'src', key: 'uploads/v1.mp4' },
        { bucket: 'src', key: 'uploads/gone.mp4' },
        { bucket: 'out', prefix: 'video/v1/' },
      ],
      { getDirectUploadBackend: () => ({ client: new S3Client({ region: 'eu-central-1' }), bucket: 'files' }) },
    );

    expect(deleted).toBe(3);
    expect(s3.commandCalls(DeleteObjectCommand)).toHaveLength(1);
    expect(s3.commandCalls(ListObjectsV2Command).map((c) => c.args[0].input.Prefix)).toEqual(['video/v1/', 'video/v1/']);
  });

  it('fails loudly when assets exist but storage is not S3', async () => {
    await expect(
      cleanupVideoObjects([{ bucket: 'src', key: 'k' }], { getDirectUploadBackend: () => null }),
    ).rejects.toThrow(/not S3/);
  });

  it('does nothing without video assets', async () => {
    await expect(cleanupVideoObjects([], { getDirectUploadBackend: () => null })).resolves.toBe(0);
  });
});
