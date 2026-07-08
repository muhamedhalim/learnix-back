import { Injectable, Logger } from '@nestjs/common';

import { NotificationType } from '../../notifications/entities';
import { NotificationsService } from '../../notifications/services/notifications.service';
import { STREAK_MILESTONES } from '../gamification.constants';
import type { RankTier } from '../entities';
import type { SolveResult } from './gamification.service';

/**
 * Fire-and-forget gamification notifications. Every method swallows its own
 * errors (like `NotificationTriggersService`) so a notification failure can
 * never break the practice flow that triggered it. SMS is disabled — these are
 * in-app engagement nudges, not billable alerts.
 */
@Injectable()
export class GameNotificationsService {
  private readonly logger = new Logger(GameNotificationsService.name);

  constructor(private readonly notifications: NotificationsService) {}

  /** Inspect a solve result and emit any milestone notifications it triggered. */
  public async notifyForSolve(userId: string, result: SolveResult, tier: RankTier | null): Promise<void> {
    if (result.rankUp && tier) {
      await this.safeSend(userId, `New rank: ${tier.name}!`, `You reached ${tier.name}. Keep climbing the leaderboard!`, {
        kind: 'rank_up',
        tier: tier.slug,
      });
    }
    if (result.streakExtendedToday && STREAK_MILESTONES.some((m) => m.days === result.streak)) {
      await this.safeSend(userId, `${String(result.streak)}-day streak!`, `You're on a ${String(result.streak)}-day solving streak. Don't break it!`, {
        kind: 'streak_milestone',
        streak: result.streak,
      });
    }
  }

  private async safeSend(userId: string, title: string, message: string, data: Record<string, unknown>): Promise<void> {
    try {
      await this.notifications.create(
        { user_id: userId, type: NotificationType.GAMIFICATION, title, message, data },
        false, // never send SMS for gamification nudges
      );
    } catch (err) {
      this.logger.warn(`Gamification notification failed for ${userId}: ${(err as Error).message}`);
    }
  }
}
