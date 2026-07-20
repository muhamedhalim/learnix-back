import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';

import { LessThan, MoreThan, Repository } from 'typeorm';

import { biBody } from '../i18n/error-translator.util';
import type { UserSessionDto } from './dto/user-session.dto';
import { UserSession } from './entities/user-session.entity';

@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);

  constructor(
    @InjectRepository(UserSession)
    private readonly sessionRepository: Repository<UserSession>,
  ) {}

  /**
   * Cleanup expired sessions - runs daily at 3 AM
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  public async cleanupExpiredSessions(): Promise<void> {
    const now = new Date();

    const result = await this.sessionRepository.delete({
      expires_at: LessThan(now),
    });

    const deletedCount = result.affected ?? 0;

    if (deletedCount > 0) {
      this.logger.log(`Cleaned up ${String(deletedCount)} expired sessions`);
    }
  }

  /**
   * Create a new session for a user on login
   */
  public async createSession(params: {
    userId: string;
    refreshTokenId: string;
    refreshTokenHash: string;
    deviceInfo: string | null;
    ipAddress: string | null;
    expiresAt: Date;
  }): Promise<UserSession> {
    const session = this.sessionRepository.create({
      user_id: params.userId,
      refresh_token_id: params.refreshTokenId,
      refresh_token_hash: params.refreshTokenHash,
      device_info: params.deviceInfo,
      ip_address: params.ipAddress,
      last_active: new Date(),
      expires_at: params.expiresAt,
    });

    const savedSession = await this.sessionRepository.save(session);
    this.logger.log(`Session created for user ${params.userId}`);

    return savedSession;
  }

  /**
   * Get all active sessions for a user
   */
  public async getUserSessions(
    userId: string,
    currentSessionId: string | null,
  ): Promise<UserSessionDto[]> {
    const sessions = await this.sessionRepository.find({
      where: { user_id: userId },
      order: { last_active: 'DESC', id: 'DESC' },
      // A user can normally have only a handful of sessions. Keep the
      // security-management response bounded even if stale rows accumulate.
      take: 100,
    });

    return sessions.map((session) => ({
      id: session.id,
      deviceInfo: session.device_info,
      ipAddress: session.ip_address,
      lastActive: session.last_active,
      createdAt: session.created_at,
      expiresAt: session.expires_at,
      isCurrent: session.id === currentSessionId,
    }));
  }

  /**
   * Delete a specific session
   */
  public async deleteSession(
    userId: string,
    sessionId: string,
    currentSessionId: string | null,
  ): Promise<void> {
    const session = await this.sessionRepository.findOne({
      where: { id: sessionId },
    });

    if (session === null) {
      throw new NotFoundException(biBody('Session not found', 'الجلسة غير موجودة'));
    }

    if (session.user_id !== userId) {
      throw new ForbiddenException(
        biBody(
          'Cannot delete session belonging to another user',
          'لا يمكن حذف جلسة تخص مستخدمًا آخر',
        ),
      );
    }

    // Check if trying to delete current session
    if (session.id === currentSessionId) {
      throw new ForbiddenException(
        biBody(
          'Cannot delete current session. Use logout endpoint instead.',
          'لا يمكن حذف الجلسة الحالية. يرجى استخدام واجهة تسجيل الخروج بدلاً من ذلك.',
        ),
      );
    }

    await this.sessionRepository.remove(session);
    this.logger.log(`Session ${sessionId} deleted for user ${userId}`);
  }

  /**
   * Delete all sessions for a user (logout from all devices)
   */
  public async deleteAllUserSessions(userId: string): Promise<number> {
    const result = await this.sessionRepository.delete({ user_id: userId });
    const deletedCount = result.affected ?? 0;

    this.logger.log(`All ${String(deletedCount)} sessions deleted for user ${userId}`);
    return deletedCount;
  }

  /**
   * Delete session by refresh token ID (called on logout)
   */
  public async deleteSessionByTokenId(refreshTokenId: string): Promise<void> {
    await this.sessionRepository.delete({ refresh_token_id: refreshTokenId });
    this.logger.debug(`Session deleted for token ID ${refreshTokenId}`);
  }

  /** Revoke one session, including every access token bound to its session id. */
  public async deleteSessionById(userId: string, sessionId: string): Promise<void> {
    await this.sessionRepository.delete({ id: sessionId, user_id: userId });
    this.logger.debug(`Session ${sessionId} revoked for user ${userId}`);
  }

  /**
   * Update last_active timestamp for a session
   */
  public async updateLastActive(refreshTokenId: string): Promise<void> {
    await this.sessionRepository.update(
      { refresh_token_id: refreshTokenId },
      { last_active: new Date() },
    );
  }

  /**
   * Update session with new refresh token ID (on token rotation)
   */
  public async updateSessionTokenId(
    oldTokenId: string,
    newTokenId: string,
    newTokenHash: string,
    newExpiresAt: Date,
  ): Promise<void> {
    await this.sessionRepository.update(
      { refresh_token_id: oldTokenId },
      {
        refresh_token_id: newTokenId,
        refresh_token_hash: newTokenHash,
        last_active: new Date(),
        expires_at: newExpiresAt,
      },
    );
    this.logger.debug(`Session token rotated from ${oldTokenId} to ${newTokenId}`);
  }

  /**
   * Get session by refresh token ID
   */
  public async getSessionByTokenId(refreshTokenId: string): Promise<UserSession | null> {
    return await this.sessionRepository.findOne({
      where: { refresh_token_id: refreshTokenId },
    });
  }

  /** Resolve an unexpired access-token session and its user in one query. */
  public async getActiveSession(userId: string, sessionId: string): Promise<UserSession | null> {
    return await this.sessionRepository.findOne({
      where: {
        id: sessionId,
        user_id: userId,
        expires_at: MoreThan(new Date()),
      },
      relations: { user: true },
    });
  }

  /**
   * Get active session count for a user
   */
  public async getSessionCount(userId: string): Promise<number> {
    return await this.sessionRepository.count({
      where: { user_id: userId },
    });
  }
}
