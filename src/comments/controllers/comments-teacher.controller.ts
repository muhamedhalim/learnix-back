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
@ApiBearerAuth('JWT-auth')
export class CommentsTeacherController {
  constructor(private readonly commentsService: CommentsService) {}

  @Post()
  @ApiOperation({ summary: 'Reply to a comment on your lesson (teacher)' })
  @ApiResponse({ status: 404, description: 'Comment not found' })
  public async addReply(
    @Param('commentId') commentId: string,
    @Body() dto: CreateReplyDto,
    @Request() req: AuthRequest,
  ): Promise<unknown> {
    return await this.commentsService.addReply(commentId, req.user.id, dto);
  }
}
