import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { HybridAuthGuard } from '../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { THROTTLE } from '../common/constants';
import type { UserRequest } from '../common/interfaces/user-request.interface';
import { Throttle } from '@nestjs/throttler';
import { GuardiansService } from '../guardians/guardians.service';
import { StudentFilterDto } from '../students/dto';
import { StudentsService } from '../students/students.service';
import { UsersService } from '../users/users.service';
import { CallCenterSupportService } from './callcenter-support.service';
import {
  CallCenterFinanceFilterDto,
  CallCenterUserFilterDto,
  TerminateUserSessionsDto,
} from './dto';
import { CallCenterUpdateStudentDto } from './dto/update-student.dto';

@ApiTags('Call Center')
@Controller('callcenter')
@UseGuards(HybridAuthGuard, RolesGuard)
// Legacy student lookup/update actions are explicitly Admin-only below. The
// Call Center receives only the permission-scoped support projection.
@Roles('call_center', 'admin')
@ApiBearerAuth('JWT-auth')
export class CallCenterController {
  constructor(
    private readonly studentsService: StudentsService,
    private readonly usersService: UsersService,
    private readonly guardiansService: GuardiansService,
    private readonly supportService: CallCenterSupportService,
  ) {}

  @Get('students/:studentId')
  @Roles('admin')
  @ApiOperation({ summary: 'Get student profile (call center)' })
  @ApiResponse({ status: 200, description: 'Student profile retrieved' })
  public async getStudentProfile(@Param('studentId') studentId: string): Promise<unknown> {
    return await this.studentsService.findStudentProfile(studentId);
  }

  @Put('students/:studentId')
  @Roles('admin')
  @ApiOperation({ summary: 'Update student profile (call center)' })
  @ApiResponse({ status: 200, description: 'Student updated successfully' })
  public async updateStudent(
    @Param('studentId') studentId: string,
    @Body() dto: CallCenterUpdateStudentDto,
  ): Promise<{ message: string }> {
    const { name, phone, grade_level: gradeLevel, parent_phone: parentPhone } = dto;

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
  @Roles('admin')
  @ApiOperation({ summary: 'Search students (call center)' })
  @ApiResponse({ status: 200, description: 'Students retrieved successfully' })
  public async searchStudents(@Query() filter: StudentFilterDto): Promise<unknown> {
    return await this.studentsService.findAllStudents(filter);
  }

  @Get('users')
  @Roles('call_center')
  @ApiOperation({ summary: 'Search sanitized student and teacher support records' })
  public async searchSupportUsers(@Query() filter: CallCenterUserFilterDto): Promise<unknown> {
    return await this.supportService.findUsers(filter);
  }

  @Get('users/:userId')
  @Roles('call_center')
  @ApiOperation({ summary: 'View a sanitized support user record and recent tickets' })
  public async getSupportUser(@Param('userId', ParseUUIDPipe) userId: string): Promise<unknown> {
    return await this.supportService.getUser(userId);
  }

  @Get('agents')
  @Roles('call_center')
  @ApiOperation({ summary: 'List active Call Center agents for ticket assignment' })
  public async getActiveAgents(): Promise<unknown> {
    return await this.supportService.activeAgents();
  }

  @Get('finance/payments')
  @Roles('call_center')
  public async financePayments(@Query() filter: CallCenterFinanceFilterDto): Promise<unknown> {
    return await this.supportService.listFinancePayments(filter);
  }

  @Get('finance/settlements')
  @Roles('call_center')
  public async financeSettlements(@Query() filter: CallCenterFinanceFilterDto): Promise<unknown> {
    return await this.supportService.listFinanceSettlements(filter);
  }

  @Get('finance/receivables')
  @Roles('call_center')
  public async financeReceivables(@Query() filter: CallCenterFinanceFilterDto): Promise<unknown> {
    return await this.supportService.listTeacherReceivables(filter);
  }

  @Post('users/:userId/terminate-sessions')
  @Roles('call_center')
  @Throttle({ default: THROTTLE.STRICT })
  @ApiOperation({ summary: 'Terminate a user session set with an audited support reason' })
  public async terminateSupportUserSessions(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: TerminateUserSessionsDto,
    @Request() request: UserRequest,
  ): Promise<{ terminated: number }> {
    const actorId = request.user?.userId;
    if (actorId === undefined || actorId === '') {
      throw new ForbiddenException('User not authenticated');
    }
    return await this.supportService.terminateUserSessions(
      actorId,
      userId,
      dto.reason,
      request.ip ?? null,
    );
  }
}
