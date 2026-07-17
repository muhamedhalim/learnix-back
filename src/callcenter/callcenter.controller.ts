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

import { HybridAuthGuard } from '../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { GuardiansService } from '../guardians/guardians.service';
import { StudentFilterDto } from '../students/dto';
import { StudentsService } from '../students/students.service';
import { UsersService } from '../users/users.service';
import { CallCenterUpdateStudentDto } from './dto/update-student.dto';

@ApiTags('Call Center')
@Controller('callcenter')
@UseGuards(HybridAuthGuard, RolesGuard)
// Admins share this surface: the frontend call-center screen lives in the
// admin dashboard, and RolesGuard has no implicit admin override.
@Roles('call_center', 'admin')
@ApiBearerAuth('JWT-auth')
export class CallCenterController {
  constructor(
    private readonly studentsService: StudentsService,
    private readonly usersService: UsersService,
    private readonly guardiansService: GuardiansService,
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
    if (gradeLevel != null && gradeLevel !== '') {
      await this.studentsService.updateProfile(studentId, {
        grade_level: gradeLevel,
      });
    }

    // A parent phone captured over the phone by an agent is still an *unproven*
    // number, so it lands as an UNVERIFIED guardian and receives nothing until
    // an OTP is redeemed. `linkGuardian` is idempotent per (student, phone).
    if (parentPhone != null && parentPhone !== '') {
      await this.guardiansService.linkGuardian(studentId, {
        phone: parentPhone,
        is_primary: true,
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
