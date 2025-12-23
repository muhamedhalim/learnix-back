import {
  Injectable,
  NotFoundException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Subject } from './entities/subject.entity';
import { CreateSubjectDto, UpdateSubjectDto, SubjectFilterDto } from './dto';
import { PaginatedResponse } from '../common/interfaces/pagination.interface';
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
  async create(createSubjectDto: CreateSubjectDto): Promise<Subject> {
    // Check for duplicate title
    const existingByTitle = await this.subjectsRepository.findOne({
      where: { title: createSubjectDto.title },
    });

    if (existingByTitle) {
      throw new ConflictException(
        `Subject with title "${createSubjectDto.title}" already exists`,
      );
    }

    // Check for duplicate Arabic title
    const existingByTitleAr = await this.subjectsRepository.findOne({
      where: { title_ar: createSubjectDto.title_ar },
    });

    if (existingByTitleAr) {
      throw new ConflictException(
        `Subject with Arabic title "${createSubjectDto.title_ar}" already exists`,
      );
    }

    const subject = this.subjectsRepository.create(createSubjectDto);
    const savedSubject = await this.subjectsRepository.save(subject);

    this.logger.log(
      `Created subject: ${savedSubject.title} (ID: ${savedSubject.id})`,
    );

    return savedSubject;
  }

  /**
   * Find all subjects with pagination and optional search
   */
  async findAll(
    filter: SubjectFilterDto,
  ): Promise<PaginatedResponse<SubjectWithCounts>> {
    const { search, page = 1, limit = 20 } = filter;
    const skip = (page - 1) * limit;

    const queryBuilder = this.subjectsRepository
      .createQueryBuilder('subject')
      .select([
        'subject.id',
        'subject.title',
        'subject.title_ar',
        'subject.description',
        'subject.description_ar',
        'subject.created_at',
        'subject.updated_at',
      ])
      .where('subject.deleted_at IS NULL');

    // Add search filter
    if (search) {
      queryBuilder.andWhere(
        '(subject.title ILIKE :search OR subject.title_ar ILIKE :search)',
        { search: `%${search}%` },
      );
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
    const subjectsWithCounts: SubjectWithCounts[] = subjects.map((subject) => ({
      ...subject,
      teachersCount: 0, // Will be populated when teacher_subjects has data
      lessonsCount: 0, // Will be populated when lessons table has data
    }));

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
  async findOne(id: number): Promise<Subject> {
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
  async update(
    id: number,
    updateSubjectDto: UpdateSubjectDto,
  ): Promise<Subject> {
    const subject = await this.findOne(id);

    // Check for duplicate title if being updated
    if (updateSubjectDto.title && updateSubjectDto.title !== subject.title) {
      const existingByTitle = await this.subjectsRepository.findOne({
        where: { title: updateSubjectDto.title },
      });

      if (existingByTitle) {
        throw new ConflictException(
          `Subject with title "${updateSubjectDto.title}" already exists`,
        );
      }
    }

    // Check for duplicate Arabic title if being updated
    if (
      updateSubjectDto.title_ar &&
      updateSubjectDto.title_ar !== subject.title_ar
    ) {
      const existingByTitleAr = await this.subjectsRepository.findOne({
        where: { title_ar: updateSubjectDto.title_ar },
      });

      if (existingByTitleAr) {
        throw new ConflictException(
          `Subject with Arabic title "${updateSubjectDto.title_ar}" already exists`,
        );
      }
    }

    // Update subject
    Object.assign(subject, updateSubjectDto);
    const updatedSubject = await this.subjectsRepository.save(subject);

    this.logger.log(`Updated subject: ${updatedSubject.title} (ID: ${id})`);

    return updatedSubject;
  }

  /**
   * Soft delete a subject
   */
  async remove(id: number): Promise<void> {
    const subject = await this.findOne(id);

    // TODO: Check if subject has lessons (prevent deletion if used)
    // const lessonsCount = await this.lessonsRepository.count({ where: { subject_id: id } });
    // if (lessonsCount > 0) {
    //   throw new ConflictException('Cannot delete subject with existing lessons');
    // }

    await this.subjectsRepository.softRemove(subject);

    this.logger.log(`Deleted subject: ${subject.title} (ID: ${id})`);
  }

  /**
   * Find teachers by subject ID
   * Returns teachers who teach this subject with their stats
   */
  async findTeachersBySubject(
    subjectId: number,
    page: number = 1,
    limit: number = 20,
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
  async getSubjectsWithCounts(): Promise<SubjectWithCounts[]> {
    const subjects = await this.subjectsRepository.find({
      order: { title: 'ASC' },
    });

    // TODO: Add actual counts when relations are established
    return subjects.map((subject) => ({
      ...subject,
      teachersCount: 0,
      lessonsCount: 0,
    }));
  }
}
