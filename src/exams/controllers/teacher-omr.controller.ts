import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import type { Response } from 'express';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Pagination20Dto } from '../../common/dto/pagination.dto';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { CreateOmrSheetDto } from '../dto';
import { OMR_IMAGE_MAX_BYTES, OmrSheetsService } from '../services/omr-sheets.service';

interface MulterFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

@ApiTags('Teacher · OMR')
@Controller('teacher/exams/:examId/omr-sheets')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('teacher')
@ApiBearerAuth('JWT-auth')
export class TeacherOmrController {
  constructor(private readonly omrSheets: OmrSheetsService) {}

  @Post()
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: OMR_IMAGE_MAX_BYTES, files: 1 } }),
  )
  @ApiOperation({ summary: 'Submit a scanned answer sheet (image + pre-detected marks) for grading' })
  public create(
    @GetUser() user: JwtPayload,
    @Param('examId', ParseUUIDPipe) examId: string,
    @Body() dto: CreateOmrSheetDto,
    @UploadedFile() file?: MulterFile,
  ) {
    return this.omrSheets.create(examId, user.userId, dto, file);
  }

  @Get()
  @ApiOperation({ summary: 'List submitted OMR sheets for this exam' })
  public list(
    @GetUser() user: JwtPayload,
    @Param('examId', ParseUUIDPipe) examId: string,
    @Query() pagination: Pagination20Dto,
  ) {
    return this.omrSheets.findMany(examId, user.userId, pagination.page, pagination.limit);
  }

  @Get(':sheetId')
  @ApiOperation({ summary: 'OMR sheet status/detail (processing status, error, resulting attempt)' })
  public getOne(
    @GetUser() user: JwtPayload,
    @Param('examId', ParseUUIDPipe) examId: string,
    @Param('sheetId', ParseUUIDPipe) sheetId: string,
  ) {
    return this.omrSheets.findOne(examId, user.userId, sheetId);
  }

  @Get(':sheetId/image')
  @ApiOperation({ summary: 'Download an owned private OMR scan' })
  public async image(
    @GetUser() user: JwtPayload,
    @Param('examId', ParseUUIDPipe) examId: string,
    @Param('sheetId', ParseUUIDPipe) sheetId: string,
    @Res() res: Response,
  ): Promise<void> {
    const object = await this.omrSheets.getImageObject(examId, user.userId, sheetId);
    res.setHeader('Content-Type', object.contentType);
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (object.contentLength !== undefined) {
      res.setHeader('Content-Length', object.contentLength.toString());
    }
    object.stream.on('error', () => res.destroy());
    object.stream.pipe(res);
  }
}
