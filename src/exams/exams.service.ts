import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import {
  Exam,
  ExamAttempt,
  ExamStatus,
  QuestionType,
  Question,
  Answer,
} from './entities';
import { User } from '../users/entities/user.entity';
import { Subject } from '../subjects/entities/subject.entity';
import { UserRole } from '../users/entities/user-role.enum';
import {
  CreateExamDto,
  UpdateExamDto,
  SubmitExamDto,
  GradeEssayDto,
  ExamFilterDto,
  StudentExamFilterDto,
} from './dto';
import {
  PaginatedResponse,
  PaginationMeta,
} from '../common/interfaces/pagination.interface';

/**
 * Response type for exam with teacher and subject details
 */
export interface ExamWithDetails {
  id: string;
  title: string;
  title_ar: string;
  description: string | null;
  description_ar: string | null;
  teacher: {
    id: string;
    name: string;
    email: string;
  };
  subject: {
    id: string;
    name: string;
    grade_level: string;
  };
  questions_count: number;
  total_marks: number;
  passing_marks: number;
  duration: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

/**
 * Response type for exam list item with stats
 */
export interface ExamListItem extends ExamWithDetails {
  submissions_count: number;
  average_score: number | null;
}

/**
 * Response type for student's available exam (without correct answers)
 */
export interface ExamForTaking {
  id: string;
  title: string;
  title_ar: string;
  description: string | null;
  description_ar: string | null;
  total_marks: number;
  duration: number;
  questions: {
    index: number;
    type: QuestionType;
    question: string;
    question_ar: string;
    choices?: string[];
    marks: number;
  }[];
}

/**
 * Response type for exam submission result
 */
export interface SubmissionResult {
  message: string;
  attempt_id: string;
  score_mcq: number;
  essay_pending: boolean;
  total_mcq_questions: number;
  total_essay_questions: number;
  status: ExamStatus;
  submitted_at: Date;
}

/**
 * Response type for exam result (fully graded)
 */
export interface ExamResult {
  exam_id: string;
  exam_title: string;
  exam_title_ar: string;
  score_mcq: number;
  score_essay: number | null;
  total_score: number;
  max_score: number;
  percentage: number;
  passed: boolean;
  answers: {
    question_index: number;
    type: QuestionType;
    question: string;
    question_ar: string;
    your_answer: string;
    correct_answer?: string;
    is_correct?: boolean;
    score: number;
    max_marks: number;
    feedback?: string | null;
  }[];
  submitted_at: Date;
  graded_at: Date;
}

/**
 * Response type for student submission (for teacher grading)
 */
export interface ExamSubmission {
  student: {
    id: string;
    name: string;
    email: string;
  };
  score_mcq: number;
  score_essay: number | null;
  total_score: number | null;
  status: ExamStatus;
  essay_answers: {
    question_index: number;
    question: string;
    question_ar: string;
    answer: string;
    marks: number;
    score: number | null;
    feedback: string | null;
  }[];
  submitted_at: Date;
}

@Injectable()
export class ExamsService {
  constructor(
    @InjectRepository(Exam)
    private readonly examsRepository: Repository<Exam>,
    @InjectRepository(ExamAttempt)
    private readonly attemptsRepository: Repository<ExamAttempt>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(Subject)
    private readonly subjectsRepository: Repository<Subject>,
  ) {}

  // ==================== TEACHER METHODS ====================

  /**
   * Create a new exam
   * Only teachers can create exams
   */
  async create(
    teacherId: string,
    dto: CreateExamDto,
  ): Promise<ExamWithDetails> {
    // Validate teacher exists and has correct role
    const teacher = await this.usersRepository.findOne({
      where: { id: teacherId },
    });

    if (!teacher) {
      throw new NotFoundException(`Teacher with ID ${teacherId} not found`);
    }

    if (teacher.role !== UserRole.TEACHER) {
      throw new BadRequestException('Only teachers can create exams');
    }

    // Validate subject exists
    const subject = await this.subjectsRepository.findOne({
      where: { id: dto.subject_id },
    });

    if (!subject) {
      throw new NotFoundException(
        `Subject with ID ${dto.subject_id} not found`,
      );
    }

    // Validate questions and calculate total marks
    const questions: Question[] = [];
    let totalMarks = 0;

    for (let i = 0; i < dto.questions.length; i++) {
      const q = dto.questions[i];
      if (!q) continue; // TypeScript guard

      // Validate MCQ questions
      if (q.type === QuestionType.MCQ) {
        if (!q.choices || q.choices.length < 2) {
          throw new BadRequestException(
            `Question ${i + 1}: MCQ must have at least 2 choices`,
          );
        }
        if (!q.correct_answer) {
          throw new BadRequestException(
            `Question ${i + 1}: MCQ must have a correct answer`,
          );
        }
        if (!q.choices.includes(q.correct_answer)) {
          throw new BadRequestException(
            `Question ${i + 1}: Correct answer must be one of the choices`,
          );
        }
      }

      // Validate Essay questions (should not have choices)
      if (q.type === QuestionType.ESSAY) {
        if (q.choices && q.choices.length > 0) {
          throw new BadRequestException(
            `Question ${i + 1}: Essay questions should not have choices`,
          );
        }
        if (q.correct_answer) {
          throw new BadRequestException(
            `Question ${i + 1}: Essay questions should not have a correct answer`,
          );
        }
      }

      questions.push({
        type: q.type,
        question: q.question,
        question_ar: q.question_ar,
        choices: q.type === QuestionType.MCQ ? q.choices : undefined,
        correct_answer:
          q.type === QuestionType.MCQ ? q.correct_answer : undefined,
        marks: q.marks,
      });

      totalMarks += q.marks;
    }

    // Validate passing marks
    if (dto.passing_marks > totalMarks) {
      throw new BadRequestException(
        `Passing marks (${dto.passing_marks}) cannot exceed total marks (${totalMarks})`,
      );
    }

    // Create exam
    const exam = this.examsRepository.create({
      title: dto.title,
      title_ar: dto.title_ar,
      description: dto.description || null,
      description_ar: dto.description_ar || null,
      teacher_id: teacherId,
      subject_id: dto.subject_id,
      questions,
      total_marks: totalMarks,
      passing_marks: dto.passing_marks,
      duration: dto.duration,
      is_active: true,
    });

    const savedExam = await this.examsRepository.save(exam);

    // Reload with relations
    const fullExam = await this.examsRepository.findOne({
      where: { id: savedExam.id },
      relations: ['teacher', 'subject'],
    });

    return this.mapToExamWithDetails(fullExam!);
  }

  /**
   * Find teacher's own exams with stats
   */
  async findMyExams(
    teacherId: string,
    filter: ExamFilterDto,
  ): Promise<PaginatedResponse<ExamListItem>> {
    const {
      search,
      subject_id,
      is_active,
      sort_by,
      sort_order,
      page = 1,
      limit = 20,
    } = filter;

    const queryBuilder = this.examsRepository
      .createQueryBuilder('exam')
      .leftJoinAndSelect('exam.teacher', 'teacher')
      .leftJoinAndSelect('exam.subject', 'subject')
      .leftJoin('exam.attempts', 'attempt')
      .where('exam.deleted_at IS NULL')
      .andWhere('exam.teacher_id = :teacherId', { teacherId });

    // Filters
    if (search) {
      queryBuilder.andWhere(
        `(exam.title ILIKE :search OR exam.title_ar ILIKE :search)`,
        { search: `%${search}%` },
      );
    }

    if (subject_id) {
      queryBuilder.andWhere('exam.subject_id = :subject_id', { subject_id });
    }

    if (is_active !== undefined) {
      queryBuilder.andWhere('exam.is_active = :is_active', { is_active });
    }

    // Add aggregations for stats
    queryBuilder
      .addSelect('COUNT(DISTINCT attempt.id)', 'submissions_count')
      .addSelect(
        `AVG(CASE WHEN attempt.status = '${ExamStatus.GRADED}' THEN attempt.total_score ELSE NULL END)`,
        'average_score',
      )
      .groupBy('exam.id')
      .addGroupBy('teacher.id')
      .addGroupBy('subject.id');

    // Sorting
    const sortColumn = `exam.${sort_by || 'created_at'}`;
    queryBuilder.orderBy(sortColumn, sort_order || 'DESC');

    // Get total count (need separate query due to grouping)
    const countQuery = this.examsRepository
      .createQueryBuilder('exam')
      .where('exam.deleted_at IS NULL')
      .andWhere('exam.teacher_id = :teacherId', { teacherId });

    if (search) {
      countQuery.andWhere(
        `(exam.title ILIKE :search OR exam.title_ar ILIKE :search)`,
        { search: `%${search}%` },
      );
    }
    if (subject_id) {
      countQuery.andWhere('exam.subject_id = :subject_id', { subject_id });
    }
    if (is_active !== undefined) {
      countQuery.andWhere('exam.is_active = :is_active', { is_active });
    }

    const total = await countQuery.getCount();

    // Apply pagination
    const skip = (page - 1) * limit;
    queryBuilder.offset(skip).limit(limit);

    const rawResults = await queryBuilder.getRawAndEntities();

    // Define type for raw results
    interface RawExamStats {
      submissions_count?: string;
      average_score?: string;
    }

    // Map results with stats
    const exams: ExamListItem[] = rawResults.entities.map((exam, index) => {
      const raw = rawResults.raw[index] as RawExamStats | undefined;
      return {
        ...this.mapToExamWithDetails(exam),
        submissions_count: parseInt(raw?.submissions_count ?? '0') || 0,
        average_score: raw?.average_score
          ? parseFloat(raw.average_score)
          : null,
      };
    });

    // Calculate pagination meta
    const totalPages = Math.ceil(total / limit);
    const meta: PaginationMeta = {
      total,
      page,
      limit,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    };

    return { data: exams, meta };
  }

  /**
   * Get exam submissions for grading
   */
  async getSubmissions(
    examId: string,
    teacherId: string,
    page: number = 1,
    limit: number = 20,
  ): Promise<PaginatedResponse<ExamSubmission>> {
    // Verify exam ownership
    const exam = await this.validateTeacherOwnership(examId, teacherId);

    // Get total count
    const total = await this.attemptsRepository.count({
      where: { exam_id: examId },
    });

    // Get attempts with pagination
    const skip = (page - 1) * limit;
    const attempts = await this.attemptsRepository.find({
      where: { exam_id: examId },
      relations: ['student'],
      order: { submitted_at: 'DESC' },
      skip,
      take: limit,
    });

    // Map to response format
    const submissions: ExamSubmission[] = attempts.map((attempt) => ({
      student: {
        id: attempt.student.id,
        name: attempt.student.name,
        email: attempt.student.email,
      },
      score_mcq: Number(attempt.score_mcq) || 0,
      score_essay:
        attempt.score_essay !== null ? Number(attempt.score_essay) : null,
      total_score:
        attempt.total_score !== null ? Number(attempt.total_score) : null,
      status: attempt.status,
      essay_answers: attempt.answers
        .filter((_, i) => exam.questions[i]?.type === QuestionType.ESSAY)
        .map((ans: Answer) => {
          const q = exam.questions[ans.question_index];
          return {
            question_index: ans.question_index,
            question: q?.question ?? '',
            question_ar: q?.question_ar ?? '',
            answer: ans.answer,
            marks: q?.marks ?? 0,
            score: ans.score !== undefined ? ans.score : null,
            feedback: ans.feedback || null,
          };
        }),
      submitted_at: attempt.submitted_at!,
    }));

    // Calculate pagination meta
    const totalPages = Math.ceil(total / limit);
    const meta: PaginationMeta = {
      total,
      page,
      limit,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    };

    return { data: submissions, meta };
  }

  /**
   * Grade an essay question
   * CRITICAL: Recalculates total score and updates status when all essays are graded
   */
  async gradeEssay(
    teacherId: string,
    examId: string,
    dto: GradeEssayDto,
  ): Promise<{
    message: string;
    all_graded: boolean;
    total_score: number | null;
  }> {
    // 1. Validate exam ownership
    const exam = await this.validateTeacherOwnership(examId, teacherId);

    // 2. Validate question is essay type
    const question = exam.questions[dto.question_index];
    if (!question) {
      throw new BadRequestException(
        `Invalid question index: ${dto.question_index}`,
      );
    }
    if (question.type !== QuestionType.ESSAY) {
      throw new BadRequestException(
        `Question ${dto.question_index} is not an essay question`,
      );
    }

    // 3. Validate score <= max marks
    if (dto.score > question.marks) {
      throw new BadRequestException(
        `Score (${dto.score}) exceeds maximum marks (${question.marks}) for this question`,
      );
    }

    // 4. Find student's attempt
    const attempt = await this.attemptsRepository.findOne({
      where: { exam_id: examId, student_id: dto.student_id },
    });

    if (!attempt) {
      throw new NotFoundException(
        `Student ${dto.student_id} has not submitted this exam`,
      );
    }

    // 5. Update answer with score and feedback
    const updatedAnswers: Answer[] = attempt.answers.map((ans: Answer) => {
      if (ans.question_index === dto.question_index) {
        return {
          ...ans,
          score: dto.score,
          feedback: dto.feedback || null,
        };
      }
      return ans;
    });

    // 6. Recalculate score_essay
    let scoreEssay = 0;
    for (const ans of updatedAnswers) {
      const q = exam.questions[ans.question_index];
      if (
        q?.type === QuestionType.ESSAY &&
        ans.score !== null &&
        ans.score !== undefined
      ) {
        scoreEssay += ans.score;
      }
    }

    // 7. Check if all essays are graded
    const allEssaysGraded = updatedAnswers.every((ans: Answer) => {
      const q = exam.questions[ans.question_index];
      return (
        q?.type === QuestionType.MCQ ||
        (ans.score !== null && ans.score !== undefined)
      );
    });

    // 8. Update status and total
    const status = allEssaysGraded
      ? ExamStatus.GRADED
      : ExamStatus.PENDING_GRADING;
    const totalScore = allEssaysGraded
      ? (Number(attempt.score_mcq) || 0) + scoreEssay
      : null;
    const gradedAt = allEssaysGraded ? new Date() : attempt.graded_at;

    // 9. Save
    attempt.answers = updatedAnswers;
    attempt.score_essay = scoreEssay;
    attempt.total_score = totalScore;
    attempt.status = status;
    attempt.graded_at = gradedAt;

    await this.attemptsRepository.save(attempt);

    return {
      message: allEssaysGraded
        ? 'Essay graded. All questions are now graded.'
        : 'Essay graded successfully.',
      all_graded: allEssaysGraded,
      total_score: totalScore,
    };
  }

  /**
   * Update an exam
   * Only allowed if no submissions exist
   */
  async update(
    examId: string,
    teacherId: string,
    dto: UpdateExamDto,
  ): Promise<ExamWithDetails> {
    const exam = await this.validateTeacherOwnership(examId, teacherId);

    // Check if there are any submissions
    const submissionCount = await this.attemptsRepository.count({
      where: { exam_id: examId },
    });

    if (submissionCount > 0) {
      throw new BadRequestException(
        `Cannot update exam with existing submissions (${submissionCount} found). Create a new exam instead.`,
      );
    }

    // If questions are being updated, recalculate total marks
    if (dto.questions) {
      const questions: Question[] = [];
      let totalMarks = 0;

      for (let i = 0; i < dto.questions.length; i++) {
        const q = dto.questions[i];
        if (!q) continue; // TypeScript guard

        // Validate MCQ/Essay (same as create)
        if (q.type === QuestionType.MCQ) {
          if (!q.choices || q.choices.length < 2) {
            throw new BadRequestException(
              `Question ${i + 1}: MCQ must have at least 2 choices`,
            );
          }
          if (!q.correct_answer || !q.choices.includes(q.correct_answer)) {
            throw new BadRequestException(
              `Question ${i + 1}: Correct answer must be in choices`,
            );
          }
        }

        questions.push({
          type: q.type,
          question: q.question,
          question_ar: q.question_ar,
          choices: q.type === QuestionType.MCQ ? q.choices : undefined,
          correct_answer:
            q.type === QuestionType.MCQ ? q.correct_answer : undefined,
          marks: q.marks,
        });

        totalMarks += q.marks;
      }

      exam.questions = questions;
      exam.total_marks = totalMarks;

      // Validate passing marks against new total
      const passingMarks = dto.passing_marks ?? exam.passing_marks;
      if (passingMarks > totalMarks) {
        throw new BadRequestException(
          `Passing marks (${passingMarks}) cannot exceed total marks (${totalMarks})`,
        );
      }
    }

    // Update fields
    if (dto.title !== undefined) exam.title = dto.title;
    if (dto.title_ar !== undefined) exam.title_ar = dto.title_ar;
    if (dto.description !== undefined) exam.description = dto.description;
    if (dto.description_ar !== undefined)
      exam.description_ar = dto.description_ar;
    if (dto.subject_id !== undefined) exam.subject_id = dto.subject_id;
    if (dto.duration !== undefined) exam.duration = dto.duration;
    if (dto.passing_marks !== undefined) exam.passing_marks = dto.passing_marks;

    const savedExam = await this.examsRepository.save(exam);

    // Reload with relations
    const fullExam = await this.examsRepository.findOne({
      where: { id: savedExam.id },
      relations: ['teacher', 'subject'],
    });

    return this.mapToExamWithDetails(fullExam!);
  }

  /**
   * Delete an exam (soft delete)
   */
  async delete(examId: string, teacherId: string): Promise<void> {
    await this.validateTeacherOwnership(examId, teacherId);
    await this.examsRepository.softDelete(examId);
  }

  // ==================== STUDENT METHODS ====================

  /**
   * Find available exams for a student
   * Returns active exams that the student has not attempted
   */
  async findAvailableExams(
    studentId: string,
    filter: StudentExamFilterDto,
  ): Promise<PaginatedResponse<ExamWithDetails>> {
    const {
      search,
      subject_id,
      attempted,
      sort_by,
      sort_order,
      page = 1,
      limit = 20,
    } = filter;

    const queryBuilder = this.examsRepository
      .createQueryBuilder('exam')
      .leftJoinAndSelect('exam.teacher', 'teacher')
      .leftJoinAndSelect('exam.subject', 'subject')
      .leftJoin('exam.attempts', 'attempt', 'attempt.student_id = :studentId', {
        studentId,
      })
      .where('exam.deleted_at IS NULL')
      .andWhere('exam.is_active = true');

    // Filter by attempted/not attempted
    if (attempted === false) {
      queryBuilder.andWhere('attempt.id IS NULL');
    } else if (attempted === true) {
      queryBuilder.andWhere('attempt.id IS NOT NULL');
    }

    // Search
    if (search) {
      queryBuilder.andWhere(
        `(exam.title ILIKE :search OR exam.title_ar ILIKE :search)`,
        { search: `%${search}%` },
      );
    }

    // Filter by subject
    if (subject_id) {
      queryBuilder.andWhere('exam.subject_id = :subject_id', { subject_id });
    }

    // Sorting
    const sortColumn = `exam.${sort_by || 'created_at'}`;
    queryBuilder.orderBy(sortColumn, sort_order || 'DESC');

    // Get total count
    const total = await queryBuilder.getCount();

    // Apply pagination
    const skip = (page - 1) * limit;
    queryBuilder.skip(skip).take(limit);

    const exams = await queryBuilder.getMany();

    // Calculate pagination meta
    const totalPages = Math.ceil(total / limit);
    const meta: PaginationMeta = {
      total,
      page,
      limit,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    };

    return {
      data: exams.map((e) => this.mapToExamWithDetails(e)),
      meta,
    };
  }

  /**
   * Get exam for taking (strips correct answers)
   */
  async findOneForTaking(
    examId: string,
    studentId: string,
  ): Promise<ExamForTaking> {
    const exam = await this.examsRepository.findOne({
      where: { id: examId, is_active: true, deleted_at: IsNull() },
    });

    if (!exam) {
      throw new NotFoundException(
        `Exam with ID ${examId} not found or inactive`,
      );
    }

    // Check if student already submitted
    const existing = await this.attemptsRepository.findOne({
      where: { exam_id: examId, student_id: studentId },
    });

    if (existing) {
      throw new ConflictException('You have already submitted this exam');
    }

    return this.mapToExamForTaking(exam);
  }

  /**
   * Get exam preview (public, metadata only)
   * Does NOT expose questions or answers
   */
  async getExamPreview(examId: string): Promise<{
    id: string;
    title: string;
    title_ar: string | null;
    description: string | null;
    duration_minutes: number;
    questions_count: number;
    mcq_count: number;
    essay_count: number;
    total_marks: number;
    passing_marks: number;
    teacher: { id: string; name: string };
    subject: { id: string; name: string; grade_level: string };
  }> {
    const exam = await this.examsRepository.findOne({
      where: { id: examId, is_active: true, deleted_at: IsNull() },
      relations: ['teacher', 'subject'],
    });

    if (!exam) {
      throw new NotFoundException('Exam not found or inactive');
    }

    const questions = exam.questions;
    const mcqCount = questions.filter(
      (q) => q.type === QuestionType.MCQ,
    ).length;
    const essayCount = questions.filter(
      (q) => q.type === QuestionType.ESSAY,
    ).length;

    return {
      id: exam.id,
      title: exam.title,
      title_ar: exam.title_ar,
      description: exam.description,
      duration_minutes: Math.floor(exam.duration / 60),
      questions_count: questions.length,
      mcq_count: mcqCount,
      essay_count: essayCount,
      total_marks: exam.total_marks,
      passing_marks: exam.passing_marks,
      teacher: {
        id: exam.teacher.id,
        name: exam.teacher.name,
      },
      subject: {
        id: exam.subject.id,
        name: exam.subject.name,
        grade_level: exam.subject.grade_level,
      },
    };
  }

  /**
   * Start an exam attempt
   * Creates IN_PROGRESS attempt and returns questions WITHOUT correct_answer
   */
  async startExam(
    studentId: string,
    examId: string,
  ): Promise<{
    attempt_id: string;
    questions: Array<{
      index: number;
      type: 'mcq' | 'essay';
      question: string;
      question_ar?: string;
      choices?: string[];
      marks: number;
    }>;
    expiration_time: Date;
    started_at: Date;
  }> {
    // Validate exam exists and is active
    const exam = await this.examsRepository.findOne({
      where: { id: examId, is_active: true, deleted_at: IsNull() },
    });

    if (!exam) {
      throw new NotFoundException('Exam not found or inactive');
    }

    // Check for existing attempts
    const existingAttempt = await this.attemptsRepository.findOne({
      where: {
        student_id: studentId,
        exam_id: examId,
        status: ExamStatus.IN_PROGRESS,
      },
    });

    // If IN_PROGRESS attempt exists, resume it
    if (existingAttempt) {
      const questions = exam.questions;
      const formattedQuestions = questions.map((q, index) => ({
        index,
        type: q.type,
        question: q.question,
        question_ar: q.question_ar,
        choices: q.type === QuestionType.MCQ ? q.choices : undefined,
        marks: q.marks,
      }));

      return {
        attempt_id: existingAttempt.id,
        questions: formattedQuestions,
        expiration_time: new Date(
          existingAttempt.created_at.getTime() + exam.duration * 1000,
        ),
        started_at: existingAttempt.created_at,
      };
    }

    // Check for already submitted/graded attempts
    const completedAttempt = await this.attemptsRepository.findOne({
      where: {
        student_id: studentId,
        exam_id: examId,
      },
    });

    if (
      completedAttempt &&
      completedAttempt.status !== ExamStatus.IN_PROGRESS
    ) {
      throw new ConflictException('You have already completed this exam');
    }

    // Create new IN_PROGRESS attempt
    const attempt = this.attemptsRepository.create({
      student_id: studentId,
      exam_id: examId,
      status: ExamStatus.IN_PROGRESS,
      submitted_at: null,
    });

    const savedAttempt = await this.attemptsRepository.save(attempt);

    // Return questions WITHOUT correct_answer
    const questions = exam.questions;
    const formattedQuestions = questions.map((q, index) => ({
      index,
      type: q.type,
      question: q.question,
      question_ar: q.question_ar,
      choices: q.type === QuestionType.MCQ ? q.choices : undefined,
      marks: q.marks,
    }));

    return {
      attempt_id: savedAttempt.id,
      questions: formattedQuestions,
      expiration_time: new Date(
        savedAttempt.created_at.getTime() + exam.duration * 1000,
      ),
      started_at: savedAttempt.created_at,
    };
  }

  /**
   * Submit exam answers
   * CRITICAL: Auto-grades MCQ questions immediately
   */
  async submitExam(
    studentId: string,
    dto: SubmitExamDto,
  ): Promise<SubmissionResult> {
    // 1. Validate exam exists and is active
    const exam = await this.examsRepository.findOne({
      where: { id: dto.exam_id, is_active: true, deleted_at: IsNull() },
    });

    if (!exam) {
      throw new NotFoundException('Exam not found or inactive');
    }

    // 2. Validate IN_PROGRESS attempt exists
    const existingAttempt = await this.attemptsRepository.findOne({
      where: { exam_id: dto.exam_id, student_id: studentId },
    });

    if (!existingAttempt) {
      throw new BadRequestException(
        'No exam attempt found. Please start the exam first using POST /student/exams/:id/start',
      );
    }

    if (existingAttempt.status !== ExamStatus.IN_PROGRESS) {
      throw new ConflictException(
        `Exam attempt already ${existingAttempt.status.toLowerCase()}. Cannot submit again.`,
      );
    }

    // 3. Validate answer count
    if (dto.answers.length !== exam.questions.length) {
      throw new BadRequestException(
        `Expected ${exam.questions.length} answers, got ${dto.answers.length}`,
      );
    }

    // 4. Validate question indices
    const sortedAnswers = [...dto.answers].sort(
      (a, b) => a.question_index - b.question_index,
    );
    for (let i = 0; i < sortedAnswers.length; i++) {
      const ans = sortedAnswers[i];
      if (!ans || ans.question_index !== i) {
        throw new BadRequestException(
          `Missing or invalid question index. Expected sequential indices 0 to ${exam.questions.length - 1}`,
        );
      }
    }

    // 5. AUTO-GRADE MCQ questions
    let scoreMcq = 0;
    let essayCount = 0;
    let mcqCount = 0;

    const gradedAnswers: Answer[] = dto.answers.map((studentAnswer) => {
      const question = exam.questions[studentAnswer.question_index];

      const answer: Answer = {
        question_index: studentAnswer.question_index,
        answer: studentAnswer.answer,
      };

      // question is guaranteed to exist due to validation above, but TypeScript needs a guard
      if (!question) {
        return answer;
      }

      if (question.type === QuestionType.MCQ) {
        // Auto-grade MCQ
        mcqCount++;
        const isCorrect = studentAnswer.answer === question.correct_answer;
        answer.is_correct = isCorrect;
        answer.score = isCorrect ? question.marks : 0;
        scoreMcq += answer.score;
      } else {
        // Essay - will be graded manually
        essayCount++;
        answer.score = null;
        answer.feedback = null;
      }

      return answer;
    });

    // 6. Determine status
    const status =
      essayCount > 0 ? ExamStatus.PENDING_GRADING : ExamStatus.GRADED;
    const totalScore = essayCount === 0 ? scoreMcq : null;
    const gradedAt = essayCount === 0 ? new Date() : null;
    const submittedAt = new Date();

    // 7. Update existing IN_PROGRESS attempt
    existingAttempt.answers = gradedAnswers;
    existingAttempt.score_mcq = scoreMcq;
    existingAttempt.score_essay = essayCount > 0 ? null : 0;
    existingAttempt.total_score = totalScore;
    existingAttempt.status = status;
    existingAttempt.submitted_at = submittedAt;
    existingAttempt.graded_at = gradedAt;

    const savedAttempt = await this.attemptsRepository.save(existingAttempt);

    return {
      message: 'Exam submitted successfully',
      attempt_id: savedAttempt.id,
      score_mcq: scoreMcq,
      essay_pending: essayCount > 0,
      total_mcq_questions: mcqCount,
      total_essay_questions: essayCount,
      status,
      submitted_at: submittedAt,
    };
  }

  /**
   * Get exam result (only if fully graded)
   */
  async getExamResult(studentId: string, examId: string): Promise<ExamResult> {
    const attempt = await this.attemptsRepository.findOne({
      where: { exam_id: examId, student_id: studentId },
      relations: ['exam'],
    });

    if (!attempt) {
      throw new NotFoundException('You have not submitted this exam');
    }

    if (attempt.status !== ExamStatus.GRADED) {
      throw new BadRequestException(
        'Results are not available yet. Some questions are still being graded.',
      );
    }

    const exam = attempt.exam;
    const totalScore = Number(attempt.total_score) || 0;
    const percentage = (totalScore / exam.total_marks) * 100;
    const passed = totalScore >= exam.passing_marks;

    // Build detailed results
    const answers = attempt.answers.map((ans: Answer) => {
      const question = exam.questions[ans.question_index];
      return {
        question_index: ans.question_index,
        type: question?.type ?? QuestionType.MCQ,
        question: question?.question ?? '',
        question_ar: question?.question_ar ?? '',
        your_answer: ans.answer,
        correct_answer:
          question?.type === QuestionType.MCQ
            ? question.correct_answer
            : undefined,
        is_correct: ans.is_correct,
        score: Number(ans.score) || 0,
        max_marks: question?.marks ?? 0,
        feedback: ans.feedback,
      };
    });

    return {
      exam_id: examId,
      exam_title: exam.title,
      exam_title_ar: exam.title_ar,
      score_mcq: Number(attempt.score_mcq) || 0,
      score_essay:
        attempt.score_essay !== null ? Number(attempt.score_essay) : null,
      total_score: totalScore,
      max_score: exam.total_marks,
      percentage: Math.round(percentage * 100) / 100,
      passed,
      answers,
      submitted_at: attempt.submitted_at!,
      graded_at: attempt.graded_at!,
    };
  }

  // ==================== ADMIN METHODS ====================

  /**
   * Find all exams (admin view)
   */
  async findAll(
    filter: ExamFilterDto,
  ): Promise<PaginatedResponse<ExamWithDetails>> {
    const {
      search,
      subject_id,
      is_active,
      sort_by,
      sort_order,
      page = 1,
      limit = 20,
    } = filter;

    const queryBuilder = this.examsRepository
      .createQueryBuilder('exam')
      .leftJoinAndSelect('exam.teacher', 'teacher')
      .leftJoinAndSelect('exam.subject', 'subject')
      .where('exam.deleted_at IS NULL');

    if (search) {
      queryBuilder.andWhere(
        `(exam.title ILIKE :search OR exam.title_ar ILIKE :search)`,
        { search: `%${search}%` },
      );
    }

    if (subject_id) {
      queryBuilder.andWhere('exam.subject_id = :subject_id', { subject_id });
    }

    if (is_active !== undefined) {
      queryBuilder.andWhere('exam.is_active = :is_active', { is_active });
    }

    // Sorting
    const sortColumn = `exam.${sort_by || 'created_at'}`;
    queryBuilder.orderBy(sortColumn, sort_order || 'DESC');

    // Get total count
    const total = await queryBuilder.getCount();

    // Apply pagination
    const skip = (page - 1) * limit;
    queryBuilder.skip(skip).take(limit);

    const exams = await queryBuilder.getMany();

    // Calculate pagination meta
    const totalPages = Math.ceil(total / limit);
    const meta: PaginationMeta = {
      total,
      page,
      limit,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    };

    return {
      data: exams.map((e) => this.mapToExamWithDetails(e)),
      meta,
    };
  }

  /**
   * Find a single exam by ID
   */
  async findOne(examId: string): Promise<ExamWithDetails> {
    const exam = await this.examsRepository.findOne({
      where: { id: examId },
      relations: ['teacher', 'subject'],
    });

    if (!exam) {
      throw new NotFoundException(`Exam with ID ${examId} not found`);
    }

    return this.mapToExamWithDetails(exam);
  }

  // ==================== HELPER METHODS ====================

  /**
   * Validate teacher owns the exam
   */
  private async validateTeacherOwnership(
    examId: string,
    teacherId: string,
  ): Promise<Exam> {
    const exam = await this.examsRepository.findOne({
      where: { id: examId, deleted_at: IsNull() },
    });

    if (!exam) {
      throw new NotFoundException(`Exam with ID ${examId} not found`);
    }

    if (exam.teacher_id !== teacherId) {
      throw new ForbiddenException('You can only manage your own exams');
    }

    return exam;
  }

  /**
   * Map exam entity to response format
   */
  private mapToExamWithDetails(exam: Exam): ExamWithDetails {
    return {
      id: exam.id,
      title: exam.title,
      title_ar: exam.title_ar,
      description: exam.description,
      description_ar: exam.description_ar,
      teacher: {
        id: exam.teacher.id,
        name: exam.teacher.name,
        email: exam.teacher.email,
      },
      subject: {
        id: exam.subject.id,
        name: exam.subject.name,
        grade_level: exam.subject.grade_level,
      },
      questions_count: exam.questions.length,
      total_marks: exam.total_marks,
      passing_marks: exam.passing_marks,
      duration: exam.duration,
      is_active: exam.is_active,
      created_at: exam.created_at,
      updated_at: exam.updated_at,
    };
  }

  /**
   * Map exam to format for taking (strips correct answers)
   */
  private mapToExamForTaking(exam: Exam): ExamForTaking {
    return {
      id: exam.id,
      title: exam.title,
      title_ar: exam.title_ar,
      description: exam.description,
      description_ar: exam.description_ar,
      total_marks: exam.total_marks,
      duration: exam.duration,
      questions: exam.questions.map((q, index) => ({
        index,
        type: q.type,
        question: q.question,
        question_ar: q.question_ar,
        choices: q.type === QuestionType.MCQ ? q.choices : undefined,
        marks: q.marks,
        // CRITICAL: correct_answer is NOT included
      })),
    };
  }
}
