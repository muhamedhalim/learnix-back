import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import {
  ChangeGuardianPhoneDto,
  LinkGuardianDto,
  UpdateGuardianPreferencesDto,
  UpdateGuardianProfileDto,
  VerifyGuardianDto,
} from '../dto';
import { GuardianVerificationService } from '../guardian-verification.service';
import { GuardiansService } from '../guardians.service';

/**
 * Student-scoped guardian management.
 *
 * Every route derives the student id from the JWT — never from the path — so a
 * student can only ever read or mutate their own guardians. Guardian ids in the
 * path are additionally checked against the link table before use.
 */
@ApiTags('Student · Guardians')
@Controller('student/guardians')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('student')
@ApiBearerAuth('JWT-auth')
export class StudentGuardiansController {
  constructor(
    private readonly guardians: GuardiansService,
    private readonly verification: GuardianVerificationService,
  ) {}

  @Get()
  @ApiOperation({ summary: "List the authenticated student's guardians" })
  public async list(@GetUser() user: JwtPayload) {
    const links = await this.guardians.listForStudent(user.userId);
    return { data: links };
  }

  @Post()
  @ApiOperation({
    summary: 'Link a guardian',
    description:
      'Reuses an existing guardian when the normalised phone already exists (siblings share one guardian). The guardian starts UNVERIFIED and receives no educational notifications until an OTP is redeemed.',
  })
  @ApiResponse({ status: HttpStatus.CREATED, description: 'Guardian linked' })
  public async link(@GetUser() user: JwtPayload, @Body() dto: LinkGuardianDto) {
    const link = await this.guardians.linkGuardian(user.userId, dto);
    return { data: link };
  }

  @Post(':guardianId/verification/request')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Send an OTP to the guardian',
    description: 'Rate limited: 1 per minute, 5 per hour, per guardian.',
  })
  @ApiResponse({ status: HttpStatus.TOO_MANY_REQUESTS, description: 'Rate limited' })
  public async requestCode(
    @GetUser() user: JwtPayload,
    @Param('guardianId', ParseUUIDPipe) guardianId: string,
  ) {
    const result = await this.verification.requestCode(user.userId, guardianId);
    return { data: result };
  }

  @Post(':guardianId/verification/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Redeem the OTP and mark the guardian verified' })
  public async confirm(
    @GetUser() user: JwtPayload,
    @Param('guardianId', ParseUUIDPipe) guardianId: string,
    @Body() dto: VerifyGuardianDto,
  ) {
    const result = await this.verification.verifyCode(user.userId, guardianId, dto.code);
    return { data: result };
  }

  @Patch(':guardianId/preferences')
  @ApiOperation({ summary: 'Update per-student notification preferences for a guardian' })
  public async updatePreferences(
    @GetUser() user: JwtPayload,
    @Param('guardianId', ParseUUIDPipe) guardianId: string,
    @Body() dto: UpdateGuardianPreferencesDto,
  ) {
    const link = await this.guardians.updatePreferences(user.userId, guardianId, dto);
    return { data: link };
  }

  @Patch(':guardianId/profile')
  @ApiOperation({ summary: "Update the guardian's name / preferred language" })
  public async updateProfile(
    @GetUser() user: JwtPayload,
    @Param('guardianId', ParseUUIDPipe) guardianId: string,
    @Body() dto: UpdateGuardianProfileDto,
  ) {
    await this.guardians.getLinkOrThrow(user.userId, guardianId);
    const guardian = await this.guardians.updateGuardianProfile(guardianId, dto);
    return { data: guardian };
  }

  @Patch(':guardianId/phone')
  @ApiOperation({
    summary: 'Change an unverified guardian phone',
    description:
      'Rejected with 403 once the guardian is VERIFIED — otherwise a student could silently redirect their own grade notifications to a handset they control.',
  })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Guardian is verified' })
  public async changePhone(
    @GetUser() user: JwtPayload,
    @Param('guardianId', ParseUUIDPipe) guardianId: string,
    @Body() dto: ChangeGuardianPhoneDto,
  ) {
    const guardian = await this.guardians.changePhone(user.userId, guardianId, dto.phone);
    return { data: guardian };
  }

  @Post(':guardianId/primary')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Promote a guardian to primary' })
  public async setPrimary(
    @GetUser() user: JwtPayload,
    @Param('guardianId', ParseUUIDPipe) guardianId: string,
  ) {
    await this.guardians.setPrimary(user.userId, guardianId);
    return { data: { success: true } };
  }

  @Delete(':guardianId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Unlink a guardian from the student' })
  public async unlink(
    @GetUser() user: JwtPayload,
    @Param('guardianId', ParseUUIDPipe) guardianId: string,
  ): Promise<void> {
    await this.guardians.unlink(user.userId, guardianId);
  }
}
