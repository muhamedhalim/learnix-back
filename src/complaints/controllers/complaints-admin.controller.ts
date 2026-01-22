import {
  Controller,
  Get,
  Post,
  Param,
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
import { RespondComplaintDto, ComplaintFilterDto } from '../dto';

interface AuthRequest extends Request {
  user: {
    id: string;
    email: string;
    role: string;
  };
}

@ApiTags('Complaints')
@Controller('admin/complaints')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@ApiBearerAuth('JWT')
export class ComplaintsAdminController {
  constructor(private complaintsService: ComplaintsService) {}

  @Get()
  @ApiOperation({ summary: 'List all complaints with filters (admin)' })
  @ApiResponse({
    status: 200,
    description: 'Complaints retrieved successfully',
  })
  async getAllComplaints(@Query() filter: ComplaintFilterDto) {
    return this.complaintsService.getAllComplaints(filter);
  }

  @Post(':id/respond')
  @ApiOperation({ summary: 'Respond to a complaint (admin)' })
  @ApiResponse({ status: 200, description: 'Response sent successfully' })
  @ApiResponse({ status: 404, description: 'Complaint not found' })
  async respondToComplaint(
    @Param('id') id: string,
    @Body() dto: RespondComplaintDto,
    @Request() req: AuthRequest,
  ) {
    return this.complaintsService.respondToComplaint(id, req.user.id, dto);
  }
}
