import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { CommentsService, CommentWithReplies } from '../comments.service';
import { CreateCommentDto } from '../dto';

@ApiTags('Comments')
@Controller('student/lessons/:lessonId/comments')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
@ApiBearerAuth('JWT-auth')
export class CommentsStudentController {
  constructor(private readonly commentsService: CommentsService) {}

  @Post()
  @ApiOperation({ summary: 'Add a comment to a lesson (student)' })
  @ApiResponse({ status: 404, description: 'Lesson not found' })
  public async createComment(
    @Param('lessonId') lessonId: string,
    @Body() dto: CreateCommentDto,
    @GetUser() user: JwtPayload,
  ): Promise<CommentWithReplies> {
    return await this.commentsService.createComment(lessonId, user.userId, dto);
  }
}
