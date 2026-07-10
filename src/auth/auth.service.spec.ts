import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import * as bcrypt from 'bcryptjs';
import type { Repository } from 'typeorm';

import { GuardianRelationship } from '../guardians/entities';
import { GuardiansService } from '../guardians/guardians.service';
import { MailService } from '../mail/mail.service';
import { StudentsService } from '../students/students.service';
import { User } from '../users/entities/user.entity';
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

interface RegisterResponse {
  message: string;
  userId: string;
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
  let guardiansService: jest.Mocked<Pick<GuardiansService, 'linkGuardian'>>;
  let userRepository: jest.Mocked<Repository<User>>;
  let jwtService: jest.Mocked<JwtService>;
  let configService: jest.Mocked<ConfigService>;

  const mockUser: Partial<User> = {
    id: 'stu_123456',
    name: 'Test User',
    email: 'test@example.com',
    phone: '01000000000',
    password_hash: 'hashedpassword',
    is_active: true,
    role: UserRole.STUDENT,
  };

  beforeEach(async () => {
    const mockUserRepository = {
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      update: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    const mockJwtService = {
      sign: jest.fn(),
    };

    const mockConfigService = {
      get: jest.fn(),
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
            createSession: jest.fn(),
            updateSessionTokenId: jest.fn(),
            deleteSessionByTokenId: jest.fn(),
            deleteAllUserSessions: jest.fn(),
          },
        },
        {
          provide: StudentsService,
          useValue: {
            createStudentProfile: jest.fn(),
          },
        },
        {
          provide: GuardiansService,
          useValue: {
            linkGuardian: jest.fn(),
          },
        },
        {
          provide: MailService,
          useValue: {
            sendPasswordResetEmail: jest.fn().mockResolvedValue(true),
            isConfigured: jest.fn().mockReturnValue(false),
          },
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    guardiansService = module.get(GuardiansService);
    userRepository = module.get(getRepositoryToken(User));
    jwtService = module.get(JwtService);
    configService = module.get(ConfigService);

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
    const registerDto: RegisterDto = {
      name: 'Ahmed Ali',
      password: '123456',
      phone: '01000000000',
      email: 'test@test.com',
      parentPhone: '01011111111',
    };

    it('should successfully register a new user with pending approval', async () => {
      userRepository.findOne.mockResolvedValueOnce(null);

      const newUser: User = Object.assign(new User(), mockUser, {
        id: 'stu_789012',
        name: registerDto.name,
        email: registerDto.email,
        phone: registerDto.phone,
      });

      userRepository.create.mockReturnValue(newUser);
      userRepository.save.mockResolvedValue(newUser);
      (bcrypt.hash as jest.Mock).mockResolvedValue('hashed_password');

      const result = await service.register(registerDto);

      expect(result).toHaveProperty('message');
      expect(result).toHaveProperty('userId');
      expect((result as RegisterResponse).message).toBe(
        'Registration request received. Pending approval',
      );
      expect((result as RegisterResponse).userId).toContain('u_');
    });

    it('links the supplied parent phone as a primary guardian', async () => {
      userRepository.findOne.mockResolvedValueOnce(null);
      const newUser: User = Object.assign(new User(), mockUser, { id: 'stu_789012' });
      userRepository.create.mockReturnValue(newUser);
      userRepository.save.mockResolvedValue(newUser);
      (bcrypt.hash as jest.Mock).mockResolvedValue('hashed_password');

      await service.register(registerDto);

      expect(guardiansService.linkGuardian).toHaveBeenCalledWith('stu_789012', {
        phone: registerDto.parentPhone,
        relationship: GuardianRelationship.OTHER,
        is_primary: true,
      });
    });

    it('creates no guardian when no parent phone is supplied', async () => {
      userRepository.findOne.mockResolvedValueOnce(null);
      const newUser: User = Object.assign(new User(), mockUser, { id: 'stu_789012' });
      userRepository.create.mockReturnValue(newUser);
      userRepository.save.mockResolvedValue(newUser);
      (bcrypt.hash as jest.Mock).mockResolvedValue('hashed_password');

      // The old code wrote '' into a NOT NULL parent_phone column here.
      const { parentPhone: _omitted, ...withoutParent } = registerDto;
      await service.register(withoutParent as RegisterDto);

      expect(guardiansService.linkGuardian).not.toHaveBeenCalled();
    });

    it('should throw ConflictException if user already exists (generic message for security)', async () => {
      // Service uses generic error to prevent email/username enumeration
      userRepository.findOne.mockResolvedValue(mockUser as User);

      await expect(service.register(registerDto)).rejects.toThrow(
        new ConflictException('Registration failed. Please try different credentials.'),
      );
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
      expect(result).toHaveProperty('token', 'access_token');
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
      expect(result).toHaveProperty('token', 'new_access_token');
      expect(result).toHaveProperty('refreshToken');
      expect(result).toHaveProperty('role', mockUser.role);
      expect(result).toHaveProperty('userId', mockUser.id);
      expect(userRepository.update).toHaveBeenCalled();
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
      expect(userRepository.update).toHaveBeenCalledWith(
        mockUser.id,
        expect.objectContaining({
          refresh_token: 'new_hashed_token',
          refresh_token_id: expect.any(String) as string,
          refresh_token_expires_at: expect.any(Date) as Date,
        }),
      );
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

      await expect(service.refresh(refreshToken)).rejects.toThrow(
        new UnauthorizedException('Your account is under review. Please wait for admin approval.'),
      );
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

      await expect(service.refresh(refreshToken)).rejects.toThrow(
        new UnauthorizedException('Account rejected: Invalid documents'),
      );
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

      await service.logout(userId);

      expect(userRepository.update).toHaveBeenCalledWith(userId, {
        refresh_token: null,
        refresh_token_id: null,
        refresh_token_expires_at: null,
      });
    });
  });

  describe('validateUser', () => {
    it('should return user data for valid active user', async () => {
      const user: User = Object.assign(new User(), mockUser);
      userRepository.findOne.mockResolvedValue(user);

      const result = await service.validateUser({
        sub: 'stu_123456',
        email: 'test@example.com',
      });

      expect(result).toEqual({
        userId: mockUser.id,
        email: mockUser.email,
        name: mockUser.name,
        role: UserRole.STUDENT,
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
      });

      expect(result).toBeNull();
    });

    it('should return null for non-existent user', async () => {
      userRepository.findOne.mockResolvedValue(null);

      const result = await service.validateUser({
        sub: 'stu_999999',
        email: 'nonexistent@example.com',
      });

      expect(result).toBeNull();
    });
  });
});
