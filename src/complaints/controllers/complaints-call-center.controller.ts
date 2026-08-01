import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';

import type { Response } from 'express';

import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { FILE_LIMITS, THROTTLE } from '../../common/constants';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { ComplaintsService } from '../complaints.service';
import {
  AssignComplaintDto,
  ComplaintFilterDto,
  CreateSupportMessageDto,
  TransitionComplaintDto,
} from '../dto';

/**
 * The Phase 2 API is intentionally limited to the existing coarse
 * CALL_CENTER role. Agent/Supervisor permission groups are a later phase;
 * all state-changing operations remain server-side guarded here.
 */
@ApiTags('Call Center Tickets')
@Controller('callcenter/tickets')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('call_center')
@ApiBearerAuth('JWT-auth')
export class ComplaintsCallCenterController {
  constructor(private readonly complaintsService: ComplaintsService) {}

  @Get()
  @ApiOperation({ summary: 'List support tickets (Call Center)' })
  public async list(@Query() filter: ComplaintFilterDto): Promise<unknown> {
    return await this.complaintsService.getSupportTickets(filter);
  }

  @Get(':id')
  @ApiOperation({ summary: 'View support ticket timeline (Call Center)' })
  public async getOne(@Param('id') id: string): Promise<unknown> {
    return await this.complaintsService.getSupportTicket(id);
  }

  @Post(':id/messages')
  @ApiOperation({ summary: 'Add a public reply or internal note (Call Center)' })
  public async addMessage(
    @Param('id') id: string,
    @Body() dto: CreateSupportMessageDto,
    @GetUser() user: JwtPayload,
  ): Promise<unknown> {
    return await this.complaintsService.addSupportMessage(id, user.userId, dto);
  }

  @Post(':id/attachments')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: FILE_LIMITS.CALL_CENTER_ATTACHMENT_MAX_SIZE, files: 1 },
    }),
  )
  @Throttle({ default: THROTTLE.FILE_UPLOAD })
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload private support evidence for a ticket' })
  public async addAttachment(
    @Param('id') id: string,
    @GetUser() user: JwtPayload,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<unknown> {
    if (!file) {
      throw new BadRequestException('No file provided');
    }
    return await this.complaintsService.addSupportAttachment(id, user.userId, file);
  }

  @Get(':id/attachments/:attachmentId/download')
  @ApiOperation({ summary: 'Download private ticket evidence' })
  public async downloadAttachment(
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
    @Res() res: Response,
  ): Promise<void> {
    const { attachment, object } = await this.complaintsService.getSupportAttachment(
      id,
      attachmentId,
    );
    res.setHeader('Content-Type', attachment.mime_type);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(attachment.original_filename)}`,
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (object.contentLength !== undefined) {
      res.setHeader('Content-Length', object.contentLength.toString());
    }
    object.stream.on('error', () => res.destroy());
    object.stream.pipe(res);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Transition a support ticket with optimistic locking' })
  public async transition(
    @Param('id') id: string,
    @Body() dto: TransitionComplaintDto,
    @GetUser() user: JwtPayload,
  ): Promise<unknown> {
    return await this.complaintsService.transitionTicket(id, user.userId, dto);
  }

  @Patch(':id/assignment')
  @ApiOperation({ summary: 'Assign a support ticket to a Call Center employee' })
  public async assign(
    @Param('id') id: string,
    @Body() dto: AssignComplaintDto,
    @GetUser() user: JwtPayload,
  ): Promise<unknown> {
    return await this.complaintsService.assignTicket(id, user.userId, dto);
  }
}
