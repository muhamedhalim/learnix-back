import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { ParentMessageFilterDto } from '../dto/parent-message-filter.dto';
import { ParentMessageAdminService } from '../services/parent-message-admin.service';

/**
 * Operator surface for the guardian pipeline: what was sent, to whom, over
 * which channel, whether it landed, and what to do when it did not.
 */
@ApiTags('Admin · Parent Messages')
@Controller('admin/parent-messages')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('admin')
@ApiBearerAuth('JWT-auth')
export class AdminParentMessagesController {
  constructor(private readonly admin: ParentMessageAdminService) {}

  @Get()
  @ApiOperation({
    summary: 'List guardian messages',
    description: 'Filter by status, event type, channel, student, guardian, or body text.',
  })
  public list(@Query() filter: ParentMessageFilterDto) {
    return this.admin.list(filter);
  }

  @Get('stats')
  @ApiOperation({
    summary: 'Delivery statistics',
    description:
      'Delivery/read rates are computed only over messages a provider accepted. SMS has no delivery callback and can never be confirmed delivered.',
  })
  public async stats() {
    return { data: await this.admin.stats() };
  }

  @Get('queue-health')
  @ApiOperation({ summary: 'Live BullMQ counters for the pipeline and its dead-letter queue' })
  public async queueHealth() {
    return { data: await this.admin.queueHealth() };
  }

  @Post(':id/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Retry a failed or dead message',
    description: 'No-op for messages already confirmed delivered or read.',
  })
  public async retry(@Param('id', ParseUUIDPipe) id: string) {
    return { data: await this.admin.retry(id) };
  }
}
