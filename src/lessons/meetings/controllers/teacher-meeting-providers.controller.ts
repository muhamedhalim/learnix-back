import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { HybridAuthGuard } from '../../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { MeetingProviderRegistry } from '../meeting-provider-registry.service';
import type { MeetingProviderStatusDto } from '../dto/meeting-provider-status.dto';

@ApiTags('Teacher Meeting Providers')
@Controller('teacher/meeting-providers')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('teacher')
@ApiBearerAuth('JWT-auth')
export class TeacherMeetingProvidersController {
  public constructor(private readonly registry: MeetingProviderRegistry) {}

  @Get()
  public list(): MeetingProviderStatusDto[] {
    return this.registry.list();
  }
}
