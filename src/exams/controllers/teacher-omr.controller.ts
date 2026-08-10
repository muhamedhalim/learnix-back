import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
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
import { GenerateOmrSheetsDto, PatchOmrAnswerDto, ScanOmrSheetDto } from '../dto';
import { OMR_IMAGE_MAX_BYTES, OmrSheetsService } from '../services/omr-sheets.service';

interface MulterFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

function resolveLocale(value: unknown): 'en' | 'ar' {
  return value === 'en' ? 'en' : 'ar';
}

@ApiTags('Teacher · OMR')
@Controller('teacher/exams/:examId/omr-sheets')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('teacher')
@ApiBearerAuth('JWT-auth')
export class TeacherOmrController {
  constructor(private readonly omrSheets: OmrSheetsService) {}

  @Post('generate')
  @ApiOperation({ summary: 'Generate (or reuse) one OMR answer sheet per selected student' })
  public generate(
    @GetUser() user: JwtPayload,
    @Param('examId', ParseUUIDPipe) examId: string,
    @Body() dto: GenerateOmrSheetsDto,
  ) {
    return this.omrSheets.generate(examId, user.userId, dto);
  }

  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: OMR_IMAGE_MAX_BYTES, files: 1 } }))
  @ApiOperation({
    summary:
      'Upload a scanned/photographed answer sheet — the image is the source of the detected answers',
  })
  public scan(
    @GetUser() user: JwtPayload,
    @Param('examId', ParseUUIDPipe) examId: string,
    @Body() dto: ScanOmrSheetDto,
    @UploadedFile() file?: MulterFile,
  ) {
    return this.omrSheets.scan(examId, user.userId, dto, file);
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
  @ApiOperation({ summary: 'OMR sheet status/detail' })
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

  @Get(':sheetId/pdf')
  @ApiOperation({ summary: 'Download the printable question paper + answer sheet PDF' })
  public async pdf(
    @GetUser() user: JwtPayload,
    @Param('examId', ParseUUIDPipe) examId: string,
    @Param('sheetId', ParseUUIDPipe) sheetId: string,
    @Query('locale') locale: unknown,
    @Res() res: Response,
  ): Promise<void> {
    const buffer = await this.omrSheets.getSheetPdf(
      examId,
      user.userId,
      sheetId,
      resolveLocale(locale),
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="omr-sheet-${sheetId}.pdf"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(buffer);
  }

  @Get(':sheetId/review')
  @ApiOperation({ summary: 'Detected answers + which questions need teacher review' })
  public review(
    @GetUser() user: JwtPayload,
    @Param('examId', ParseUUIDPipe) examId: string,
    @Param('sheetId', ParseUUIDPipe) sheetId: string,
  ) {
    return this.omrSheets.getReview(examId, user.userId, sheetId);
  }

  @Patch(':sheetId/answers/:examQuestionId')
  @ApiOperation({ summary: 'Correct (or mark blank) one detected answer before confirming' })
  public patchAnswer(
    @GetUser() user: JwtPayload,
    @Param('examId', ParseUUIDPipe) examId: string,
    @Param('sheetId', ParseUUIDPipe) sheetId: string,
    @Param('examQuestionId', ParseUUIDPipe) examQuestionId: string,
    @Body() dto: PatchOmrAnswerDto,
  ) {
    return this.omrSheets.patchAnswer(examId, user.userId, sheetId, examQuestionId, dto);
  }

  @Post(':sheetId/confirm')
  @ApiOperation({ summary: 'Confirm reviewed answers and create/grade the resulting Attempt' })
  public confirm(
    @GetUser() user: JwtPayload,
    @Param('examId', ParseUUIDPipe) examId: string,
    @Param('sheetId', ParseUUIDPipe) sheetId: string,
  ) {
    return this.omrSheets.confirm(examId, user.userId, sheetId);
  }

  @Post(':sheetId/reprocess')
  @ApiOperation({ summary: 'Re-run recognition on the already-uploaded image' })
  public reprocess(
    @GetUser() user: JwtPayload,
    @Param('examId', ParseUUIDPipe) examId: string,
    @Param('sheetId', ParseUUIDPipe) sheetId: string,
  ) {
    return this.omrSheets.reprocess(examId, user.userId, sheetId);
  }
}
