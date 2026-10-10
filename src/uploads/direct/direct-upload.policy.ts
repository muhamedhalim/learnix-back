import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';

import { extensionMatchesMime, hasExpectedMagicBytes } from '../../common/utils/file-signature.util';

export const DIRECT_UPLOAD_PURPOSES = ['book_file', 'lesson_resource', 'lesson_video'] as const;
export type DirectUploadPurpose = (typeof DIRECT_UPLOAD_PURPOSES)[number];

/** Which configured bucket holds the object. `video_source` is the private MediaConvert input bucket. */
export type DirectUploadBucket = 'files' | 'video_source';

export interface DirectUploadPolicy {
  purpose: DirectUploadPurpose;
  bucket: DirectUploadBucket;
  maxBytes: number;
  isAllowedType(mime: string): boolean;
  /** Object key for a new upload (never derived from the client file name beyond its extension). */
  keyFor(userId: string, originalName: string, mime: string, uploadId: string): string;
  /** First bytes of the stored object must look like the declared type. */
  verifyContent(mime: string, head: Buffer): boolean;
  /** Single presigned PUT up to this size; larger uses multipart. */
  singlePutMaxBytes: number;
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

const RESOURCE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-powerpoint',
  'application/zip',
  'application/x-zip-compressed',
  'audio/mpeg',
  'audio/wav',
  'audio/mp4',
]);

const VIDEO_TYPES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/x-matroska',
  'video/webm',
  'video/x-msvideo',
  'video/mpeg',
]);

const safeExt = (name: string): string => {
  const ext = extname(name).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '';
};

/** Container sniffing for video: MP4/MOV `ftyp`, Matroska/WebM EBML, AVI RIFF, MPEG start code. */
export function looksLikeVideo(head: Buffer): boolean {
  if (head.length < 12) return false;
  if (head.subarray(4, 8).toString('ascii') === 'ftyp') return true;
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return true;
  if (
    head.subarray(0, 4).toString('ascii') === 'RIFF' &&
    head.subarray(8, 11).toString('ascii') === 'AVI'
  ) {
    return true;
  }
  return head[0] === 0x00 && head[1] === 0x00 && head[2] === 0x01 && (head[3]! & 0xb0) === 0xb0;
}

export const DIRECT_UPLOAD_POLICIES: Record<DirectUploadPurpose, DirectUploadPolicy> = {
  book_file: {
    purpose: 'book_file',
    bucket: 'files',
    maxBytes: 200 * MB,
    singlePutMaxBytes: 100 * MB,
    isAllowedType: (mime) => mime === 'application/pdf',
    keyFor: (userId) => `books/${userId}/${randomUUID()}.pdf`,
    verifyContent: (mime, head) => hasExpectedMagicBytes(mime, head),
  },
  lesson_resource: {
    purpose: 'lesson_resource',
    bucket: 'files',
    maxBytes: 50 * MB,
    singlePutMaxBytes: 50 * MB,
    isAllowedType: (mime) => RESOURCE_TYPES.has(mime),
    keyFor: (userId, name) => `lesson-resources/${userId}/${randomUUID()}${safeExt(name)}`,
    verifyContent: (mime, head) => hasExpectedMagicBytes(mime, head),
  },
  lesson_video: {
    purpose: 'lesson_video',
    bucket: 'video_source',
    maxBytes: 20 * GB,
    singlePutMaxBytes: 100 * MB,
    isAllowedType: (mime) => VIDEO_TYPES.has(mime),
    keyFor: (_userId, name, _mime, uploadId) => `source/${uploadId}/original${safeExt(name)}`,
    verifyContent: (_mime, head) => looksLikeVideo(head),
  },
};

/** Video containers are not covered by the document extension/MIME table, so check them here. */
const VIDEO_EXTENSIONS: Record<string, string[]> = {
  'video/mp4': ['.mp4', '.m4v'],
  'video/quicktime': ['.mov'],
  'video/x-matroska': ['.mkv'],
  'video/webm': ['.webm'],
  'video/x-msvideo': ['.avi'],
  'video/mpeg': ['.mpg', '.mpeg'],
};

export function fileNameIsSafe(name: string, mime: string): boolean {
  if (
    name.length === 0 ||
    name.length > 255 ||
    name.includes('..') ||
    name.includes('/') ||
    name.includes('\\')
  ) {
    return false;
  }
  const videoExtensions = VIDEO_EXTENSIONS[mime];
  if (videoExtensions !== undefined) return videoExtensions.includes(extname(name).toLowerCase());
  return extensionMatchesMime(name, mime);
}
