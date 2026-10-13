/**
 * Runs the direct-upload service against a REAL S3 API (MinIO locally, never AWS).
 * Skipped unless S3_TEST_ENDPOINT is set:
 *
 *   S3_TEST_ENDPOINT=http://localhost:59000 S3_TEST_ACCESS_KEY=... S3_TEST_SECRET_KEY=... npx jest direct-uploads.s3
 */
import { randomBytes } from 'node:crypto';

import { CreateBucketCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';

import type { StorageService } from '../../storage/storage.service';
import type { DirectUpload } from './entities/direct-upload.entity';
import { DirectUploadsService } from './direct-uploads.service';

const endpoint = process.env['S3_TEST_ENDPOINT'];
const describeS3 = endpoint ? describe : describe.skip;

const MIB = 1024 * 1024;

/** Minimal in-memory stand-in for the TypeORM repository (the service only needs these calls). */
function fakeRepo(): Repository<DirectUpload> {
  const rows = new Map<string, DirectUpload>();
  const repo = {
    insert: (row: Partial<DirectUpload>) => {
      rows.set(row.id!, { status: 'initiated', failure_reason: null, completed_at: null, ...row } as DirectUpload);
      return Promise.resolve();
    },
    findOne: ({ where }: { where: { id: string } }) => Promise.resolve(rows.get(where.id) ?? null),
    update: (id: string, patch: Partial<DirectUpload>) => {
      Object.assign(rows.get(id)!, patch);
      return Promise.resolve();
    },
    find: () => Promise.resolve([...rows.values()]),
  };
  return repo as unknown as Repository<DirectUpload>;
}

const pdf = (bytes: number): Buffer =>
  Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(Math.max(0, bytes - 9))]);

async function put(url: string, body: Buffer, headers: Record<string, string>): Promise<number> {
  const res = await fetch(url, { method: 'PUT', body: new Uint8Array(body), headers });
  return res.status;
}

describeS3('DirectUploadsService against S3', () => {
  let client: S3Client;
  let service: DirectUploadsService;
  const filesBucket = `files-${Date.now()}`;
  const videoBucket = `video-${Date.now()}`;
  const env: Record<string, string> = {
    VIDEO_SOURCE_BUCKET: videoBucket,
    DIRECT_UPLOAD_PART_SIZE_MB: '5',
    DIRECT_UPLOAD_SINGLE_MAX_MB: '6',
  };

  beforeAll(async () => {
    client = new S3Client({
      region: 'us-east-1',
      endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env['S3_TEST_ACCESS_KEY']!,
        secretAccessKey: process.env['S3_TEST_SECRET_KEY']!,
      },
    });
    await client.send(new CreateBucketCommand({ Bucket: filesBucket }));
    await client.send(new CreateBucketCommand({ Bucket: videoBucket }));
    const storage = {
      getDirectUploadBackend: () => ({ client, bucket: filesBucket }),
    } as unknown as StorageService;
    const config = { get: (key: string) => env[key] } as unknown as ConfigService;
    service = new DirectUploadsService(fakeRepo(), storage, config);
  });

  const exists = async (bucket: string, key: string): Promise<boolean> =>
    client
      .send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
      .then(() => true)
      .catch(() => false);

  it('accepts a small PDF through a presigned single PUT and verifies it', async () => {
    const body = pdf(300_000);
    const init = await service.init('user-1', {
      purpose: 'book_file',
      filename: 'book.pdf',
      contentType: 'application/pdf',
      size: body.length,
    });
    expect(init.mode).toBe('single');
    if (init.mode !== 'single') return;

    expect(await put(init.url, body, init.headers)).toBe(200);
    const done = await service.complete('user-1', init.upload_id);
    expect(done).toMatchObject({ bucket: filesBucket, size: body.length, name: 'book.pdf' });
    expect(done.key).toMatch(/^books\/user-1\/[0-9a-f-]+\.pdf$/);
    expect(await exists(filesBucket, done.key)).toBe(true);
  });

  it('rejects and deletes an object whose bytes are not the declared type', async () => {
    const body = randomBytes(200_000); // not a PDF
    const init = await service.init('user-1', {
      purpose: 'book_file',
      filename: 'fake.pdf',
      contentType: 'application/pdf',
      size: body.length,
    });
    if (init.mode !== 'single') throw new Error('expected single');
    expect(await put(init.url, body, init.headers)).toBe(200);

    await expect(service.complete('user-1', init.upload_id)).rejects.toThrow(/content/i);
    const key = (await service['repo'].findOne({ where: { id: init.upload_id } }))!.object_key;
    expect(await exists(filesBucket, key)).toBe(false);
  });

  it('refuses a PUT whose body differs from the declared size (signed content-length)', async () => {
    const init = await service.init('user-1', {
      purpose: 'book_file',
      filename: 'size.pdf',
      contentType: 'application/pdf',
      size: 100_000,
    });
    if (init.mode !== 'single') throw new Error('expected single');
    const status = await put(init.url, pdf(150_000), init.headers);
    if (status === 200) {
      // Some S3-compatible servers ignore a signed length; the server-side check still catches it.
      await expect(service.complete('user-1', init.upload_id)).rejects.toThrow(/size/i);
    } else {
      expect(status).toBeGreaterThanOrEqual(400);
    }
  });

  it('refuses a PUT that changes the declared content type', async () => {
    const body = pdf(100_000);
    const init = await service.init('user-1', {
      purpose: 'book_file',
      filename: 'type.pdf',
      contentType: 'application/pdf',
      size: body.length,
    });
    if (init.mode !== 'single') throw new Error('expected single');
    const status = await put(init.url, body, { 'Content-Type': 'text/html' });
    if (status === 200) {
      await expect(service.complete('user-1', init.upload_id)).rejects.toThrow(/type/i);
    } else {
      expect(status).toBeGreaterThanOrEqual(400);
    }
  });

  it('runs a resumable multipart upload for a video and verifies the assembled object', async () => {
    const video = Buffer.concat([
      Buffer.from([0, 0, 0, 0x18]),
      Buffer.from('ftypmp42'),
      randomBytes(12 * MIB - 12),
    ]);
    const init = await service.init('teacher-9', {
      purpose: 'lesson_video',
      filename: 'lesson.mp4',
      contentType: 'video/mp4',
      size: video.length,
    });
    expect(init).toMatchObject({ mode: 'multipart', part_size: 5 * MIB, total_parts: 3 });
    if (init.mode !== 'multipart') return;

    // Upload only part 1, then "resume": ask what S3 already has.
    const first = (await service.partUrls('teacher-9', init.upload_id, [1]))[1]!;
    expect(await put(first, video.subarray(0, init.part_size), {})).toBe(200);
    expect(await service.listParts('teacher-9', init.upload_id)).toEqual([
      { part_number: 1, size: 5 * MIB },
    ]);

    // Completing early must fail but must NOT destroy the session: the client simply carries on.
    await expect(service.complete('teacher-9', init.upload_id)).rejects.toThrow(/incomplete/i);
    expect(await service.listParts('teacher-9', init.upload_id)).toHaveLength(1);

    const urls = await service.partUrls('teacher-9', init.upload_id, [2, 3]);
    for (const n of [2, 3]) {
      const slice = video.subarray((n - 1) * init.part_size, n * init.part_size);
      expect(await put(urls[n]!, slice, {})).toBe(200);
    }
    const done = await service.complete('teacher-9', init.upload_id);
    expect(done).toMatchObject({ bucket: videoBucket, size: video.length });
    expect(done.key).toMatch(/^source\/[0-9a-f-]+\/original\.mp4$/);
  });

  it('hides another user\'s session', async () => {
    const init = await service.init('owner', {
      purpose: 'lesson_resource',
      filename: 'a.pdf',
      contentType: 'application/pdf',
      size: 1000,
    });
    await expect(service.complete('intruder', init.upload_id)).rejects.toThrow(/not found/i);
    await expect(service.abort('intruder', init.upload_id)).rejects.toThrow(/not found/i);
  });

  it('rejects disallowed types, unsafe names and oversize declarations before any URL exists', async () => {
    const base = { purpose: 'book_file' as const, size: 1000 };
    await expect(
      service.init('u', { ...base, filename: 'x.exe', contentType: 'application/x-msdownload' }),
    ).rejects.toThrow();
    await expect(
      service.init('u', { ...base, filename: '../x.pdf', contentType: 'application/pdf' }),
    ).rejects.toThrow();
    await expect(
      service.init('u', {
        ...base,
        size: 201 * MIB,
        filename: 'x.pdf',
        contentType: 'application/pdf',
      }),
    ).rejects.toThrow(/too large/i);
  });
});
