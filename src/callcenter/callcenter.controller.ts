import {
  Body,
  Controller,
  Get,
  Param,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { StudentFilterDto } from '../students/dto';
import { StudentsService } from '../students/students.service';
import { UsersService } from '../users/users.service';

import { CallCenterUpdateStudentDto } from './dto/update-student.dto';

@ApiTags('Call Center')
@Controller('callcenter')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('call_center')
@ApiBearerAuth('JWT')
export class CallCenterController {
  constructor(
    private readonly studentsService: StudentsService,
    private readonly usersService: UsersService,
  ) {}

  @Get('students/:studentId')
  @ApiOperation({ summary: 'Get student profile (call center)' })
  @ApiResponse({ status: 200, description: 'Student profile retrieved' })
  public async getStudentProfile(
    @Param('studentId') studentId: string,
  ): Promise<unknown> {
    return await this.studentsService.findStudentProfile(studentId);
  }

  @Put('students/:studentId')
  @ApiOperation({ summary: 'Update student profile (call center)' })
  @ApiResponse({ status: 200, description: 'Student updated successfully' })
  public async updateStudent(
    @Param('studentId') studentId: string,
    @Body() dto: CallCenterUpdateStudentDto,
  ): Promise<{ message: string }> {
    const {
      name,
      phone,
      grade_level: gradeLevel,
      parent_phone: parentPhone,
    } = dto;

    // Update user fields
    if (name != null || phone != null) {
      await this.usersService.update(studentId, {
        ...(name != null && name !== '' && { name }),
        ...(phone != null && phone !== '' && { phone }),
      });
    }

    // Update profile fields
    if (gradeLevel != null || parentPhone != null) {
      await this.studentsService.updateProfile(studentId, {
        ...(gradeLevel != null &&
          gradeLevel !== '' && { grade_level: gradeLevel }),
        ...(parentPhone != null &&
          parentPhone !== '' && { parent_phone: parentPhone }),
      });
    }

    return { message: 'Student updated successfully' };
  }

  @Get('students')
  @ApiOperation({ summary: 'Search students (call center)' })
  @ApiResponse({ status: 200, description: 'Students retrieved successfully' })
  public async searchStudents(
    @Query() filter: StudentFilterDto,
  ): Promise<unknown> {
    return await this.studentsService.findAllStudents(filter);
  }
}
