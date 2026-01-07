/* eslint-disable @typescript-eslint/unbound-method */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ExamsService } from './exams.service';
import { Exam, ExamAttempt, ExamStatus, QuestionType } from './entities';
import { User } from '../users/entities/user.entity';
import { Subject } from '../subjects/entities/subject.entity';
import { UserRole } from '../users/entities/user-role.enum';
import {
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';

describe('ExamsService', () => {
  let service: ExamsService;
  let examRepository: jest.Mocked<Repository<Exam>>;
  let attemptRepository: jest.Mocked<Repository<ExamAttempt>>;
  let userRepository: jest.Mocked<Repository<User>>;
  let subjectRepository: jest.Mocked<Repository<Subject>>;

  const mockTeacher: Partial<User> = {
    id: 1,
    username: 'teacher1',
    first_name: 'Test',
    last_name: 'Teacher',
    role: UserRole.TEACHER,
  };

  const mockStudent: Partial<User> = {
    id: 2,
    username: 'student1',
    first_name: 'Test',
    last_name: 'Student',
    role: UserRole.STUDENT,
  };

  const mockSubject: Partial<Subject> = {
    id: 1,
    title: 'Mathematics',
    title_ar: 'الرياضيات',
  };

  const mockExam: Partial<Exam> = {
    id: 1,
    title: 'Math Test',
    title_ar: 'اختبار الرياضيات',
    teacher_id: 1,
    subject_id: 1,
    total_marks: 100,
    passing_marks: 60,
    duration: 60,
    is_active: true,
    questions: [
      {
        type: QuestionType.MCQ,
        question: 'What is 2+2?',
        question_ar: 'ما هو 2+2؟',
        choices: ['3', '4', '5', '6'],
        correct_answer: '4',
        marks: 10,
      },
      {
        type: QuestionType.ESSAY,
        question: 'Explain multiplication',
        question_ar: 'اشرح الضرب',
        marks: 20,
      },
    ],
    teacher: mockTeacher as User,
    subject: mockSubject as Subject,
    created_at: new Date(),
    updated_at: new Date(),
  };

  const mockQueryBuilder = {
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    innerJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
    getCount: jest.fn().mockResolvedValue(0),
    getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    getOne: jest.fn().mockResolvedValue(null),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExamsService,
        {
          provide: getRepositoryToken(Exam),
          useValue: {
            create: jest.fn(),
            save: jest.fn(),
            findOne: jest.fn(),
            softDelete: jest.fn(),
            createQueryBuilder: jest.fn(() => mockQueryBuilder),
          },
        },
        {
          provide: getRepositoryToken(ExamAttempt),
          useValue: {
            create: jest.fn(),
            save: jest.fn(),
            findOne: jest.fn(),
            find: jest.fn(),
            count: jest.fn(),
            createQueryBuilder: jest.fn(() => mockQueryBuilder),
          },
        },
        {
          provide: getRepositoryToken(User),
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Subject),
          useValue: {
            findOne: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<ExamsService>(ExamsService);
    examRepository = module.get(getRepositoryToken(Exam));
    attemptRepository = module.get(getRepositoryToken(ExamAttempt));
    userRepository = module.get(getRepositoryToken(User));
    subjectRepository = module.get(getRepositoryToken(Subject));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    const createDto = {
      title: 'Math Test',
      title_ar: 'اختبار الرياضيات',
      subject_id: 1,
      passing_marks: 6,
      duration: 60,
      questions: [
        {
          type: QuestionType.MCQ,
          question: 'What is 2+2?',
          question_ar: 'ما هو 2+2؟',
          choices: ['3', '4', '5', '6'],
          correct_answer: '4',
          marks: 10,
        },
      ],
    };

    it('should create an exam successfully', async () => {
      userRepository.findOne.mockResolvedValue(mockTeacher as User);
      subjectRepository.findOne.mockResolvedValue(mockSubject as Subject);
      examRepository.create.mockReturnValue(mockExam as Exam);
      examRepository.save.mockResolvedValue(mockExam as Exam);
      examRepository.findOne.mockResolvedValue(mockExam as Exam);

      const result = await service.create(1, createDto);

      expect(result).toBeDefined();
      expect(userRepository.findOne).toHaveBeenCalledWith({ where: { id: 1 } });
      expect(subjectRepository.findOne).toHaveBeenCalled();
      expect(examRepository.save).toHaveBeenCalled();
    });

    it('should throw NotFoundException if teacher not found', async () => {
      userRepository.findOne.mockResolvedValue(null);

      await expect(service.create(999, createDto)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw BadRequestException if user is not a teacher', async () => {
      userRepository.findOne.mockResolvedValue(mockStudent as User);

      await expect(service.create(2, createDto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw NotFoundException if subject not found', async () => {
      userRepository.findOne.mockResolvedValue(mockTeacher as User);
      subjectRepository.findOne.mockResolvedValue(null);

      await expect(service.create(1, createDto)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw BadRequestException for MCQ without choices', async () => {
      userRepository.findOne.mockResolvedValue(mockTeacher as User);
      subjectRepository.findOne.mockResolvedValue(mockSubject as Subject);

      const invalidDto = {
        ...createDto,
        questions: [
          {
            type: QuestionType.MCQ,
            question: 'Question?',
            question_ar: 'سؤال؟',
            marks: 10,
          },
        ],
      };

      await expect(service.create(1, invalidDto)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('findOne', () => {
    it('should return an exam when found', async () => {
      examRepository.findOne.mockResolvedValue(mockExam as Exam);

      const result = await service.findOne(1);

      expect(result).toBeDefined();
      expect(result.id).toBe(1);
    });

    it('should throw NotFoundException when exam not found', async () => {
      examRepository.findOne.mockResolvedValue(null);

      await expect(service.findOne(999)).rejects.toThrow(NotFoundException);
    });
  });

  describe('submitExam', () => {
    const submitDto = {
      exam_id: 1,
      answers: [
        { question_index: 0, answer: '4' },
        { question_index: 1, answer: 'Multiplication is...' },
      ],
    };

    const mockAttempt: Partial<ExamAttempt> = {
      id: 1,
      exam_id: 1,
      student_id: 2,
      status: ExamStatus.IN_PROGRESS,
      answers: [],
    };

    it('should submit exam and auto-grade MCQ', async () => {
      examRepository.findOne.mockResolvedValue(mockExam as Exam);
      attemptRepository.findOne.mockResolvedValue(null); // No existing attempt
      attemptRepository.create.mockReturnValue(mockAttempt as ExamAttempt);
      attemptRepository.save.mockImplementation((a) =>
        Promise.resolve({ ...a, id: 1 } as ExamAttempt),
      );

      const result = await service.submitExam(2, submitDto);

      expect(result).toBeDefined();
      expect(result.score_mcq).toBe(10); // Correct MCQ answer
      expect(result.essay_pending).toBe(true); // Has essay question
      expect(attemptRepository.save).toHaveBeenCalled();
    });

    it('should throw NotFoundException if exam not found', async () => {
      examRepository.findOne.mockResolvedValue(null);

      await expect(
        service.submitExam(2, { ...submitDto, exam_id: 999 }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ConflictException if already submitted', async () => {
      examRepository.findOne.mockResolvedValue(mockExam as Exam);
      attemptRepository.findOne.mockResolvedValue({
        ...mockAttempt,
        status: ExamStatus.SUBMITTED,
      } as ExamAttempt);

      await expect(service.submitExam(2, submitDto)).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('gradeEssay', () => {
    const gradeDto = {
      student_id: 2,
      question_index: 1,
      score: 18,
      feedback: 'Good explanation',
    };

    const mockAttemptWithAnswers: Partial<ExamAttempt> = {
      id: 1,
      exam_id: 1,
      exam: mockExam as Exam,
      student_id: 2,
      status: ExamStatus.PENDING_GRADING,
      answers: [
        { question_index: 0, answer: '4', is_correct: true, score: 10 },
        { question_index: 1, answer: 'Multiplication is...', score: null },
      ],
      score_mcq: 10,
      score_essay: 0,
      total_score: 10,
    };

    it('should grade essay question successfully', async () => {
      examRepository.findOne.mockResolvedValue(mockExam as Exam);
      attemptRepository.findOne.mockResolvedValue(
        mockAttemptWithAnswers as ExamAttempt,
      );
      attemptRepository.save.mockImplementation((a) =>
        Promise.resolve(a as ExamAttempt),
      );

      const result = await service.gradeEssay(1, 1, gradeDto);

      expect(result).toBeDefined();
      expect(attemptRepository.save).toHaveBeenCalled();
    });

    it('should throw NotFoundException if attempt not found', async () => {
      examRepository.findOne.mockResolvedValue(mockExam as Exam);
      attemptRepository.findOne.mockResolvedValue(null);

      await expect(service.gradeEssay(1, 1, gradeDto)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw ForbiddenException if not exam owner', async () => {
      examRepository.findOne.mockResolvedValue({
        ...mockExam,
        teacher_id: 99,
      } as Exam);

      await expect(service.gradeEssay(1, 1, gradeDto)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('update', () => {
    const updateDto = {
      title: 'Updated Math Test',
    };

    it('should update exam successfully', async () => {
      examRepository.findOne.mockResolvedValue(mockExam as Exam);
      attemptRepository.count.mockResolvedValue(0); // No submissions
      examRepository.save.mockImplementation((e) => Promise.resolve(e as Exam));

      const result = await service.update(1, 1, updateDto);

      expect(result).toBeDefined();
      expect(examRepository.save).toHaveBeenCalled();
    });

    it('should throw ForbiddenException if not owner', async () => {
      examRepository.findOne.mockResolvedValue(mockExam as Exam);

      await expect(service.update(1, 99, updateDto)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('delete', () => {
    it('should soft delete exam successfully', async () => {
      examRepository.findOne.mockResolvedValue(mockExam as Exam);
      examRepository.softDelete.mockResolvedValue({ affected: 1 } as never);

      await service.delete(1, 1);

      expect(examRepository.softDelete).toHaveBeenCalledWith(1);
    });

    it('should throw ForbiddenException if not owner', async () => {
      examRepository.findOne.mockResolvedValue(mockExam as Exam);

      await expect(service.delete(1, 99)).rejects.toThrow(ForbiddenException);
    });
  });
});
