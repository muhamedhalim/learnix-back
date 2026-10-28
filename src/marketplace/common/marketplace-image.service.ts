import { randomUUID } from 'node:crypto';

import { BadRequestException, Injectable } from '@nestjs/common';

import { extensionMatchesMime, hasExpectedMagicBytes } from '../../common/utils/file-signature.util';
import { biBody } from '../../i18n/error-translator.util';
import { invalidImageReference } from './errors';
import { MarketplaceStorageService } from './marketplace-storage.service';

/**
 * Course covers and instructor photos are the marketplace's only *public* uploads: they are marketing
 * images shown to anonymous visitors. They live under the existing public-media folder `images/`, which
 * `GET /media/public/:folder/*` already serves (and the CDN already caches), in a marketplace-only
 * sub-folder per uploader.
 */
export const MARKETPLACE_IMAGE_FOLDER = 'images/marketplace';

/** 5 MB — the same ceiling as the academic teacher thumbnails. */
export const MAX_MARKETPLACE_IMAGE_BYTES = 5 * 1024 * 1024;

export const MARKETPLACE_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const KEY_PATTERN =
  /^images\/marketplace\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/;

export function marketplaceImagePrefix(userId: string): string {
  return `${MARKETPLACE_IMAGE_FOLDER}/${userId}/`;
}

/** True only for a key in the exact shape this module issues. */
export function isMarketplaceImageKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

/**
 * Validates an image reference arriving on a course or profile. An empty value is not an image
 * reference (callers decide whether it is required); a value equal to what is already stored is kept
 * as it is, so a record that predates uploads can still be saved unchanged; anything new must be a
 * key issued by `upload()` — never an arbitrary URL, which the pages would render as an `<img>`.
 *
 * Only the shape is checked, not whose folder the key is in: the files are public by design and their
 * names are random UUIDs, so referencing another user's file would require already knowing its key.
 */
export function assertMarketplaceImageKey(
  value: string | null | undefined,
  current?: string | null,
): void {
  if (value === undefined || value === null || value === '') return;
  if (current !== undefined && current !== null && value === current) return;
  if (!isMarketplaceImageKey(value)) throw invalidImageReference();
}

export interface UploadedImageFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

@Injectable()
export class MarketplaceImageService {
  constructor(private readonly storage: MarketplaceStorageService) {}

  /** Stores one validated image in the caller's folder and returns its key (never a storage URL). */
  public async upload(userId: string, file: UploadedImageFile | undefined): Promise<{ key: string }> {
    if (!file) {
      throw new BadRequestException(biBody('No file provided', 'لم يتم توفير أي ملف'));
    }
    if (!(MARKETPLACE_IMAGE_TYPES as readonly string[]).includes(file.mimetype)) {
      throw new BadRequestException(
        biBody('Image must be JPEG, PNG or WebP', 'يجب أن تكون الصورة بصيغة JPEG أو PNG أو WebP'),
      );
    }
    if (
      file.originalname.includes('..') ||
      file.originalname.includes('/') ||
      file.originalname.includes('\\') ||
      !extensionMatchesMime(file.originalname, file.mimetype) ||
      !hasExpectedMagicBytes(file.mimetype, file.buffer)
    ) {
      throw new BadRequestException(
        biBody(
          'The file extension, type or content is not a valid image',
          'امتداد الملف أو نوعه أو محتواه ليس صورة صالحة',
        ),
      );
    }
    if (file.size > MAX_MARKETPLACE_IMAGE_BYTES) {
      throw new BadRequestException(
        biBody(
          `Image cannot exceed ${MAX_MARKETPLACE_IMAGE_BYTES / (1024 * 1024)}MB`,
          `لا يمكن أن يتجاوز حجم الصورة ${MAX_MARKETPLACE_IMAGE_BYTES / (1024 * 1024)} ميجابايت`,
        ),
      );
    }

    const key = `${marketplaceImagePrefix(userId)}${randomUUID()}.${EXTENSION_BY_MIME[file.mimetype]}`;
    await this.storage.uploadPublicImage({ buffer: file.buffer, path: key, contentType: file.mimetype });
    return { key };
  }
}
