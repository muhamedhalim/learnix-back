import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { CommentsService } from '../comments.service';
import { CreateReplyDto } from '../dto';

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
    @GetUser() user: JwtPayload,
  ): Promise<unknown> {
    return await this.commentsService.addReply(commentId, user.userId, dto);
  }
}
