import {
  Controller,
  Post,
  Param,
  Body,
  UseGuards,
  Request,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CommentsService } from '../comments.service';
import { CreateReplyDto } from '../dto';

interface AuthRequest extends Request {
  user: {
    id: string;
    email: string;
    role: string;
  };
}

@ApiTags('Comments')
@Controller('teacher/comments/:commentId/reply')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('teacher')
@ApiBearerAuth('JWT')
export class CommentsTeacherController {
  constructor(private commentsService: CommentsService) {}

  @Post()
  @ApiOperation({ summary: 'Reply to a comment on your lesson (teacher)' })
  @ApiResponse({ status: 201, description: 'Reply created successfully' })
  @ApiResponse({
    status: 400,
    description: 'Comment already has a reply or other validation error',
  })
  @ApiResponse({
    status: 403,
    description: 'You can only reply to comments on your own lessons',
  })
  @ApiResponse({ status: 404, description: 'Comment not found' })
  async addReply(
    @Param('commentId') commentId: string,
    @Body() dto: CreateReplyDto,
    @Request() req: AuthRequest,
  ) {
    return this.commentsService.addReply(commentId, req.user.id, dto);
  }
}
