import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { GuardianVerificationService } from '../../guardians/guardian-verification.service';
import { GuardiansService } from '../../guardians/guardians.service';
import { TeacherFollowUpService } from '../teacher-follow-up.service';

/**
 * Read-only guardian visibility for a teacher, plus a resend-OTP action.
 *
 * Every route re-derives ownership from `assertOwnsStudent` first — a teacher
 * cannot view or act on a guardian for a student who never bought anything
 * from them, mirroring `TeacherAttendanceController.validateOwnership`.
 * `GuardianVerificationService.requestCode` then re-checks that the guardian
 * id is actually linked to that student, so a stale/foreign guardian id in
 * the path is rejected twice over.
 */
@ApiTags('Teacher · Guardians')
@Controller('teacher/students/:studentId/guardians')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('teacher')
@ApiBearerAuth('JWT-auth')
export class TeacherGuardiansController {
  constructor(
    private readonly followUp: TeacherFollowUpService,
    private readonly guardians: GuardiansService,
    private readonly verification: GuardianVerificationService,
  ) {}

  @Get()
  @ApiOperation({ summary: "List a student's guardians" })
  public async list(
    @GetUser() user: JwtPayload,
    @Param('studentId', ParseUUIDPipe) studentId: string,
  ) {
    await this.followUp.assertOwnsStudent(user.userId, studentId);
    const links = await this.guardians.listForStudent(studentId);
    return { data: links };
  }

  @Post(':guardianId/resend-otp')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Resend the verification code to an unverified guardian',
    description: 'Rate limited: 1 per minute, 5 per hour, per guardian (same limits as the student-facing endpoint).',
  })
  @ApiResponse({ status: HttpStatus.TOO_MANY_REQUESTS, description: 'Rate limited' })
  public async resendOtp(
    @GetUser() user: JwtPayload,
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Param('guardianId', ParseUUIDPipe) guardianId: string,
  ) {
    await this.followUp.assertOwnsStudent(user.userId, studentId);
    const result = await this.verification.requestCode(studentId, guardianId);
    return { data: result };
  }
}
