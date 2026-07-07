import { Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { AdminExamFilterDto } from '../dto';
import { ExamAuthoringService } from '../services/exam-authoring.service';
import { AdminExamsService } from '../services/admin-exams.service';

@ApiTags('Admin · Exams')
@Controller('admin/exams')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('admin')
@ApiBearerAuth('JWT-auth')
export class AdminExamsController {
  constructor(
    private readonly adminExams: AdminExamsService,
    private readonly authoring: ExamAuthoringService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List exams across all teachers, with attempt/pass-rate stats' })
  public list(@Query() filter: AdminExamFilterDto) {
    return this.adminExams.list(filter);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Exam detail with full analytics (any teacher)' })
  public getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminExams.getOne(id);
  }

  @Post(':id/archive')
  public archive(@Param('id', ParseUUIDPipe) id: string) {
    return this.authoring.archiveAsAdmin(id);
  }

  @Post(':id/unarchive')
  public unarchive(@Param('id', ParseUUIDPipe) id: string) {
    return this.authoring.unarchiveAsAdmin(id);
  }
}
