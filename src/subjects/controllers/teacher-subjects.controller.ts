import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
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

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import {
  CreateSubjectDto,
  SubjectFilterDto,
  TeacherSubjectFilterDto,
  UpdateSubjectDto,
} from '../dto';
import { SubjectsService } from '../subjects.service';

@ApiTags('Teacher Subjects')
@Controller('teacher/subjects')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('teacher')
@ApiBearerAuth('JWT-auth')
export class TeacherSubjectsController {
  constructor(private readonly subjectsService: SubjectsService) {}

  /**
   * List the authenticated teacher's own subjects, in any status.
   */
  @Get()
  @ApiOperation({
    summary: 'Get my subjects',
    description:
      "Returns a paginated list of the authenticated teacher's own subject submissions, " +
      'including pending, rejected and suspended ones. Teacher only.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Subjects retrieved successfully',
  })
  public async findMine(
    @GetUser() user: JwtPayload,
    @Query() filter: TeacherSubjectFilterDto,
  ): Promise<unknown> {
    return await this.subjectsService.findMineForTeacher(user.userId, filter);
  }

  /**
   * Subjects this teacher may attach to their own content.
   *
   * Declared before `:id` — Nest matches routes in declaration order, so a
   * literal segment that follows a parameterised one is unreachable.
   */
  @Get('selectable')
  @ApiOperation({
    summary: 'Get selectable subjects',
    description:
      'Returns the approved subject catalogue plus this teacher\'s own pending ' +
      'submissions, for use in lesson, course, exam, question and book forms.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Selectable subjects retrieved successfully',
  })
  public async findSelectable(
    @GetUser() user: JwtPayload,
    @Query() filter: SubjectFilterDto,
  ): Promise<unknown> {
    return await this.subjectsService.findSelectableForTeacher(user.userId, filter);
  }

  /**
   * Submit a new subject for review.
   */
  @Post()
  @ApiOperation({
    summary: 'Create a subject',
    description:
      'Creates a subject owned by the authenticated teacher. It starts as ' +
      'pending approval: usable in this teacher\'s own content immediately, ' +
      'visible to everyone else once an administrator approves it.',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Subject submitted for approval',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Subject with this name already exists',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Not authorized (teacher only)',
  })
  public async create(
    @Body() createSubjectDto: CreateSubjectDto,
    @GetUser() user: JwtPayload,
    @Ip() ip: string,
  ): Promise<unknown> {
    const subject = await this.subjectsService.createByTeacher(user.userId, createSubjectDto, ip);
    return {
      message: 'Subject submitted for approval',
      subject,
    };
  }

  /**
   * Read one of the authenticated teacher's own subjects.
   */
  @Get(':id')
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Subject not found',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Subject belongs to another teacher',
  })
  public async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @GetUser() user: JwtPayload,
  ): Promise<unknown> {
    return await this.subjectsService.findOneForTeacher(id, user.userId);
  }

  /**
   * Edit one of the authenticated teacher's own subjects. Allowed while the
   * subject is pending or rejected; editing a rejected subject re-submits it.
   */
  @Put(':id')
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Subject is approved or suspended, or the name is already taken',
  })
  public async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateSubjectDto: UpdateSubjectDto,
    @GetUser() user: JwtPayload,
    @Ip() ip: string,
  ): Promise<unknown> {
    const subject = await this.subjectsService.updateByTeacher(
      id,
      user.userId,
      updateSubjectDto,
      ip,
    );
    return {
      message: 'Subject updated successfully',
      subject,
    };
  }

  /**
   * Soft-delete one of the authenticated teacher's own subjects, provided no
   * content still references it.
   */
  @Delete(':id')
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Subject is still in use, or is approved/suspended',
  })
  public async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @GetUser() user: JwtPayload,
    @Ip() ip: string,
  ): Promise<unknown> {
    await this.subjectsService.removeByTeacher(id, user.userId, ip);
    return {
      message: 'Subject deleted successfully',
    };
  }
}
