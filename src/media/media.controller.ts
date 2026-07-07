import { Controller, Get, Param, Res } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import type { Response } from 'express';

import { THROTTLE, PUBLIC_MEDIA_FOLDERS } from '../common/constants';
import { SkipCsrf } from '../common/guards/csrf.guard';
import { MediaService } from './media.service';

/**
 * Public media proxy. The ONLY way the frontend ever loads a "public" stored
 * asset (lesson/course thumbnails, generic images) — it never sees an R2/Bunny
 * URL, signed or otherwise. Streams bytes straight from `StorageService`, so
 * changing storage providers never requires a frontend change.
 *
 * Deliberately unauthenticated: every folder in `PUBLIC_MEDIA_FOLDERS` is
 * uploaded with `visibility: 'public'` already; this endpoint does not add
 * new exposure, it just stops the frontend from needing direct storage access.
 * Private folders (books, OMR sheets, etc.) are not in the allowlist and are
 * unreachable here regardless of what key is requested.
 */
@ApiTags('Media')
@Controller('media/public')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Get(':folder/:filename')
  @SkipCsrf()
  @Throttle({ default: THROTTLE.GLOBAL })
  @ApiOperation({
    summary: 'Serve a public media object (lesson/course thumbnails, images)',
    description: `Streams the object from storage. Allowed folders: ${PUBLIC_MEDIA_FOLDERS.join(', ')}.`,
  })
  @ApiParam({ name: 'folder', enum: PUBLIC_MEDIA_FOLDERS })
  @ApiParam({ name: 'filename', example: 'abc123.jpg' })
  @ApiResponse({ status: 200, description: 'Object streamed successfully' })
  @ApiResponse({ status: 404, description: 'Not found (unknown key, or folder not public)' })
  public async serve(
    @Param('folder') folder: string,
    @Param('filename') filename: string,
    @Res() res: Response,
  ): Promise<void> {
    const key = this.media.resolveKey(folder, filename);
    const object = await this.media.fetchObject(key);

    res.setHeader('Content-Type', object.contentType);
    res.setHeader('Cache-Control', this.media.cacheControl);
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    if (object.contentLength !== undefined) {
      res.setHeader('Content-Length', object.contentLength.toString());
    }

    object.stream.on('error', () => {
      res.destroy();
    });
    object.stream.pipe(res);
  }
}
