import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsString, Max, MaxLength, Min } from 'class-validator';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { DIRECT_UPLOAD_PURPOSES, type DirectUploadPurpose } from './direct-upload.policy';
import { DirectUploadsService } from './direct-uploads.service';

/** Purposes a teacher may use here. Marketplace instructors get their own route (video module). */
const TEACHER_PURPOSES = DIRECT_UPLOAD_PURPOSES;

export class InitDirectUploadDto {
  @IsIn(TEACHER_PURPOSES as unknown as string[])
  public purpose!: DirectUploadPurpose;

  @IsString()
  @MaxLength(255)
  public filename!: string;

  @IsString()
  @MaxLength(150)
  public content_type!: string;

  @IsInt()
  @Min(1)
  public size!: number;
}

export class PartUrlsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(10_000, { each: true })
  public part_numbers!: number[];
}

function logicalType(mime: string): string {
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.includes('word')) return 'docx';
  if (mime.includes('presentation') || mime.includes('powerpoint')) return 'pptx';
  if (mime.includes('zip')) return 'zip';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'other';
}

@ApiTags('Teacher Uploads')
@Controller('teacher/uploads/direct')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('teacher')
@ApiBearerAuth('JWT-auth')
export class DirectUploadsController {
  constructor(private readonly uploads: DirectUploadsService) {}

  @Get('capabilities')
  @ApiOperation({ summary: 'Which direct (browser-to-S3) upload purposes are available' })
  public capabilities(): ReturnType<DirectUploadsService['capabilities']> {
    return this.uploads.capabilities();
  }

  @Post('init')
  @ApiOperation({ summary: 'Start a direct upload; returns a presigned URL or multipart plan' })
  public init(
    @GetUser() user: JwtPayload,
    @Body() dto: InitDirectUploadDto,
  ): ReturnType<DirectUploadsService['init']> {
    return this.uploads.init(user.userId, {
      purpose: dto.purpose,
      filename: dto.filename,
      contentType: dto.content_type,
      size: dto.size,
    });
  }

  @Post(':id/parts')
  @HttpCode(200)
  @ApiOperation({ summary: 'Presigned URLs for specific multipart parts' })
  public async partUrls(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PartUrlsDto,
  ): Promise<{ urls: Record<number, string> }> {
    return { urls: await this.uploads.partUrls(user.userId, id, dto.part_numbers) };
  }

  @Get(':id/parts')
  @ApiOperation({ summary: 'Parts already stored (resume an interrupted upload)' })
  public async listParts(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ parts: Array<{ part_number: number; size: number }> }> {
    return { parts: await this.uploads.listParts(user.userId, id) };
  }

  @Post(':id/complete')
  @HttpCode(200)
  @ApiOperation({ summary: 'Finish the upload; the server re-verifies size, type and content' })
  public async complete(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{
    upload_id: string;
    key: string;
    upload_ref: string;
    name: string;
    type: string;
    size: number;
  }> {
    const done = await this.uploads.complete(user.userId, id);
    return {
      upload_id: done.id,
      key: done.key,
      upload_ref: done.key,
      name: done.name,
      type: logicalType(done.contentType),
      size: done.size,
    };
  }

  @Post(':id/abort')
  @HttpCode(204)
  @ApiOperation({ summary: 'Cancel an upload and discard what was uploaded' })
  public async abort(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.uploads.abort(user.userId, id);
  }
}
