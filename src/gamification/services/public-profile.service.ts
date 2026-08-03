import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { User } from '../../users/entities/user.entity';
import { UserRole } from '../../users/entities/user-role.enum';
import { StudentProfile } from '../../students/entities/student-profile.entity';
import { QuestionSolve, StudentGameProfile, StudentSubjectRating } from '../entities';
import { levelProgress } from '../logic/leveling';
import { LeaderboardService } from './leaderboard.service';
import { RankService } from './rank.service';
import { biBody } from '../../i18n/error-translator.util';

/**
 * Builds the PUBLIC student profile (`/u/:username`) — safe to serve to
 * unauthenticated visitors. Exposes only display fields (name, avatar, opt-in
 * governorate/school) plus game stats; never email/phone/other PII.
 */
@Injectable()
export class PublicProfileService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(StudentProfile) private readonly studentProfiles: Repository<StudentProfile>,
    @InjectRepository(StudentGameProfile) private readonly games: Repository<StudentGameProfile>,
    @InjectRepository(StudentSubjectRating)
    private readonly subjectRatings: Repository<StudentSubjectRating>,
    @InjectRepository(QuestionSolve) private readonly solves: Repository<QuestionSolve>,
    private readonly rankService: RankService,
    private readonly leaderboard: LeaderboardService,
  ) {}

  public async getByUsername(username: string): Promise<unknown> {
    const user = await this.users.findOne({
      where: { username, role: UserRole.STUDENT },
    });
    if (!user) throw new NotFoundException(biBody('Student not found', 'الطالب غير موجود'));

    const [game, studentProfile] = await Promise.all([
      this.games.findOne({ where: { user_id: user.id } }),
      this.studentProfiles.findOne({ where: { user_id: user.id } }),
    ]);
    if (!studentProfile?.is_public_profile) {
      throw new NotFoundException(biBody('Profile not found', 'الملف الشخصي غير موجود'));
    }

    const rating = game ? game.global_rating : 1200;
    const xp = game ? game.xp : 0;
    const tier = await this.rankService.resolveTier(rating, xp);
    const globalRank = game ? await this.leaderboard.globalRatingRank(user.id, rating) : null;

    const [subjectRows, recent] = await Promise.all([
      this.subjectRatings
        .createQueryBuilder('ssr')
        .leftJoin('subjects', 's', 's.id = ssr.subject_id')
        .where('ssr.user_id = :uid', { uid: user.id })
        .select('ssr.subject_id', 'subject_id')
        .addSelect('s.name', 'subject_name')
        .addSelect('ssr.rating', 'rating')
        .addSelect('ssr.solved', 'solved')
        .addSelect('ssr.correct', 'correct')
        .orderBy('ssr.rating', 'DESC')
        .limit(12)
        .getRawMany<{
          subject_id: string;
          subject_name: string;
          rating: string;
          solved: number;
          correct: number;
        }>(),
      this.solves
        .createQueryBuilder('qs')
        .leftJoin('subjects', 's', 's.id = qs.subject_id')
        .where('qs.user_id = :uid', { uid: user.id })
        .select('qs.id', 'id')
        .addSelect('s.name', 'subject_name')
        .addSelect('qs.difficulty', 'difficulty')
        .addSelect('qs.is_correct', 'is_correct')
        .addSelect('qs.xp_awarded', 'xp_awarded')
        .addSelect('qs.created_at', 'created_at')
        .orderBy('qs.created_at', 'DESC')
        .limit(15)
        .getRawMany<{
          id: string;
          subject_name: string;
          difficulty: string;
          is_correct: boolean;
          xp_awarded: number;
          created_at: Date;
        }>(),
    ]);

    const totalSolved = game ? game.total_solved : 0;
    const accuracy =
      totalSolved > 0 ? Math.round((game!.total_correct / totalSolved) * 1000) / 10 : 0;

    return {
      username: user.username,
      name: user.name,
      avatar_url: user.profile_picture_url,
      rating: Math.round(rating * 100) / 100,
      xp,
      level: levelProgress(xp),
      global_rank: globalRank,
      rank_tier: tier
        ? { slug: tier.slug, name: tier.name, icon_key: tier.icon_key, color: tier.color }
        : null,
      current_streak: game ? game.current_streak : 0,
      longest_streak: game ? game.longest_streak : 0,
      longest_combo: game ? game.longest_combo : 0,
      total_solved: totalSolved,
      total_correct: game ? game.total_correct : 0,
      total_wrong: game ? game.total_wrong : 0,
      accuracy,
      subjects: subjectRows.map((r) => ({
        subject_id: r.subject_id,
        subject_name: r.subject_name,
        rating: Math.round(Number(r.rating) * 100) / 100,
        solved: Number(r.solved),
        correct: Number(r.correct),
        accuracy: r.solved > 0 ? Math.round((r.correct / r.solved) * 1000) / 10 : 0,
      })),
      recent_activity: recent.map((r) => ({
        id: r.id,
        subject_name: r.subject_name,
        difficulty: r.difficulty,
        is_correct: r.is_correct,
        xp_awarded: r.xp_awarded,
        created_at: r.created_at,
      })),
    };
  }
}
