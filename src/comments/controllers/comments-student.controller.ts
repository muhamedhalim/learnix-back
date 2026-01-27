import {
  Body,
  Controller,
  Param,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CommentsService, CommentWithReplies } from '../comments.service';
import { CreateCommentDto } from '../dto';

interface AuthRequest extends Request {
  user: {
    id: string;
    email: string;
    role: string;
  };
}

@ApiTags('Comments')
@Controller('student/lessons/:lessonId/comments')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
@ApiBearerAuth('JWT')
export class CommentsStudentController {
  constructor(private readonly commentsService: CommentsService) {}

  @Post()
  @ApiOperation({ summary: 'Add a comment to a lesson (student)' })
  @ApiResponse({ status: 404, description: 'Lesson not found' })
  public async createComment(
    @Param('lessonId') lessonId: string,
    @Body() dto: CreateCommentDto,
    @Request() req: AuthRequest,
  ): Promise<CommentWithReplies> {
    return await this.commentsService.createComment(lessonId, req.user.id, dto);
  }
}
