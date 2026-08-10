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
import { GetUser } from '../common/decorators/get-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { THROTTLE } from '../common/constants';
import type { JwtPayload, UserRequest } from '../common/interfaces/user-request.interface';
import { Throttle } from '@nestjs/throttler';
import { GuardiansService } from '../guardians/guardians.service';
import { StudentFilterDto } from '../students/dto';
import { StudentsService } from '../students/students.service';
import { UsersService } from '../users/users.service';
import { CallCenterSupportService } from './callcenter-support.service';
import { SupportManagementService } from '../complaints/support-management.service';
import { SupportResourceFilterDto } from '../complaints/dto';
import {
  CallCenterFinanceFilterDto,
  CallCenterNotificationFilterDto,
  CallCenterUserFilterDto,
  TerminateUserSessionsDto,
} from './dto';
import { CallCenterUpdateStudentDto } from './dto/update-student.dto';

@ApiTags('Call Center')
@Controller('callcenter')
@UseGuards(HybridAuthGuard, RolesGuard)
// Legacy student lookup/update actions (GET/PUT students/:studentId, GET
// students) are explicitly Admin-only below — DEF-003. The Call Center
// receives only the permission-scoped support projection (users/* below).
@Roles('call_center', 'admin')
@ApiBearerAuth('JWT-auth')
export class CallCenterController {
  constructor(
    private readonly studentsService: StudentsService,
    private readonly usersService: UsersService,
    private readonly guardiansService: GuardiansService,
    private readonly supportService: CallCenterSupportService,
    private readonly supportManagement: SupportManagementService,
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
    const { name, phone, parent_phone: parentPhone } = dto;

    // Update user fields
    if (name != null || phone != null) {
      await this.usersService.update(studentId, {
        ...(name != null && name !== '' && { name }),
        ...(phone != null && phone !== '' && { phone }),
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

  @Get('notifications')
  @Roles('call_center')
  @ApiOperation({ summary: 'View support-ticket notification dispatch status' })
  public async supportNotifications(
    @Query() filter: CallCenterNotificationFilterDto,
  ): Promise<unknown> {
    return await this.supportService.listSupportNotifications(filter);
  }

  /**
   * DEF-012: the workload-triage counts the dashboard landing page needs
   * (open/assigned-to-me/unassigned/near-SLA-breach) that `reports()`/`sla()`
   * don't already cover. Scoped to the authenticated agent — "assigned to me"
   * is never derivable from a client-supplied id.
   */
  @Get('dashboard')
  @Roles('call_center')
  @ApiOperation({ summary: 'View Call Center dashboard workload counts for the current agent' })
  public async dashboard(@GetUser() user: JwtPayload): Promise<unknown> {
    const policy = await this.supportManagement.activePolicy();
    const warningWindowHours = policy?.warning_window_hours ?? 4;
    return await this.supportService.dashboardCounts(user.userId, warningWindowHours);
  }

  @Get('reports')
  @Roles('call_center')
  @ApiOperation({ summary: 'View read-only Call Center ticket metrics' })
  public async reports(): Promise<unknown> {
    return await this.supportService.supportReport();
  }

  @Get('sla')
  @Roles('call_center')
  @ApiOperation({ summary: 'View current SLA policy and ticket delay summary' })
  public async sla(): Promise<unknown> {
    const [policy, summary] = await Promise.all([
      this.supportManagement.activePolicy(),
      this.supportService.slaSummary(),
    ]);
    return {
      policy: policy
        ? {
            first_response_hours: policy.first_response_hours,
            resolution_hours: policy.resolution_hours,
            warning_window_hours: policy.warning_window_hours,
          }
        : { first_response_hours: 24, resolution_hours: 72, warning_window_hours: 4 },
      ...summary,
    };
  }

  @Get('resources/canned-responses')
  @Roles('call_center')
  public async cannedResponses(@Query() filter: SupportResourceFilterDto): Promise<unknown> {
    return await this.supportManagement.listCanned(filter);
  }

  @Get('resources/knowledge-base')
  @Roles('call_center')
  public async knowledgeBase(@Query() filter: SupportResourceFilterDto): Promise<unknown> {
    return await this.supportManagement.listArticles(filter);
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
