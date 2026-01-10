/* eslint-disable @typescript-eslint/unbound-method */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-return */
import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/entities/user-role.enum';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

describe('AuthService', () => {
  let service: AuthService;
  let userRepository: jest.Mocked<Repository<User>>;
  let jwtService: jest.Mocked<JwtService>;
  let configService: jest.Mocked<ConfigService>;

  const mockUser: Partial<User> = {
    id: 1,
    name: 'Test User',
    email: 'test@example.com',
    phone: '01000000000',
    parent_phone: '01011111111',
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
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    userRepository = module.get(getRepositoryToken(User));
    jwtService = module.get(JwtService);
    configService = module.get(ConfigService);

    configService.get.mockImplementation((key: string) => {
      if (key === 'BCRYPT_ROUNDS') return 12;
      if (key === 'JWT_REFRESH_EXPIRATION') return '7d';
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

      const newUser = {
        ...mockUser,
        id: 2,
        name: registerDto.name,
        email: registerDto.email,
        phone: registerDto.phone,
      } as User;

      userRepository.create.mockReturnValue(newUser);
      userRepository.save.mockResolvedValue(newUser);
      jest.spyOn(bcrypt, 'hash').mockResolvedValue('hashed_password' as never);

      const result = await service.register(registerDto);

      expect(result).toHaveProperty('message');
      expect(result).toHaveProperty('userId');
      expect(result.message).toBe(
        'Registration request received. Pending approval',
      );
      expect(result.userId).toContain('u_');
    });

    it('should throw ConflictException if user already exists (generic message for security)', async () => {
      // Service uses generic error to prevent email/username enumeration
      userRepository.findOne.mockResolvedValue(mockUser as User);

      await expect(service.register(registerDto)).rejects.toThrow(
        new ConflictException(
          'Registration failed. Please try different credentials.',
        ),
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

      userRepository.createQueryBuilder = jest
        .fn()
        .mockReturnValue(queryBuilder);
      jest.spyOn(bcrypt, 'compare').mockResolvedValue(true as never);
      jwtService.sign.mockReturnValue('access_token');

      const result = await service.login(loginDto);

      expect(result).toHaveProperty('access_token');
      expect(result).toHaveProperty('refresh_token');
      expect(result).toHaveProperty('user');
      expect(result.user.email).toBe(loginDto.email);
      expect(result.access_token).toBe('access_token');
    });

    it('should throw UnauthorizedException if user not found', async () => {
      const queryBuilder = {
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      };

      userRepository.createQueryBuilder = jest
        .fn()
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

      userRepository.createQueryBuilder = jest
        .fn()
        .mockReturnValue(queryBuilder);
      jest.spyOn(bcrypt, 'compare').mockResolvedValue(false as never);

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

      userRepository.createQueryBuilder = jest
        .fn()
        .mockReturnValue(queryBuilder);

      const error = await service.login(loginDto).catch((err) => err);

      expect(error).toBeInstanceOf(UnauthorizedException);
      expect((error as UnauthorizedException).message).toContain(
        'This account uses Firebase authentication',
      );
    });
  });

  describe('refresh', () => {
    const refreshToken = 'valid_refresh_token';
    const hashedRefreshToken = 'hashed_refresh_token';

    const userWithRefreshToken = {
      ...mockUser,
      refresh_token: hashedRefreshToken,
      refresh_token_expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    } as User;

    it('should successfully refresh tokens with valid refresh token', async () => {
      const queryBuilder = {
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(userWithRefreshToken),
      };

      userRepository.createQueryBuilder = jest
        .fn()
        .mockReturnValue(queryBuilder);
      jest.spyOn(bcrypt, 'compare').mockResolvedValue(true as never);
      jest.spyOn(bcrypt, 'hash').mockResolvedValue('new_hashed_token' as never);
      jwtService.sign.mockReturnValue('new_access_token');

      const result = await service.refresh(refreshToken);

      expect(result).toHaveProperty('access_token', 'new_access_token');
      expect(result).toHaveProperty('refresh_token');
      expect(result).toHaveProperty('user');
      expect(result.user.email).toBe(mockUser.email);
      expect(userRepository.update).toHaveBeenCalled();
    });

    it('should throw UnauthorizedException for invalid refresh token', async () => {
      const queryBuilder = {
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(userWithRefreshToken),
      };

      userRepository.createQueryBuilder = jest
        .fn()
        .mockReturnValue(queryBuilder);
      jest.spyOn(bcrypt, 'compare').mockResolvedValue(false as never);

      await expect(service.refresh('invalid_token')).rejects.toThrow(
        new UnauthorizedException('Invalid refresh token'),
      );
    });

    it('should throw UnauthorizedException for expired refresh token', async () => {
      const expiredUser = {
        ...userWithRefreshToken,
        refresh_token_expires_at: new Date(Date.now() - 1000),
      } as User;

      const queryBuilder = {
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(expiredUser),
      };

      userRepository.createQueryBuilder = jest
        .fn()
        .mockReturnValue(queryBuilder);
      jest.spyOn(bcrypt, 'compare').mockResolvedValue(true as never);

      await expect(service.refresh(refreshToken)).rejects.toThrow(
        new UnauthorizedException('Refresh token expired'),
      );
    });

    it('should throw UnauthorizedException for inactive user', async () => {
      const inactiveUser = {
        ...userWithRefreshToken,
        is_active: false,
      } as User;

      const queryBuilder = {
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(inactiveUser),
      };

      userRepository.createQueryBuilder = jest
        .fn()
        .mockReturnValue(queryBuilder);
      jest.spyOn(bcrypt, 'compare').mockResolvedValue(true as never);

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

      userRepository.createQueryBuilder = jest
        .fn()
        .mockReturnValue(queryBuilder);
      jest.spyOn(bcrypt, 'compare').mockResolvedValue(true as never);
      jest.spyOn(bcrypt, 'hash').mockResolvedValue('new_hashed_token' as never);
      jwtService.sign.mockReturnValue('new_access_token');

      const result = await service.refresh(refreshToken);

      expect(result.refresh_token).toBeDefined();
      expect(result.refresh_token).not.toBe(refreshToken);
      expect(userRepository.update).toHaveBeenCalledWith(
        mockUser.id,
        expect.objectContaining({
          refresh_token: 'new_hashed_token',
          refresh_token_id: expect.any(String) as string,
          refresh_token_expires_at: expect.any(Date) as Date,
        }),
      );
    });
  });

  describe('logout', () => {
    it('should successfully logout and clear refresh token and token_id', async () => {
      const userId = 1;
      userRepository.update.mockResolvedValue({} as never);

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
      userRepository.findOne.mockResolvedValue(mockUser as User);

      const result = await service.validateUser({
        sub: 1,
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
      const inactiveUser = { ...mockUser, is_active: false } as User;
      userRepository.findOne.mockResolvedValue(inactiveUser);

      const result = await service.validateUser({
        sub: 1,
        email: 'test@example.com',
      });

      expect(result).toBeNull();
    });

    it('should return null for non-existent user', async () => {
      userRepository.findOne.mockResolvedValue(null);

      const result = await service.validateUser({
        sub: 999,
        email: 'nonexistent@example.com',
      });

      expect(result).toBeNull();
    });
  });
});
