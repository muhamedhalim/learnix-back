import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { ComplaintsService } from '../complaints.service';
import {
  AssignComplaintDto,
  ComplaintFilterDto,
  CreateSupportMessageDto,
  TransitionComplaintDto,
} from '../dto';

/**
 * The Phase 2 API is intentionally limited to the existing coarse
 * CALL_CENTER role. Agent/Supervisor permission groups are a later phase;
 * all state-changing operations remain server-side guarded here.
 */
@ApiTags('Call Center Tickets')
@Controller('callcenter/tickets')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('call_center')
@ApiBearerAuth('JWT-auth')
export class ComplaintsCallCenterController {
  constructor(private readonly complaintsService: ComplaintsService) {}

  @Get()
  @ApiOperation({ summary: 'List support tickets (Call Center)' })
  public async list(@Query() filter: ComplaintFilterDto): Promise<unknown> {
    return await this.complaintsService.getSupportTickets(filter);
  }

  @Get(':id')
  @ApiOperation({ summary: 'View support ticket timeline (Call Center)' })
  public async getOne(@Param('id') id: string): Promise<unknown> {
    return await this.complaintsService.getSupportTicket(id);
  }

  @Post(':id/messages')
  @ApiOperation({ summary: 'Add a public reply or internal note (Call Center)' })
  public async addMessage(
    @Param('id') id: string,
    @Body() dto: CreateSupportMessageDto,
    @GetUser() user: JwtPayload,
  ): Promise<unknown> {
    return await this.complaintsService.addSupportMessage(id, user.userId, dto);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Transition a support ticket with optimistic locking' })
  public async transition(
    @Param('id') id: string,
    @Body() dto: TransitionComplaintDto,
    @GetUser() user: JwtPayload,
  ): Promise<unknown> {
    return await this.complaintsService.transitionTicket(id, user.userId, dto);
  }

  @Patch(':id/assignment')
  @ApiOperation({ summary: 'Assign a support ticket to a Call Center employee' })
  public async assign(
    @Param('id') id: string,
    @Body() dto: AssignComplaintDto,
    @GetUser() user: JwtPayload,
  ): Promise<unknown> {
    return await this.complaintsService.assignTicket(id, user.userId, dto);
  }
}
