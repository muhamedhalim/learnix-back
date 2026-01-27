import {
  Body,
  Controller,
  Get,
  Param,
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
import { ComplaintFilterDto, RespondComplaintDto } from '../dto';

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
  constructor(private readonly complaintsService: ComplaintsService) {}

  @Get()
  @ApiOperation({ summary: 'List all complaints with filters (admin)' })
  @ApiResponse({
    status: 200,
    description: 'Complaints retrieved successfully',
  })
  public async getAllComplaints(
    @Query() filter: ComplaintFilterDto,
  ): Promise<unknown> {
    return await this.complaintsService.getAllComplaints(filter);
  }

  @Post(':id/respond')
  @ApiOperation({ summary: 'Respond to a complaint (admin)' })
  @ApiResponse({ status: 404, description: 'Complaint not found' })
  public async respondToComplaint(
    @Param('id') id: string,
    @Body() dto: RespondComplaintDto,
    @Request() req: AuthRequest,
  ): Promise<unknown> {
    return await this.complaintsService.respondToComplaint(
      id,
      req.user.id,
      dto,
    );
  }
}
