import {
  Controller,
  Get,
  Put,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { StudentsService } from '../students/students.service';
import { UsersService } from '../users/users.service';
import { StudentFilterDto } from '../students/dto';
import { CallCenterUpdateStudentDto } from './dto/update-student.dto';

@ApiTags('Call Center')
@Controller('callcenter')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('call_center')
@ApiBearerAuth('JWT')
export class CallCenterController {
  constructor(
    private studentsService: StudentsService,
    private usersService: UsersService,
  ) {}

  @Get('students/:studentId')
  @ApiOperation({ summary: 'Get student profile (call center)' })
  @ApiResponse({ status: 200, description: 'Student profile retrieved' })
  async getStudentProfile(@Param('studentId') studentId: string) {
    return this.studentsService.findStudentProfile(studentId);
  }

  @Put('students/:studentId')
  @ApiOperation({ summary: 'Update student profile (call center)' })
  @ApiResponse({ status: 200, description: 'Student updated successfully' })
  async updateStudent(
    @Param('studentId') studentId: string,
    @Body() dto: CallCenterUpdateStudentDto,
  ) {
    // Update user fields (name, phone)
    if (dto.name || dto.phone) {
      await this.usersService.update(studentId, {
        ...(dto.name && { name: dto.name }),
        ...(dto.phone && { phone: dto.phone }),
      });
    }

    // Update profile fields (grade_level, parent_phone)
    if (dto.grade_level || dto.parent_phone) {
      await this.studentsService.updateProfile(studentId, {
        ...(dto.grade_level && { grade_level: dto.grade_level }),
        ...(dto.parent_phone && { parent_phone: dto.parent_phone }),
      });
    }

    return { message: 'Student updated successfully' };
  }

  @Get('students')
  @ApiOperation({ summary: 'Search students (call center)' })
  @ApiResponse({ status: 200, description: 'Students retrieved successfully' })
  async searchStudents(@Query() filter: StudentFilterDto) {
    return this.studentsService.findAllStudents(filter);
  }
}
