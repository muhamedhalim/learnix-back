import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { UserSession } from './entities/user-session.entity';
import { SessionsService } from './sessions.service';

describe('SessionsService', () => {
  let service: SessionsService;

  const mockSessionRepository = {
    create: jest.fn(),
    save: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    remove: jest.fn(),
    delete: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
  };

  const mockUserId = 'user-uuid-123';
  const mockSessionId = 'session-uuid-456';
  const mockTokenId = 'token-id-abc';
  const mockExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days from now

  const mockSession: Partial<UserSession> = {
    id: mockSessionId,
    user_id: mockUserId,
    refresh_token_id: mockTokenId,
    device_info: 'Mozilla/5.0 Test Browser',
    ip_address: '192.168.1.1',
    last_active: new Date(),
    created_at: new Date(),
    expires_at: mockExpiresAt,
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module = await Test.createTestingModule({
      providers: [
        SessionsService,
        {
          provide: getRepositoryToken(UserSession),
          useValue: mockSessionRepository,
        },
      ],
    }).compile();

    service = module.get<SessionsService>(SessionsService);
  });

  describe('createSession', () => {
    it('should create a new session', async () => {
      mockSessionRepository.create.mockReturnValue(mockSession);
      mockSessionRepository.save.mockResolvedValue(mockSession);

      const result = await service.createSession({
        userId: mockUserId,
        refreshTokenId: mockTokenId,
        deviceInfo: 'Mozilla/5.0 Test Browser',
        ipAddress: '192.168.1.1',
        expiresAt: mockExpiresAt,
      });

      expect(mockSessionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: mockUserId,
          refresh_token_id: mockTokenId,
          device_info: 'Mozilla/5.0 Test Browser',
          ip_address: '192.168.1.1',
        }),
      );
      expect(mockSessionRepository.save).toHaveBeenCalled();
      expect(result).toEqual(mockSession);
    });
  });

  describe('getUserSessions', () => {
    it('should return all sessions for a user', async () => {
      const mockSessions = [mockSession, { ...mockSession, id: 'session-2' }];
      mockSessionRepository.find.mockResolvedValue(mockSessions);

      const result = await service.getUserSessions(mockUserId, null);

      expect(mockSessionRepository.find).toHaveBeenCalledWith({
        where: { user_id: mockUserId },
        order: { last_active: 'DESC' },
      });
      expect(result).toHaveLength(2);
      expect(result[0]).toHaveProperty('id');
      expect(result[0]).toHaveProperty('deviceInfo');
      expect(result[0]).toHaveProperty('ipAddress');
      expect(result[0]).toHaveProperty('lastActive');
      expect(result[0]).toHaveProperty('createdAt');
      expect(result[0]).toHaveProperty('expiresAt');
      expect(result[0]).toHaveProperty('isCurrent');
    });

    it('should mark current session correctly', async () => {
      mockSessionRepository.find.mockResolvedValue([mockSession]);

      const result = await service.getUserSessions(mockUserId, mockSessionId);

      expect(result[0]?.isCurrent).toBe(true);
    });

    it('should not mark session as current when token id does not match', async () => {
      mockSessionRepository.find.mockResolvedValue([mockSession]);

      const result = await service.getUserSessions(mockUserId, 'different-token');

      expect(result[0]?.isCurrent).toBe(false);
    });
  });

  describe('deleteSession', () => {
    it('should delete a session successfully', async () => {
      mockSessionRepository.findOne.mockResolvedValue(mockSession);
      mockSessionRepository.remove.mockResolvedValue(mockSession);

      await service.deleteSession(mockUserId, mockSessionId, null);

      expect(mockSessionRepository.findOne).toHaveBeenCalledWith({
        where: { id: mockSessionId },
      });
      expect(mockSessionRepository.remove).toHaveBeenCalledWith(mockSession);
    });

    it('should throw NotFoundException when session not found', async () => {
      mockSessionRepository.findOne.mockResolvedValue(null);

      await expect(service.deleteSession(mockUserId, mockSessionId, null)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw ForbiddenException when trying to delete another user session', async () => {
      mockSessionRepository.findOne.mockResolvedValue({
        ...mockSession,
        user_id: 'different-user',
      });

      await expect(service.deleteSession(mockUserId, mockSessionId, null)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should throw ForbiddenException when trying to delete current session', async () => {
      mockSessionRepository.findOne.mockResolvedValue(mockSession);

      await expect(service.deleteSession(mockUserId, mockSessionId, mockSessionId)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('deleteAllUserSessions', () => {
    it('should delete all sessions for a user', async () => {
      mockSessionRepository.delete.mockResolvedValue({ affected: 3 });

      const result = await service.deleteAllUserSessions(mockUserId);

      expect(mockSessionRepository.delete).toHaveBeenCalledWith({
        user_id: mockUserId,
      });
      expect(result).toBe(3);
    });
  });

  describe('deleteSessionByTokenId', () => {
    it('should delete session by refresh token id', async () => {
      mockSessionRepository.delete.mockResolvedValue({ affected: 1 });

      await service.deleteSessionByTokenId(mockTokenId);

      expect(mockSessionRepository.delete).toHaveBeenCalledWith({
        refresh_token_id: mockTokenId,
      });
    });
  });

  describe('updateLastActive', () => {
    it('should update last active timestamp', async () => {
      mockSessionRepository.update.mockResolvedValue({ affected: 1 });

      await service.updateLastActive(mockTokenId);

      expect(mockSessionRepository.update).toHaveBeenCalledWith(
        { refresh_token_id: mockTokenId },
        { last_active: expect.any(Date) },
      );
    });
  });

  describe('updateSessionTokenId', () => {
    it('should update session with new token id', async () => {
      const newTokenId = 'new-token-id';
      const newExpiresAt = new Date();
      mockSessionRepository.update.mockResolvedValue({ affected: 1 });

      await service.updateSessionTokenId(mockTokenId, newTokenId, 'new-token-hash', newExpiresAt);

      expect(mockSessionRepository.update).toHaveBeenCalledWith(
        { refresh_token_id: mockTokenId },
        {
          refresh_token_id: newTokenId,
          refresh_token_hash: 'new-token-hash',
          last_active: expect.any(Date),
          expires_at: newExpiresAt,
        },
      );
    });
  });

  describe('getSessionByTokenId', () => {
    it('should return session by token id', async () => {
      mockSessionRepository.findOne.mockResolvedValue(mockSession);

      const result = await service.getSessionByTokenId(mockTokenId);

      expect(mockSessionRepository.findOne).toHaveBeenCalledWith({
        where: { refresh_token_id: mockTokenId },
      });
      expect(result).toEqual(mockSession);
    });

    it('should return null when session not found', async () => {
      mockSessionRepository.findOne.mockResolvedValue(null);

      const result = await service.getSessionByTokenId('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('getSessionCount', () => {
    it('should return session count for user', async () => {
      mockSessionRepository.count.mockResolvedValue(5);

      const result = await service.getSessionCount(mockUserId);

      expect(mockSessionRepository.count).toHaveBeenCalledWith({
        where: { user_id: mockUserId },
      });
      expect(result).toBe(5);
    });
  });
});
