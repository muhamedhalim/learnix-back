import { BadRequestException, Body, Controller, Get, NotFoundException, Post, Patch, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { THROTTLE } from '../../../common/constants';
import { GetUser } from '../../../common/decorators/get-user.decorator';
import type { JwtPayload } from '../../../common/interfaces/user-request.interface';
import { biBody } from '../../../i18n/error-translator.util';
import { ApplicationDocumentsService, MAX_DOCUMENT_SIZE_BYTES } from '../application-documents.service';
import { UpdateInstructorApplicationDto } from '../dto';
import { InstructorApplication } from '../entities';
import { InstructorApplicationService } from '../instructor-application.service';

/**
 * Contracts §2 — the learner-facing side of a person's instructor
 * application. `Auth` guard shorthand: any authenticated user, not
 * `ApprovedInstructorGuard` (an applicant is not yet an instructor).
 */
@ApiTags('Marketplace / Instructor Applications')
@Controller('marketplace/applications')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class ApplicationsController {
  constructor(
    private readonly applications: InstructorApplicationService,
    private readonly documents: ApplicationDocumentsService,
  ) {}

  @Get('me')
  @ApiOperation({ summary: "Current user's instructor application, or 404" })
  public async getMine(@GetUser() user: JwtPayload): Promise<InstructorApplication> {
    const application = await this.applications.getMine(user.userId);
    if (!application) {
      throw new NotFoundException(biBody('No application found', 'لا يوجد طلب'));
    }
    return application;
  }

  @Post()
  @ApiOperation({ summary: 'Create a draft instructor application (409 on a second open application, FR-015)' })
  public async create(
    @GetUser() user: JwtPayload,
    @Body() dto: UpdateInstructorApplicationDto,
  ): Promise<InstructorApplication> {
    return this.applications.createDraft(user.userId, dto);
  }

  @Patch('me')
  @ApiOperation({ summary: 'Edit the application while draft or rejected' })
  public async update(
    @GetUser() user: JwtPayload,
    @Body() dto: UpdateInstructorApplicationDto,
  ): Promise<InstructorApplication> {
    return this.applications.updateDraft(user.userId, dto);
  }

  @Post('me/submit')
  @Throttle({ default: THROTTLE.STRICT })
  @ApiOperation({ summary: 'Submit for review; 422 lists each missing mandatory field (FR-011, FR-308)' })
  public async submit(@GetUser() user: JwtPayload): Promise<InstructorApplication> {
    return this.applications.submit(user.userId);
  }

  @Post('me/withdraw')
  @ApiOperation({ summary: 'Withdraw the application' })
  public async withdraw(@GetUser() user: JwtPayload): Promise<InstructorApplication> {
    return this.applications.withdraw(user.userId);
  }

  @Post('me/documents')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_DOCUMENT_SIZE_BYTES, files: 1 } }))
  @Throttle({ default: THROTTLE.FILE_UPLOAD })
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a private supporting document — returns a storage key, never a URL (FR-010, FR-303)' })
  public async uploadDocument(
    @GetUser() user: JwtPayload,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<{ key: string }> {
    if (!file) {
      throw new BadRequestException(biBody('No file provided', 'لم يتم توفير ملف'));
    }
    return this.documents.upload(user.userId, {
      buffer: file.buffer,
      contentType: file.mimetype,
      size: file.size,
    });
  }
}
