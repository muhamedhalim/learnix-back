import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import {
  AttachQuestionDto,
  CreateExamDto,
  ExamFilterDto,
  UpdateExamDto,
  UpsertSectionDto,
} from '../dto';
import { ExamAuthoringService } from '../services/exam-authoring.service';

@ApiTags('Teacher · Exams')
@Controller('teacher/exams')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('teacher')
@ApiBearerAuth('JWT-auth')
export class TeacherExamsController {
  constructor(private readonly authoring: ExamAuthoringService) {}

  @Post()
  @ApiOperation({ summary: 'Create a draft exam' })
  public create(@GetUser() user: JwtPayload, @Body() dto: CreateExamDto) {
    return this.authoring.createExam(user.userId, dto);
  }

  @Get()
  public list(@GetUser() user: JwtPayload, @Query() filter: ExamFilterDto) {
    return this.authoring.listExams(user.userId, filter);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Full authoring view (sections + questions)' })
  public getOne(@GetUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string) {
    return this.authoring.getExamForTeacher(id, user.userId);
  }

  @Put(':id')
  public update(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateExamDto,
  ) {
    return this.authoring.updateExam(id, user.userId, dto);
  }

  @Delete(':id')
  public async remove(@GetUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string) {
    await this.authoring.remove(id, user.userId);
    return { message: 'Exam deleted' };
  }

  @Post(':id/sections')
  @ApiOperation({ summary: 'Add a section' })
  public addSection(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpsertSectionDto,
  ) {
    return this.authoring.addSection(id, user.userId, dto);
  }

  @Delete(':id/sections/:sectionId')
  public async removeSection(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sectionId', ParseUUIDPipe) sectionId: string,
  ) {
    await this.authoring.removeSection(id, sectionId, user.userId);
    return { message: 'Section removed' };
  }

  @Post(':id/questions')
  @ApiOperation({ summary: 'Attach a bank question to the exam' })
  public attach(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AttachQuestionDto,
  ) {
    return this.authoring.attachQuestion(id, user.userId, dto);
  }

  @Delete(':id/questions/:examQuestionId')
  public async detach(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('examQuestionId', ParseUUIDPipe) examQuestionId: string,
  ) {
    await this.authoring.detachQuestion(id, examQuestionId, user.userId);
    return { message: 'Question detached' };
  }

  @Post(':id/publish')
  @ApiOperation({ summary: 'Publish (or schedule) the exam' })
  public publish(@GetUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string) {
    return this.authoring.publish(id, user.userId);
  }

  @Post(':id/archive')
  public archive(@GetUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string) {
    return this.authoring.archive(id, user.userId);
  }
}
