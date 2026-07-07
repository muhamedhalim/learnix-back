import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { CreateOmrSheetDto } from '../dto';
import { OmrSheetsService } from '../services/omr-sheets.service';

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
  @UseInterceptors(FileInterceptor('file'))
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
  public list(@GetUser() user: JwtPayload, @Param('examId', ParseUUIDPipe) examId: string) {
    return this.omrSheets.findMany(examId, user.userId);
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
}
