import {
  Body,
  Controller,
  Get,
  Post,
  Query,
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
import { ComplaintsService } from '../complaints.service';
import { ComplaintFilterDto,CreateComplaintDto } from '../dto';

interface AuthRequest extends Request {
  user: {
    id: string;
    email: string;
    role: string;
  };
}

@ApiTags('Complaints')
@Controller('student/complaints')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
@ApiBearerAuth('JWT')
export class ComplaintsStudentController {
  constructor(private complaintsService: ComplaintsService) {}

  @Post()
  @ApiOperation({ summary: 'Submit a complaint (student)' })
  @ApiResponse({ status: 201, description: 'Complaint created successfully' })
  public async createComplaint(
    @Body() dto: CreateComplaintDto,
    @Request() req: AuthRequest,
  ): Promise<unknown> {
    return this.complaintsService.createComplaint(req.user.id, dto);
  }

  @Get()
  @ApiOperation({ summary: 'View own complaints (student)' })
  @ApiResponse({
    status: 200,
    description: 'Complaints retrieved successfully',
  })
  public async getOwnComplaints(
    @Query() filter: ComplaintFilterDto,
    @Request() req: AuthRequest,
  ): Promise<unknown> {
    return this.complaintsService.getStudentComplaints(
      req.user.id,
      filter.page,
      filter.limit,
    );
  }
}
