import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';
import type { EntityManager, Repository } from 'typeorm';

import { GuardianRelationship } from '../guardians/entities';
import { GuardiansService } from '../guardians/guardians.service';
import { MailService } from '../mail/mail.service';
import { StudentProfile } from '../students/entities/student-profile.entity';
import { TeacherProfile } from '../teachers/entities/teacher-profile.entity';
import { User } from '../users/entities/user.entity';
import { UserSession } from '../users/entities/user-session.entity';
import { UserRole } from '../users/entities/user-role.enum';
import { UserStatus } from '../users/entities/user-status.enum';
import { SessionsService } from '../users/sessions.service';
import { AuthService } from './auth.service';
import type { LoginDto } from './dto/login.dto';
import type { RegisterDto } from './dto/register.dto';

// bcryptjs 3.x ships an ESM-style export map; under ts-jest's __importStar
// interop the namespace object is non-configurable, so `jest.spyOn(bcrypt, …)`
// throws "Cannot redefine property". Mock the module explicitly instead — the
// service only uses hash + compare.
jest.mock('bcryptjs', () => ({
  hash: jest.fn(),
  compare: jest.fn(),
  genSalt: jest.fn(),
}));

/**
 * The one and only body `register` may ever return — see the
 * "register (user enumeration)" suite. `message_ar` is stripped from the
 * outgoing JSON by ResponseLocalizationInterceptor, which picks one of the
 * two strings; the *pair* is what the service produces.
 */
const PENDING_ACKNOWLEDGEMENT = {
  message: 'Registration request received. Pending approval',
  message_ar: 'تم استلام طلب التسجيل. بانتظار الموافقة',
};

/**
 * A Postgres `unique_violation` shaped the way TypeORM surfaces one: the
 * driver error nested under `driverError`, with `code`/`detail` also copied
 * onto the wrapping QueryFailedError.
 */
function uniqueViolation(detail: string, options: { nestedOnly?: boolean } = {}): Error {
  const message = 'duplicate key value violates unique constraint';
  const driverError = Object.assign(new Error(message), { code: '23505', detail });
  const wrapper = Object.assign(new Error(message), { driverError });
  return options.nestedOnly === true ? wrapper : Object.assign(wrapper, { code: '23505', detail });
}

interface LoginResponse {
  status: string;
  token?: string;
  refreshToken?: string;
  role?: string;
  userId?: string;
  message?: string;
}

describe('AuthService', () => {
  let service: AuthService;
  let guardiansService: jest.Mocked<Pick<GuardiansService, 'linkGuardianWith'>>;
  let userRepository: jest.Mocked<Repository<User>>;
  let jwtService: jest.Mocked<JwtService>;
  let configService: jest.Mocked<ConfigService>;
  let sessionsService: jest.Mocked<SessionsService>;
  let eventEmitter: jest.Mocked<Pick<EventEmitter2, 'emit'>>;
  let dataSourceMock: { transaction: jest.Mock; getRepository: jest.Mock };

  const mockUser: Partial<User> = {
    id: 'stu_123456',
    name: 'Test User',
    email: 'test@example.com',
    phone: '01000000000',
    password_hash: 'hashedpassword',
    is_active: true,
    role: UserRole.STUDENT,
    status: UserStatus.APPROVED,
  };

  // Stand-in for the transactional EntityManager passed into
  // `dataSource.transaction(cb)`. `create` just echoes the given data (as the
  // real TypeORM `create` does — no DB round trip); `save` resolves with the
  // data, stamping an id onto the User row the way a real INSERT would.
  const mockManager = {
    create: jest.fn((_entity: unknown, data: unknown) => data),
    save: jest.fn((entity: unknown, data: Record<string, unknown>) => {
      if (entity === User) {
        return Promise.resolve({ id: 'stu_789012', ...data });
      }
      return Promise.resolve(data);
    }),
  };

  beforeEach(async () => {
    const mockUserRepository = {
      findOne: jest.fn(),
      findOneBy: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      update: jest.fn(),
      createQueryBuilder: jest.fn(),
    };
    mockUserRepository.findOneBy.mockImplementation(async () => {
      const userQuery = mockUserRepository.createQueryBuilder();
      return userQuery ? userQuery.getOne() : null;
    });

    const mockJwtService = {
      sign: jest.fn(),
    };

    const mockConfigService = {
      get: jest.fn(),
    };

    const sessionRepository = {
      createQueryBuilder: jest.fn(() => ({
        addSelect: jest.fn().mockReturnThis(),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        setLock: jest.fn().mockReturnThis(),
        getOne: jest.fn(async () => {
          const userQuery = mockUserRepository.createQueryBuilder();
          if (!userQuery) return null;
          const user = await userQuery.getOne();
          if (!user) return null;
          const legacyFixture = user as User & {
            refresh_token?: string;
            refresh_token_expires_at?: Date;
          };
          return Object.assign(new UserSession(), {
            id: 'session-1',
            user_id: user.id,
            user,
            refresh_token_hash: legacyFixture.refresh_token,
            expires_at: legacyFixture.refresh_token_expires_at,
          });
        }),
      })),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    const mockDataSource = {
      getRepository: jest.fn(() => sessionRepository),
      transaction: jest.fn((cb: (manager: EntityManager) => Promise<unknown>) =>
        cb({
          ...mockManager,
          getRepository: jest.fn((entity: unknown) =>
            entity === User ? mockUserRepository : sessionRepository,
          ),
        } as unknown as EntityManager),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: getRepositoryToken(User),
          useValue: mockUserRepository,
        },
        {
          provide: JwtService,
          useValue: mockJwtService,
        },
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
        {
          provide: SessionsService,
          useValue: {
            createSession: jest.fn().mockResolvedValue({ id: 'session-1' }),
            updateSessionTokenId: jest.fn(),
            deleteSessionByTokenId: jest.fn(),
            deleteSessionById: jest.fn(),
            deleteAllUserSessions: jest.fn(),
            getActiveSession: jest.fn(async (_userId: string, sessionId: string) => {
              const user = await mockUserRepository.findOne({ where: { id: _userId } });
              return user
                ? Object.assign(new UserSession(), { id: sessionId, user_id: user.id, user })
                : null;
            }),
          },
        },
        {
          provide: GuardiansService,
          useValue: {
            linkGuardianWith: jest.fn(),
          },
        },
        {
          provide: MailService,
          useValue: {
            sendPasswordResetEmail: jest.fn().mockResolvedValue(true),
            isConfigured: jest.fn().mockReturnValue(false),
          },
        },
        {
          provide: DataSource,
          useValue: mockDataSource,
        },
        {
          provide: EventEmitter2,
          useValue: { emit: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    guardiansService = module.get(GuardiansService);
    userRepository = module.get(getRepositoryToken(User));
    jwtService = module.get(JwtService);
    configService = module.get(ConfigService);
    sessionsService = module.get(SessionsService);
    eventEmitter = module.get(EventEmitter2);
    dataSourceMock = module.get(DataSource);

    configService.get.mockImplementation((key: string) => {
      if (key === 'BCRYPT_ROUNDS') {
        return 12;
      }
      if (key === 'JWT_REFRESH_EXPIRATION') {
        return '7d';
      }
      return undefined;
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('register', () => {
    const studentRegisterDto: RegisterDto = {
      name: 'Ahmed Ali',
      password: '123456',
      phone: '01000000000',
      email: 'test@test.com',
      requestedRole: UserRole.STUDENT,
      parentPhone: '01011111111',
    };

    const teacherRegisterDto: RegisterDto = {
      name: 'Sara Mostafa',
      password: '123456',
      phone: '01000000001',
      email: 'teacher@test.com',
      requestedRole: UserRole.TEACHER,
      qualifications: 'B.Sc. Mathematics',
      yearsOfExperience: 5,
    };

    beforeEach(() => {
      (bcrypt.hash as jest.Mock).mockResolvedValue('hashed_password');
    });

    it('should successfully register a student application with pending approval', async () => {
      userRepository.findOne.mockResolvedValueOnce(null);

      const result = await service.register(studentRegisterDto);

      expect(result).toEqual(PENDING_ACKNOWLEDGEMENT);
      expect(mockManager.save).toHaveBeenCalledWith(User, expect.anything());
    });

    it('creates the user with status PENDING and the requested role, not an automatically granted one', async () => {
      userRepository.findOne.mockResolvedValueOnce(null);

      await service.register(teacherRegisterDto);

      expect(mockManager.create).toHaveBeenCalledWith(
        User,
        expect.objectContaining({ role: UserRole.TEACHER, status: UserStatus.PENDING }),
      );
    });

    it('links the supplied parent phone as a primary guardian for a student application', async () => {
      userRepository.findOne.mockResolvedValueOnce(null);

      await service.register(studentRegisterDto);

      expect(guardiansService.linkGuardianWith).toHaveBeenCalledWith(
        expect.objectContaining(mockManager),
        'stu_789012',
        {
          // Canonicalised to E.164 by `register` before the transaction opens,
          // so an unparseable number fails with a 400 rather than rolling back
          // a half-written account from inside `linkGuardianWith`.
          phone: '+201011111111',
          relationship: GuardianRelationship.OTHER,
          is_primary: true,
        },
      );
    });

    it('creates a teacher profile and no guardian for a teacher application', async () => {
      userRepository.findOne.mockResolvedValueOnce(null);

      await service.register(teacherRegisterDto);

      expect(mockManager.create).toHaveBeenCalledWith(
        TeacherProfile,
        expect.objectContaining({
          user_id: 'stu_789012',
          qualifications: teacherRegisterDto.qualifications,
          years_of_experience: teacherRegisterDto.yearsOfExperience,
        }),
      );
      expect(guardiansService.linkGuardianWith).not.toHaveBeenCalled();
    });

    it('creates a student profile and no teacher profile for a student application', async () => {
      userRepository.findOne.mockResolvedValueOnce(null);

      await service.register(studentRegisterDto);

      expect(mockManager.create).toHaveBeenCalledWith(
        StudentProfile,
        expect.objectContaining({ user_id: 'stu_789012' }),
      );
      expect(mockManager.create).not.toHaveBeenCalledWith(TeacherProfile, expect.anything());
    });

    it('notifies admins that a new instructor registration is pending approval', async () => {
      userRepository.findOne.mockResolvedValueOnce(null);

      await service.register(teacherRegisterDto);

      expect(eventEmitter.emit).toHaveBeenCalledWith('teacher.registration_pending', {
        userId: 'stu_789012',
        name: teacherRegisterDto.name,
        email: teacherRegisterDto.email.toLowerCase(),
      });
    });

    it('does not notify admins for a routine student registration', async () => {
      userRepository.findOne.mockResolvedValueOnce(null);

      await service.register(studentRegisterDto);

      expect(eventEmitter.emit).not.toHaveBeenCalledWith(
        'teacher.registration_pending',
        expect.anything(),
      );
    });

    it('does not notify admins when the registration loses a unique-constraint race', async () => {
      userRepository.findOne.mockResolvedValueOnce(null);
      mockManager.save.mockRejectedValueOnce(uniqueViolation('Key (email)=(teacher@test.com)'));

      await service.register(teacherRegisterDto);

      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  /**
   * Regression suite for the user-enumeration vulnerability: `register` used to
   * answer a known email/phone with `409 Conflict` and a new one with
   * `201 { userId }`, which let an unauthenticated caller test any identifier
   * against the whole user table. Every outcome must now be indistinguishable
   * — same status (asserted at the HTTP layer in auth.controller.spec.ts), same
   * body, same body shape, and never a `userId`.
   */
  describe('register (user enumeration)', () => {
    const studentRegisterDto: RegisterDto = {
      name: 'Ahmed Ali',
      password: 'S3curePass',
      phone: '01000000000',
      email: 'test@test.com',
      requestedRole: UserRole.STUDENT,
      parentPhone: '01011111111',
    };

    beforeEach(() => {
      (bcrypt.hash as jest.Mock).mockResolvedValue('hashed_password');
    });

    /** Run `register` against a repository that reports the identifier as taken. */
    const registerAgainstExisting = async (): Promise<unknown> => {
      userRepository.findOne.mockResolvedValueOnce(mockUser as User);
      return await service.register(studentRegisterDto);
    };

    /** Run `register` against a repository that reports the identifier as free. */
    const registerAsNew = async (): Promise<unknown> => {
      userRepository.findOne.mockResolvedValueOnce(null);
      return await service.register(studentRegisterDto);
    };

    it('returns an identical body and structure whether or not the identifier exists', async () => {
      const forNew = await registerAsNew();
      jest.clearAllMocks();
      (bcrypt.hash as jest.Mock).mockResolvedValue('hashed_password');
      const forExisting = await registerAgainstExisting();

      expect(forExisting).toEqual(forNew);
      expect(forExisting).toEqual(PENDING_ACKNOWLEDGEMENT);
      expect(Object.keys(forExisting as object).sort()).toEqual(
        Object.keys(forNew as object).sort(),
      );
    });

    it.each([
      ['a brand-new identifier', registerAsNew],
      ['an already-registered identifier', registerAgainstExisting],
    ])('never returns a userId or a conflict hint for %s', async (_case, run) => {
      const result = (await run()) as Record<string, unknown>;

      for (const leak of [
        'userId',
        'id',
        'emailExists',
        'phoneExists',
        'exists',
        'conflict',
        'reason',
        'status',
        'created',
      ]) {
        expect(result).not.toHaveProperty(leak);
      }
      expect(Object.keys(result).sort()).toEqual(['message', 'message_ar']);
    });

    it('creates nothing when the email or phone is already registered', async () => {
      await registerAgainstExisting();

      expect(mockManager.save).not.toHaveBeenCalled();
      expect(mockManager.create).not.toHaveBeenCalled();
      expect(guardiansService.linkGuardianWith).not.toHaveBeenCalled();
    });

    it('queries uniqueness with the normalized email and phone', async () => {
      userRepository.findOne.mockResolvedValueOnce(null);

      await service.register({
        ...studentRegisterDto,
        email: '  MiXeD@Test.COM  ',
        phone: '01000000000',
      });

      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: [{ email: 'mixed@test.com' }, { phone: '01000000000' }],
      });
      expect(mockManager.create).toHaveBeenCalledWith(
        User,
        expect.objectContaining({ email: 'mixed@test.com' }),
      );
    });

    it('hashes the password before the existence lookup so latency cannot leak', async () => {
      // bcrypt at 12 rounds dominates the response time. Hashing only on the
      // "new account" path would make a stopwatch as good an oracle as the 409
      // this fix removed.
      await registerAgainstExisting();

      expect(bcrypt.hash).toHaveBeenCalledTimes(1);
      const hashOrder = (bcrypt.hash as jest.Mock).mock.invocationCallOrder[0] ?? 0;
      const lookupOrder = userRepository.findOne.mock.invocationCallOrder[0] ?? 0;
      expect(hashOrder).toBeLessThan(lookupOrder);
    });

    it.each([
      ['email', 'Key (email)=(test@test.com) already exists.'],
      ['phone', 'Key (phone)=(01000000000) already exists.'],
    ])(
      'acknowledges a simultaneous request that lost the %s unique constraint',
      async (_column, detail) => {
        userRepository.findOne.mockResolvedValueOnce(null);
        mockManager.save.mockRejectedValueOnce(uniqueViolation(detail));

        await expect(service.register(studentRegisterDto)).resolves.toEqual(
          PENDING_ACKNOWLEDGEMENT,
        );
      },
    );

    it('surfaces an internal guardian uniqueness failure instead of acknowledging a rolled-back account', async () => {
      userRepository.findOne.mockResolvedValueOnce(null);
      mockManager.save.mockRejectedValueOnce(
        uniqueViolation('Key (phone_e164)=(+201011111111) already exists.'),
      );

      await expect(service.register(studentRegisterDto)).rejects.toMatchObject({ code: '23505' });
    });

    it('surfaces an unattributable uniqueness failure instead of silently dropping registration', async () => {
      userRepository.findOne.mockResolvedValueOnce(null);
      mockManager.save.mockRejectedValueOnce(
        Object.assign(new Error('duplicate key value violates unique constraint'), {
          code: '23505',
        }),
      );

      await expect(service.register(studentRegisterDto)).rejects.toMatchObject({ code: '23505' });
    });

    it('acknowledges a race reported only on the nested TypeORM driverError', async () => {
      userRepository.findOne.mockResolvedValueOnce(null);
      mockManager.save.mockRejectedValueOnce(
        uniqueViolation('Key (email)=(test@test.com) already exists.', { nestedOnly: true }),
      );

      await expect(service.register(studentRegisterDto)).resolves.toEqual(PENDING_ACKNOWLEDGEMENT);
    });

    it('retries the generated username instead of dropping a legitimate registration', async () => {
      userRepository.findOne.mockResolvedValueOnce(null);
      mockManager.save.mockRejectedValueOnce(
        uniqueViolation('Key (username)=(test_a1b2c3) already exists.'),
      );

      await expect(service.register(studentRegisterDto)).resolves.toEqual(PENDING_ACKNOWLEDGEMENT);
      // Second attempt went through: the user row was actually written.
      expect(mockManager.save).toHaveBeenCalledWith(User, expect.anything());
    });

    it('surfaces a non-uniqueness failure rather than faking an acknowledgement', async () => {
      userRepository.findOne.mockResolvedValueOnce(null);
      mockManager.save.mockRejectedValueOnce(new Error('connection terminated'));

      await expect(service.register(studentRegisterDto)).rejects.toThrow('connection terminated');
    });

    it('still rejects malformed input with a 400 — only conflicts are hidden', async () => {
      // Rejected before the uniqueness lookup, so no `findOne` stub is needed:
      // a bad phone format reveals nothing about who is registered.
      await expect(
        service.register({ ...studentRegisterDto, parentPhone: 'not-a-phone' }),
      ).rejects.toThrow(BadRequestException);
      expect(mockManager.save).not.toHaveBeenCalled();
    });
  });

  describe('login', () => {
    const loginDto: LoginDto = {
      email: 'test@example.com',
      password: 'password123',
    };

    it('should successfully login with valid credentials', async () => {
      const queryBuilder = {
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(mockUser),
      };

      jest
        .spyOn(userRepository, 'createQueryBuilder')
        .mockImplementation()
        .mockReturnValue(queryBuilder);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      jwtService.sign.mockReturnValue('access_token');

      const result = await service.login(loginDto);

      // New response format with status
      expect(result).toHaveProperty('status', 'approved');
      expect(result).toHaveProperty('accessToken', 'access_token');
      expect(result).toHaveProperty('refreshToken');
      expect(result).toHaveProperty('role', mockUser.role);
      expect(result).toHaveProperty('userId', mockUser.id);
    });

    it('should throw UnauthorizedException if user not found', async () => {
      const queryBuilder = {
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      };

      jest
        .spyOn(userRepository, 'createQueryBuilder')
        .mockImplementation()
        .mockReturnValue(queryBuilder);

      await expect(service.login(loginDto)).rejects.toThrow(
        new UnauthorizedException('Invalid credentials'),
      );
    });

    it('should throw UnauthorizedException if password is invalid', async () => {
      const queryBuilder = {
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(mockUser),
      };

      jest
        .spyOn(userRepository, 'createQueryBuilder')
        .mockImplementation()
        .mockReturnValue(queryBuilder);
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      await expect(service.login(loginDto)).rejects.toThrow(
        new UnauthorizedException('Invalid credentials'),
      );
    });

    it('should throw UnauthorizedException for Firebase-only accounts', async () => {
      const firebaseUser = {
        ...mockUser,
        password_hash: null,
      };

      const queryBuilder = {
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(firebaseUser),
      };

      jest
        .spyOn(userRepository, 'createQueryBuilder')
        .mockImplementation()
        .mockReturnValue(queryBuilder);

      const error = await service.login(loginDto).catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(UnauthorizedException);
      expect((error as UnauthorizedException).message).toContain(
        'This account uses Firebase authentication',
      );
    });

    it('should return pending status for pending users', async () => {
      const pendingUser = {
        ...mockUser,
        status: UserStatus.PENDING,
      };

      const queryBuilder = {
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(pendingUser),
      };

      jest
        .spyOn(userRepository, 'createQueryBuilder')
        .mockImplementation()
        .mockReturnValue(queryBuilder);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      const result = await service.login(loginDto);

      expect(result).toHaveProperty('status', 'pending');
      expect(result).toHaveProperty('message');
      expect(result).not.toHaveProperty('token');
    });

    it('should throw UnauthorizedException for rejected users', async () => {
      const rejectedUser = {
        ...mockUser,
        status: UserStatus.REJECTED,
        rejection_reason: 'Invalid documents',
      };

      const queryBuilder = {
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(rejectedUser),
      };

      jest
        .spyOn(userRepository, 'createQueryBuilder')
        .mockImplementation()
        .mockReturnValue(queryBuilder);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      await expect(service.login(loginDto)).rejects.toThrow(
        new UnauthorizedException('Account rejected: Invalid documents'),
      );
    });
  });

  describe('refresh', () => {
    const refreshToken = 'valid_refresh_token';
    const hashedRefreshToken = 'hashed_refresh_token';

    const userWithRefreshToken: User = Object.assign(new User(), mockUser, {
      refresh_token: hashedRefreshToken,
      refresh_token_expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    it('should successfully refresh tokens with valid refresh token', async () => {
      const queryBuilder = {
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(userWithRefreshToken),
      };

      jest
        .spyOn(userRepository, 'createQueryBuilder')
        .mockImplementation()
        .mockReturnValue(queryBuilder);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      (bcrypt.hash as jest.Mock).mockResolvedValue('new_hashed_token');
      jwtService.sign.mockReturnValue('new_access_token');

      const result = await service.refresh(refreshToken);

      // New response format with status
      expect(result).toHaveProperty('status', 'approved');
      expect(result).toHaveProperty('accessToken', 'new_access_token');
      expect(result).toHaveProperty('refreshToken');
      expect(result).toHaveProperty('role', mockUser.role);
      expect(result).toHaveProperty('userId', mockUser.id);
    });

    it('should throw UnauthorizedException for invalid refresh token', async () => {
      const queryBuilder = {
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(userWithRefreshToken),
      };

      jest
        .spyOn(userRepository, 'createQueryBuilder')
        .mockImplementation()
        .mockReturnValue(queryBuilder);
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      await expect(service.refresh('invalid_token')).rejects.toThrow(
        new UnauthorizedException('Invalid refresh token'),
      );
    });

    it('should throw UnauthorizedException for expired refresh token', async () => {
      const expiredUser: User = Object.assign(new User(), userWithRefreshToken, {
        refresh_token_expires_at: new Date(Date.now() - 1000),
      });

      const queryBuilder = {
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(expiredUser),
      };

      jest
        .spyOn(userRepository, 'createQueryBuilder')
        .mockImplementation()
        .mockReturnValue(queryBuilder);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      await expect(service.refresh(refreshToken)).rejects.toThrow(
        new UnauthorizedException('Refresh token expired'),
      );
    });

    it('should throw UnauthorizedException for inactive user', async () => {
      const inactiveUser: User = Object.assign(new User(), userWithRefreshToken, {
        is_active: false,
      });

      const queryBuilder = {
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(inactiveUser),
      };

      jest
        .spyOn(userRepository, 'createQueryBuilder')
        .mockImplementation()
        .mockReturnValue(queryBuilder);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      await expect(service.refresh(refreshToken)).rejects.toThrow(
        new UnauthorizedException('User account is inactive'),
      );
    });

    it('should implement token rotation (new refresh token on every refresh)', async () => {
      const queryBuilder = {
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(userWithRefreshToken),
      };

      jest
        .spyOn(userRepository, 'createQueryBuilder')
        .mockImplementation()
        .mockReturnValue(queryBuilder);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      (bcrypt.hash as jest.Mock).mockResolvedValue('new_hashed_token');
      jwtService.sign.mockReturnValue('new_access_token');

      const result = await service.refresh(refreshToken);

      // Updated to use new response format
      expect((result as LoginResponse).refreshToken).toBeDefined();
      expect((result as LoginResponse).refreshToken).not.toBe(refreshToken);
    });

    describe('bcrypt work stays outside the transaction (PERF-03)', () => {
      const sessionQuery = (hash: string | null, expiresAt = new Date(Date.now() + 60_000)) => ({
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        setLock: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(
          hash === null
            ? null
            : Object.assign(new UserSession(), {
                id: 'session-1',
                user_id: mockUser.id,
                refresh_token_hash: hash,
                expires_at: expiresAt,
              }),
        ),
      });

      it('verifies the token and hashes the new one before opening the transaction', async () => {
        const order: string[] = [];
        (bcrypt.compare as jest.Mock).mockImplementation(async () => {
          order.push('compare');
          return true;
        });
        (bcrypt.hash as jest.Mock).mockImplementation(async () => {
          order.push('hash');
          return 'new_hashed_token';
        });
        dataSourceMock.transaction.mockImplementationOnce(
          async (cb: (m: EntityManager) => Promise<unknown>) => {
            order.push('transaction');
            return await cb({
              getRepository: (entity: unknown) =>
                entity === User
                  ? { findOneBy: jest.fn().mockResolvedValue(mockUser) }
                  : {
                      createQueryBuilder: () => sessionQuery('stored_hash'),
                      update: jest.fn().mockResolvedValue({ affected: 1 }),
                    },
            } as unknown as EntityManager);
          },
        );
        dataSourceMock.getRepository.mockReturnValueOnce({
          createQueryBuilder: () => sessionQuery('stored_hash'),
          delete: jest.fn(),
        });
        jwtService.sign.mockReturnValue('new_access_token');

        await service.refresh(refreshToken);

        expect(order).toEqual(['compare', 'hash', 'transaction']);
      });

      it('rejects an unknown or already rotated token without any bcrypt work or transaction', async () => {
        dataSourceMock.getRepository.mockReturnValueOnce({
          createQueryBuilder: () => sessionQuery(null),
          delete: jest.fn(),
        });

        await expect(service.refresh('rotated_token')).rejects.toThrow(UnauthorizedException);

        expect(bcrypt.compare).not.toHaveBeenCalled();
        expect(bcrypt.hash).not.toHaveBeenCalled();
        expect(dataSourceMock.transaction).not.toHaveBeenCalled();
      });

      it('rejects when the session was rotated by another request between verify and lock', async () => {
        (bcrypt.compare as jest.Mock).mockResolvedValue(true);
        (bcrypt.hash as jest.Mock).mockResolvedValue('new_hashed_token');
        const update = jest.fn();
        dataSourceMock.getRepository.mockReturnValueOnce({
          createQueryBuilder: () => sessionQuery('hash_seen_by_first_read'),
          delete: jest.fn(),
        });
        dataSourceMock.transaction.mockImplementationOnce(
          async (cb: (m: EntityManager) => Promise<unknown>) =>
            await cb({
              getRepository: () => ({
                createQueryBuilder: () => sessionQuery('hash_written_by_other_request'),
                update,
              }),
            } as unknown as EntityManager),
        );

        await expect(service.refresh(refreshToken)).rejects.toThrow(UnauthorizedException);

        expect(update).not.toHaveBeenCalled();
      });

      it('rejects when the session is gone by the time the lock is taken', async () => {
        (bcrypt.compare as jest.Mock).mockResolvedValue(true);
        (bcrypt.hash as jest.Mock).mockResolvedValue('new_hashed_token');
        const update = jest.fn();
        dataSourceMock.getRepository.mockReturnValueOnce({
          createQueryBuilder: () => sessionQuery('stored_hash'),
          delete: jest.fn(),
        });
        dataSourceMock.transaction.mockImplementationOnce(
          async (cb: (m: EntityManager) => Promise<unknown>) =>
            await cb({
              getRepository: () => ({ createQueryBuilder: () => sessionQuery(null), update }),
            } as unknown as EntityManager),
        );

        await expect(service.refresh(refreshToken)).rejects.toThrow(UnauthorizedException);

        expect(update).not.toHaveBeenCalled();
      });

      it('deletes the session and rejects when the bcrypt check fails', async () => {
        (bcrypt.compare as jest.Mock).mockResolvedValue(false);
        const del = jest.fn().mockResolvedValue({ affected: 1 });
        dataSourceMock.getRepository.mockReturnValueOnce({
          createQueryBuilder: () => sessionQuery('stored_hash'),
          delete: del,
        });
        // Second getRepository call is the delete.
        dataSourceMock.getRepository.mockReturnValueOnce({ delete: del });

        await expect(service.refresh(refreshToken)).rejects.toThrow(UnauthorizedException);

        expect(del).toHaveBeenCalledWith({ id: 'session-1' });
        expect(bcrypt.hash).not.toHaveBeenCalled();
        expect(dataSourceMock.transaction).not.toHaveBeenCalled();
      });
    });

    it('should throw UnauthorizedException for pending user on refresh', async () => {
      const pendingUser: User = Object.assign(new User(), userWithRefreshToken, {
        status: UserStatus.PENDING,
      });

      const queryBuilder = {
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(pendingUser),
      };

      jest
        .spyOn(userRepository, 'createQueryBuilder')
        .mockImplementation()
        .mockReturnValue(queryBuilder);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      await expect(service.refresh(refreshToken)).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException for rejected user on refresh', async () => {
      const rejectedUser: User = Object.assign(new User(), userWithRefreshToken, {
        status: UserStatus.REJECTED,
        rejection_reason: 'Invalid documents',
      });

      const queryBuilder = {
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(rejectedUser),
      };

      jest
        .spyOn(userRepository, 'createQueryBuilder')
        .mockImplementation()
        .mockReturnValue(queryBuilder);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      await expect(service.refresh(refreshToken)).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('logout', () => {
    it('should successfully logout and clear refresh token and token_id', async () => {
      const userId = 'stu_123456';
      userRepository.update.mockResolvedValue({
        generatedMaps: [],
        raw: [],
        affected: 1,
      });

      await service.logout(userId, 'session-1');

      expect(sessionsService.deleteSessionById).toHaveBeenCalledWith(userId, 'session-1');
    });
  });

  describe('validateUser', () => {
    it('should return user data for valid active user', async () => {
      const user: User = Object.assign(new User(), mockUser);
      userRepository.findOne.mockResolvedValue(user);

      const result = await service.validateUser({
        sub: 'stu_123456',
        email: 'test@example.com',
        sid: 'session-1',
      });

      expect(result).toEqual({
        userId: mockUser.id,
        email: mockUser.email,
        name: mockUser.name,
        role: UserRole.STUDENT,
        sessionId: 'session-1',
        financePermissions: mockUser.finance_permissions ?? [],
      });
    });

    it('should return null for inactive user', async () => {
      const inactiveUser: User = Object.assign(new User(), mockUser, {
        is_active: false,
      });
      userRepository.findOne.mockResolvedValue(inactiveUser);

      const result = await service.validateUser({
        sub: 'stu_123456',
        email: 'test@example.com',
        sid: 'session-1',
      });

      expect(result).toBeNull();
    });

    it('should return null for non-existent user', async () => {
      userRepository.findOne.mockResolvedValue(null);

      const result = await service.validateUser({
        sub: 'stu_999999',
        email: 'nonexistent@example.com',
        sid: 'session-1',
      });

      expect(result).toBeNull();
    });
  });
});
