import {
  Controller,
  Post,
  Get,
  Body,
  Query,
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
import { ComplaintsService } from '../complaints.service';
import { CreateComplaintDto, ComplaintFilterDto } from '../dto';

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
  async createComplaint(
    @Body() dto: CreateComplaintDto,
    @Request() req: AuthRequest,
  ) {
    return this.complaintsService.createComplaint(req.user.id, dto);
  }

  @Get()
  @ApiOperation({ summary: 'View own complaints (student)' })
  @ApiResponse({
    status: 200,
    description: 'Complaints retrieved successfully',
  })
  async getOwnComplaints(
    @Query() filter: ComplaintFilterDto,
    @Request() req: AuthRequest,
  ) {
    return this.complaintsService.getStudentComplaints(
      req.user.id,
      filter.page,
      filter.limit,
    );
  }
}
