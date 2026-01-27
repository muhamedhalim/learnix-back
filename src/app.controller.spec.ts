import { ConfigService } from '@nestjs/config';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { InitAdminGuard } from './auth/guards/init-admin.guard';
import { User } from './users/entities/user.entity';
import { DataSource } from 'typeorm';

describe('AppController', () => {
  let appController: AppController;

  const mockConfigService = {
    get: jest.fn((key: string) => {
      const config: Record<string, string> = {
        BCRYPT_ROUNDS: '10',
      };
      return config[key];
    }),
  };

  const mockDataSource = {
    query: jest.fn(),
    isInitialized: true,
  };

  const mockUserRepository = {
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
    count: jest.fn(),
  };

  const mockGuard = {
    canActivate: jest.fn(() => true),
  };

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        AppService,
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
        {
          provide: DataSource,
          useValue: mockDataSource,
        },
        {
          provide: getRepositoryToken(User),
          useValue: mockUserRepository,
        },
      ],
    })
      .overrideGuard(InitAdminGuard)
      .useValue(mockGuard)
      .compile();

    appController = app.get<AppController>(AppController);
  });

  describe('root', () => {
    it('should return welcome message', () => {
      expect(appController.getHello()).toBe('Educational Platform API');
    });
  });

  describe('health', () => {
    it('should be defined', () => {
      expect(appController.getHealth).toBeDefined();
    });
  });

  describe('roles', () => {
    it('should be defined', () => {
      expect(appController.getRoles).toBeDefined();
    });
  });

  describe('initAdmin', () => {
    it('should be defined', () => {
      expect(appController.initAdmin).toBeDefined();
    });
  });
});
