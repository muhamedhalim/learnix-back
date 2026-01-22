import { Controller, Delete, Param, UseGuards } from '@nestjs/common';
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

@ApiTags('Comments')
@Controller('admin/comments/:commentId')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@ApiBearerAuth('JWT')
export class CommentsAdminController {
  constructor(private commentsService: CommentsService) {}

  @Delete()
  @ApiOperation({ summary: 'Soft-delete a comment (admin)' })
  @ApiResponse({
    status: 200,
    description: 'Comment deleted successfully',
  })
  @ApiResponse({ status: 404, description: 'Comment not found' })
  async deleteComment(@Param('commentId') commentId: string) {
    await this.commentsService.deleteComment(commentId);
    return { message: 'Comment deleted successfully' };
  }
}
