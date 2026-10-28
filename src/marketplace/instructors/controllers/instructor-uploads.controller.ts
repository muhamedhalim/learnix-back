import { Controller, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { THROTTLE } from '../../../common/constants';
import { GetUser } from '../../../common/decorators/get-user.decorator';
import type { JwtPayload } from '../../../common/interfaces/user-request.interface';
import { ApprovedInstructor } from '../../common/decorators/approved-instructor.decorator';
import {
  MAX_MARKETPLACE_IMAGE_BYTES,
  MarketplaceImageService,
  type UploadedImageFile,
} from '../../common/marketplace-image.service';

/**
 * The approved instructor's image upload: a course cover or the profile photo. Returns a storage key,
 * never a URL; the key is then sent as `cover_image_key` / `photo_key`, where it is validated.
 *
 * `limits.fileSize` makes Multer stop reading as soon as the ceiling is crossed (413), so an oversized
 * body is never fully buffered; the service re-checks the size, the type, the extension and the file
 * signature.
 */
@ApiTags('Marketplace / Instructor Uploads')
@Controller('marketplace/instructor/uploads')
@ApprovedInstructor()
@ApiBearerAuth('JWT-auth')
export class InstructorUploadsController {
  constructor(private readonly images: MarketplaceImageService) {}

  @Post('image')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_MARKETPLACE_IMAGE_BYTES, files: 1 } }),
  )
  @Throttle({ default: THROTTLE.FILE_UPLOAD })
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary:
      'Upload a course cover or profile photo (JPEG, PNG or WebP, up to 5 MB). Returns a storage key.',
  })
  public async uploadImage(
    @GetUser() user: JwtPayload,
    @UploadedFile() file?: UploadedImageFile,
  ): Promise<{ key: string }> {
    return this.images.upload(user.userId, file);
  }
}
