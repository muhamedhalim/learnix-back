import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { CommentsService, CommentWithReplies } from '../comments.service';
import { CommentFilterDto } from '../dto';
import { PaginatedResponse } from '../../common/interfaces/pagination.interface';

@ApiTags('Comments')
@Controller('lessons/:lessonId/comments')
export class CommentsPublicController {
  constructor(private commentsService: CommentsService) {}

  @Get()
  @ApiOperation({ summary: 'Get comments on a lesson (public, paginated)' })
  @ApiResponse({
    status: 200,
    description: 'Comments retrieved successfully',
  })
  @ApiResponse({ status: 404, description: 'Lesson not found' })
  async getCommentsByLesson(
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
