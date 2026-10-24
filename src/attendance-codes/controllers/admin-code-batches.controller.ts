import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { CodeBatchesService } from '../code-batches.service';
import { CodeBatchFilterDto, CreateCodeBatchDto } from '../dto';

@ApiTags('Admin - Code Batches')
@Controller('admin/code-batches')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('admin')
@ApiBearerAuth('JWT-auth')
export class AdminCodeBatchesController {
  constructor(private readonly codeBatchesService: CodeBatchesService) {}

  @Post()
  @ApiOperation({
    summary: 'Create a code batch',
    description:
      'Creates a batch and queues asynchronous generation of 1–100,000 attendance codes. Returns the PENDING batch immediately; poll GET /:id for progress.',
  })
  @ApiResponse({ status: 201, description: 'Batch created and generation queued' })
  public async create(
    @GetUser() user: JwtPayload,
    @Body() dto: CreateCodeBatchDto,
  ): Promise<unknown> {
    const batch = await this.codeBatchesService.createBatch(dto, user.userId);
    return { data: batch };
  }

  @Get()
  @ApiOperation({
    summary: 'List code batches',
    description: 'Paginated batches with filters: status, type, creator and date range.',
  })
  public async list(@Query() filter: CodeBatchFilterDto): Promise<unknown> {
    return await this.codeBatchesService.getBatches(filter);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a batch',
    description: 'Batch metadata, generation progress, and a code analytics breakdown.',
  })
  @ApiResponse({ status: 404, description: 'Batch not found' })
  public async detail(@Param('id', ParseUUIDPipe) id: string): Promise<unknown> {
    const data = await this.codeBatchesService.getBatch(id);
    return { data };
  }

  @Post(':id/resume')
  @ApiOperation({
    summary: 'Resume a stalled or failed batch',
    description:
      'Re-queues a FAILED batch, or a PROCESSING batch with no recent progress. Generation continues from the codes already stored.',
  })
  @ApiResponse({ status: 409, description: 'Batch is not resumable' })
  public async resume(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<unknown> {
    const data = await this.codeBatchesService.resumeBatch(id, user.userId);
    return { data };
  }

  @Get(':id/timeline')
  @ApiOperation({
    summary: 'Batch activity timeline',
    description:
      'Chronological events for the batch (created, started, completed/failed, exported, downloaded, revoked, deleted) with actor, timestamp and metadata.',
  })
  @ApiResponse({ status: 404, description: 'Batch not found' })
  public async timeline(@Param('id', ParseUUIDPipe) id: string): Promise<unknown> {
    const data = await this.codeBatchesService.getTimeline(id);
    return { data };
  }
}
