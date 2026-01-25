import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse,ApiTags } from '@nestjs/swagger';

import { PaginatedResponse } from '../../common/interfaces/pagination.interface';
import { CommentsService, CommentWithReplies } from '../comments.service';
import { CommentFilterDto } from '../dto';

@ApiTags('Comments')
@Controller('lessons/:lessonId/comments')
export class CommentsPublicController {
  constructor(private commentsService: CommentsService) {}

  @Get()
  @ApiOperation({ summary: 'Get comments on a lesson (public, paginated)' })
  @ApiResponse({ status: 404, description: 'Lesson not found' })
  public async getCommentsByLesson(
    @Param('lessonId') lessonId: string,
    @Query() filter: CommentFilterDto,
  ): Promise<PaginatedResponse<CommentWithReplies>> {
    return this.commentsService.getCommentsByLesson(
      lessonId,
      filter.page,
      filter.limit,
    );
  }
}
