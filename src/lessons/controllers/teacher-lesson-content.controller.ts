import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import {
  CreateAttachmentDto,
  CreateHomeworkDto,
  UpdateHomeworkDto,
} from '../dto';
import { LessonContentService } from '../lesson-content.service';

@ApiTags('Teacher Lesson Content')
@Controller('teacher/lessons')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('teacher')
@ApiBearerAuth('JWT-auth')
export class TeacherLessonContentController {
  constructor(private readonly contentService: LessonContentService) {}

  /* ===================== Attachments ===================== */

  @Get(':lessonId/attachments')
  @ApiOperation({ summary: 'List a lesson\'s attachments' })
  public async listAttachments(
    @GetUser() user: JwtPayload,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
  ): Promise<{ data: unknown[] }> {
    const data = await this.contentService.listAttachments(lessonId, user.userId);
    return { data };
  }

  @Post(':lessonId/attachments')
  @ApiOperation({ summary: 'Attach a resource to a lesson' })
  public async addAttachment(
    @GetUser() user: JwtPayload,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
    @Body() dto: CreateAttachmentDto,
  ): Promise<{ message: string; data: unknown }> {
    const data = await this.contentService.addAttachment(lessonId, user.userId, dto);
    return { message: 'Attachment added', data };
  }

  @Delete(':lessonId/attachments/:attachmentId')
  @ApiOperation({ summary: 'Delete a lesson attachment' })
  public async deleteAttachment(
    @GetUser() user: JwtPayload,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
  ): Promise<{ message: string }> {
    await this.contentService.deleteAttachment(lessonId, attachmentId, user.userId);
    return { message: 'Attachment deleted' };
  }

  /* ===================== Homework ===================== */

  @Get(':lessonId/homework')
  @ApiOperation({ summary: 'List a lesson\'s homework' })
  public async listHomework(
    @GetUser() user: JwtPayload,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
  ): Promise<{ data: unknown[] }> {
    const data = await this.contentService.listHomework(lessonId, user.userId);
    return { data };
  }

  @Post(':lessonId/homework')
  @ApiOperation({ summary: 'Add homework to a lesson' })
  public async addHomework(
    @GetUser() user: JwtPayload,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
    @Body() dto: CreateHomeworkDto,
  ): Promise<{ message: string; data: unknown }> {
    const data = await this.contentService.addHomework(lessonId, user.userId, dto);
    return { message: 'Homework added', data };
  }

  @Patch(':lessonId/homework/:homeworkId')
  @ApiOperation({ summary: 'Update lesson homework' })
  public async updateHomework(
    @GetUser() user: JwtPayload,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
    @Param('homeworkId', ParseUUIDPipe) homeworkId: string,
    @Body() dto: UpdateHomeworkDto,
  ): Promise<{ message: string; data: unknown }> {
    const data = await this.contentService.updateHomework(
      lessonId,
      homeworkId,
      user.userId,
      dto,
    );
    return { message: 'Homework updated', data };
  }

  @Delete(':lessonId/homework/:homeworkId')
  @ApiOperation({ summary: 'Delete lesson homework' })
  public async deleteHomework(
    @GetUser() user: JwtPayload,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
    @Param('homeworkId', ParseUUIDPipe) homeworkId: string,
  ): Promise<{ message: string }> {
    await this.contentService.deleteHomework(lessonId, homeworkId, user.userId);
    return { message: 'Homework deleted' };
  }
}
