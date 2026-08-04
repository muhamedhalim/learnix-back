import {
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import { ApiResponse, ApiTags } from '@nestjs/swagger';

import { Pagination20Dto } from '../../common/dto/pagination.dto';
import { SubjectFilterDto } from '../dto';
import { SubjectsService } from '../subjects.service';

@ApiTags('Subjects')
@Controller('subjects')
export class SubjectsController {
  constructor(private readonly subjectsService: SubjectsService) {}

  /**
   * Get all subjects with pagination and optional search
   * Public endpoint - no authentication required
   */
  @Get()
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'List of subjects retrieved successfully',
  })
  public async findAll(@Query() filter: SubjectFilterDto): Promise<unknown> {
    return await this.subjectsService.findAll(filter);
  }

  /**
   * Get a single subject by ID
   * Public endpoint - no authentication required
   */
  @Get(':id')
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Subject not found',
  })
  public async findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<unknown> {
    return await this.subjectsService.findOnePublic(id);
  }

  /**
   * Get teachers who teach a specific subject
   * Public endpoint - no authentication required
   */
  @Get(':id/teachers')
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Subject not found',
  })
  public async findTeachersBySubject(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() pagination: Pagination20Dto,
  ): Promise<unknown> {
    return await this.subjectsService.findTeachersBySubject(
      id,
      pagination.page,
      pagination.limit,
    );
  }
}
