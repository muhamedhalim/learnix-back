import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { ComplaintsService } from '../complaints.service';
import { ComplaintFilterDto, CreateComplaintDto, CreateComplaintMessageDto } from '../dto';

@ApiTags('Complaints')
@Controller('teacher/complaints')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('teacher')
@ApiBearerAuth('JWT-auth')
export class ComplaintsTeacherController {
  constructor(private readonly complaintsService: ComplaintsService) {}

  @Post()
  @ApiOperation({ summary: 'Submit a complaint (teacher)' })
  public async createComplaint(@Body() dto: CreateComplaintDto, @GetUser() user: JwtPayload): Promise<unknown> {
    return await this.complaintsService.createTeacherComplaint(user.userId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'View own complaints (teacher)' })
  public async getOwnComplaints(@Query() filter: ComplaintFilterDto, @GetUser() user: JwtPayload): Promise<unknown> {
    return await this.complaintsService.getTeacherComplaints(user.userId, filter.page, filter.limit);
  }

  @Get(':id')
  @ApiOperation({ summary: 'View one own complaint (teacher)' })
  public async getOwnComplaint(@Param('id', ParseUUIDPipe) id: string, @GetUser() user: JwtPayload): Promise<unknown> {
    return await this.complaintsService.getOwnTicket(id, user.userId);
  }

  @Post(':id/messages')
  @ApiOperation({ summary: 'Reply to one own complaint (teacher)' })
  public async addMessage(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateComplaintMessageDto,
    @GetUser() user: JwtPayload,
  ): Promise<unknown> {
    return await this.complaintsService.addComplainantMessage(id, user.userId, dto);
  }
}
