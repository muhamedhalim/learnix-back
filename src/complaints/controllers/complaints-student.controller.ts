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
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { GetUser } from '../../common/decorators/get-user.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { ComplaintsService } from '../complaints.service';
import { ComplaintFilterDto, CreateComplaintDto, CreateComplaintMessageDto } from '../dto';

@ApiTags('Complaints')
@Controller('student/complaints')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
@ApiBearerAuth('JWT-auth')
export class ComplaintsStudentController {
  constructor(private readonly complaintsService: ComplaintsService) {}

  @Post()
  @ApiOperation({ summary: 'Submit a complaint (student)' })
  @ApiResponse({ status: 201, description: 'Complaint created successfully' })
  public async createComplaint(
    @Body() dto: CreateComplaintDto,
    @GetUser() user: JwtPayload,
  ): Promise<unknown> {
    return await this.complaintsService.createComplaint(user.userId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'View own complaints (student)' })
  @ApiResponse({
    status: 200,
    description: 'Complaints retrieved successfully',
  })
  public async getOwnComplaints(
    @Query() filter: ComplaintFilterDto,
    @GetUser() user: JwtPayload,
  ): Promise<unknown> {
    return await this.complaintsService.getStudentComplaints(
      user.userId,
      filter.page,
      filter.limit,
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'View one own complaint (student)' })
  public async getOwnComplaint(@Param('id', ParseUUIDPipe) id: string, @GetUser() user: JwtPayload): Promise<unknown> {
    return await this.complaintsService.getOwnTicket(id, user.userId);
  }

  @Post(':id/messages')
  @ApiOperation({ summary: 'Reply to one own complaint (student)' })
  public async addMessage(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateComplaintMessageDto,
    @GetUser() user: JwtPayload,
  ): Promise<unknown> {
    return await this.complaintsService.addComplainantMessage(id, user.userId, dto);
  }
}
