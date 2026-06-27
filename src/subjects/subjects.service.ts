import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { PaginatedResponse } from '../common/interfaces/pagination.interface';
import { CreateSubjectDto, SubjectFilterDto, UpdateSubjectDto } from './dto';
import { Subject } from './entities/subject.entity';
import { SubjectWithCounts } from './interfaces';

@Injectable()
export class SubjectsService {
  private readonly logger = new Logger(SubjectsService.name);

  constructor(
    @InjectRepository(Subject)
    private readonly subjectsRepository: Repository<Subject>,
  ) {}

  /**
   * Create a new subject
   */
  public async create(createSubjectDto: CreateSubjectDto): Promise<Subject> {
    // Check for duplicate name
    const existingByName = await this.subjectsRepository.findOne({
      where: { name: createSubjectDto.name },
    });

    if (existingByName) {
      throw new ConflictException(
        `Subject with name "${createSubjectDto.name}" already exists`,
      );
    }

    const subject = this.subjectsRepository.create({
      name: createSubjectDto.name,
      description: createSubjectDto.description ?? null,
      grade_level: createSubjectDto.gradeLevel,
      thumbnail: createSubjectDto.thumbnail ?? null,
    });
    const savedSubject = await this.subjectsRepository.save(subject);

    this.logger.log(
      `Created subject: ${savedSubject.name} (ID: ${savedSubject.id})`,
    );

    return savedSubject;
  }

  /**
   * Find all subjects with pagination and optional search
   */
  public async findAll(
    filter: SubjectFilterDto,
  ): Promise<PaginatedResponse<SubjectWithCounts>> {
    const { search, page = 1, limit = 20 } = filter;
    const skip = (page - 1) * limit;

    const queryBuilder = this.subjectsRepository
      .createQueryBuilder('subject')
      .select([
        'subject.id',
        'subject.name',
        'subject.description',
        'subject.grade_level',
        'subject.thumbnail',
        'subject.created_at',
        'subject.updated_at',
      ])
      .where('subject.deleted_at IS NULL');

    // Add search filter
    if (search !== undefined && search !== '') {
      queryBuilder.andWhere('subject.name ILIKE :search', {
        search: `%${search}%`,
      });
    }

    // Get total count
    const total = await queryBuilder.getCount();

    // Get paginated data
    const subjects = await queryBuilder
      .orderBy('subject.created_at', 'DESC')
      .skip(skip)
      .take(limit)
      .getMany();

    // Add counts (TODO: optimize with subqueries when teachers/lessons tables are populated)
    const subjectsWithCounts: SubjectWithCounts[] = subjects.map((subject) =>
      Object.assign({}, subject, {
        teachersCount: 0, // Will be populated when teacher_subjects has data
        lessonsCount: 0, // Will be populated when lessons table has data
      }),
    );

    const totalPages = Math.ceil(total / limit);

    return {
      data: subjectsWithCounts,
      meta: {
        total,
        page,
        limit,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    };
  }

  /**
   * Find a single subject by ID
   */
  public async findOne(id: string): Promise<Subject> {
    const subject = await this.subjectsRepository.findOne({
      where: { id },
    });

    if (!subject) {
      throw new NotFoundException(`Subject with ID ${id} not found`);
    }

    return subject;
  }

  /**
   * Update a subject
   */
  public async update(
    id: string,
    updateSubjectDto: UpdateSubjectDto,
  ): Promise<Subject> {
    const subject = await this.findOne(id);

    // Check for duplicate name if being updated
    if (
      updateSubjectDto.name !== undefined &&
      updateSubjectDto.name !== '' &&
      updateSubjectDto.name !== subject.name
    ) {
      const existingByName = await this.subjectsRepository.findOne({
        where: { name: updateSubjectDto.name },
      });

      if (existingByName) {
        throw new ConflictException(
          `Subject with name "${updateSubjectDto.name}" already exists`,
        );
      }
    }

    // Update subject with new field names
    if (updateSubjectDto.name !== undefined && updateSubjectDto.name !== '') {
      subject.name = updateSubjectDto.name;
    }
    if (updateSubjectDto.description !== undefined) {
      subject.description = updateSubjectDto.description;
    }
    if (updateSubjectDto.gradeLevel !== undefined) {
      subject.grade_level = updateSubjectDto.gradeLevel;
    }
    if (updateSubjectDto.thumbnail !== undefined) {
      subject.thumbnail = updateSubjectDto.thumbnail;
    }

    const updatedSubject = await this.subjectsRepository.save(subject);

    this.logger.log(`Updated subject: ${updatedSubject.name} (ID: ${id})`);

    return updatedSubject;
  }

  /**
   * Soft delete a subject
   */
  public async remove(id: string): Promise<void> {
    const subject = await this.findOne(id);

    // TODO: Check if subject has lessons (prevent deletion if used)
    // const lessonsCount = await this.lessonsRepository.count({ where: { subject_id: id } });
    // if (lessonsCount > 0) {
    //   throw new ConflictException('Cannot delete subject with existing lessons');
    // }

    await this.subjectsRepository.softRemove(subject);

    this.logger.log(`Deleted subject: ${subject.name} (ID: ${id})`);
  }

  /**
   * Find teachers by subject ID
   * Returns teachers who teach this subject with their stats
   */
  public async findTeachersBySubject(
    subjectId: string,
    page = 1,
    limit = 20,
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    // First verify subject exists
    await this.findOne(subjectId);

    // TODO: Implement when TeachersService is expanded
    // For now, return empty array structure
    const total = 0;
    const totalPages = Math.ceil(total / limit);

    return {
      data: [],
      meta: {
        total,
        page,
        limit,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    };
  }

  /**
   * Get subjects with teacher and lesson counts
   * Used for admin dashboard
   */
  public async getSubjectsWithCounts(): Promise<SubjectWithCounts[]> {
    const subjects = await this.subjectsRepository.find({
      order: { name: 'ASC' },
    });

    // TODO: Add actual counts when relations are established
    return subjects.map((subject) =>
      Object.assign({}, subject, {
        teachersCount: 0,
        lessonsCount: 0,
      }),
    );
  }
}
