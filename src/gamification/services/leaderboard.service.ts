import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ObjectLiteral, Repository, SelectQueryBuilder } from 'typeorm';

import { biBody } from '../../i18n/error-translator.util';
import {
  LeaderboardMetric,
  LeaderboardQueryDto,
  LeaderboardScope,
  LeaderboardWindow,
} from '../dto/leaderboard-query.dto';
import { QuestionSolve, StudentGameProfile, StudentSubjectRating } from '../entities';

export interface LeaderboardRow {
  rank: number;
  user_id: string;
  username: string;
  name: string;
  avatar_url: string | null;
  score: number;
  rating: number;
  xp: number;
  level: number;
  current_streak: number;
  governorate: string | null;
  school: string | null;
  grade_level: string | null;
  rank_tier: { slug: string; name: string; icon_key: string; color: string } | null;
  attempts: number;
}

export interface LeaderboardPage {
  rows: LeaderboardRow[];
  total: number;
  page: number;
  limit: number;
}

interface RawRow {
  user_id: string;
  username: string;
  name: string;
  avatar_url: string | null;
  score: string;
  rating: string;
  xp: string;
  level: number;
  current_streak: number;
  governorate: string | null;
  school: string | null;
  grade_level: string | null;
  tier_slug: string | null;
  tier_name: string | null;
  tier_icon: string | null;
  tier_color: string | null;
  attempts: string;
}

/**
 * Public practice leaderboard.
 *
 * The game profile, subject rating, and question-solve ledger are all updated
 * in the same transaction as a server-verified practice answer. This service
 * reads those records only; private/course exam attempts are deliberately not
 * part of this board.
 */
@Injectable()
export class LeaderboardService {
  constructor(
    @InjectRepository(StudentGameProfile)
    private readonly profiles: Repository<StudentGameProfile>,
    @InjectRepository(StudentSubjectRating)
    private readonly subjectRatings: Repository<StudentSubjectRating>,
    @InjectRepository(QuestionSolve)
    private readonly solves: Repository<QuestionSolve>,
  ) {}

  public async getLeaderboard(query: LeaderboardQueryDto): Promise<LeaderboardPage> {
    this.assertRequiredScopeFilter(query);

    const page = query.page;
    const limit = query.limit;
    const offset = (page - 1) * limit;
    const board =
      query.window === LeaderboardWindow.ALL_TIME
        ? this.allTimeBoard(query)
        : this.windowedBoard(query);
    const userIdColumn =
      query.window !== LeaderboardWindow.ALL_TIME
        ? 'qs.user_id'
        : query.scope === LeaderboardScope.SUBJECT
          ? 'sr.user_id'
          : 'gp.user_id';

    const countQuery = board
      .clone()
      .select(`COUNT(DISTINCT ${userIdColumn})`, 'count')
      .orderBy()
      .groupBy();
    const [countRow, raw] = await Promise.all([
      countQuery.getRawOne<{ count: string }>(),
      board.offset(offset).limit(limit).getRawMany<RawRow>(),
    ]);

    return {
      rows: raw.map((row, index) => this.mapRow(row, offset + index + 1)),
      total: Number(countRow?.count ?? 0),
      page,
      limit,
    };
  }

  private allTimeBoard(query: LeaderboardQueryDto): SelectQueryBuilder<ObjectLiteral> {
    if (query.scope === LeaderboardScope.SUBJECT) {
      return this.allTimeSubjectBoard(query);
    }

    const score = query.metric === LeaderboardMetric.XP ? 'gp.xp' : 'gp.global_rating';
    const qb = this.profiles
      .createQueryBuilder('gp')
      .innerJoin('users', 'u', "u.id = gp.user_id AND u.deleted_at IS NULL AND u.role = 'student'")
      .leftJoin('student_profiles', 'sp', 'sp.user_id = gp.user_id')
      .leftJoin('rank_tiers', 'rt', 'rt.id = gp.rank_tier_id')
      .where('gp.total_solved > 0')
      .select('gp.user_id', 'user_id')
      .addSelect('u.username', 'username')
      .addSelect('u.name', 'name')
      .addSelect('u.profile_picture_url', 'avatar_url')
      .addSelect(score, 'score')
      .addSelect('gp.global_rating', 'rating')
      .addSelect('gp.xp', 'xp')
      .addSelect('gp.level', 'level')
      .addSelect('gp.current_streak', 'current_streak')
      .addSelect('sp.governorate', 'governorate')
      .addSelect('sp.school', 'school')
      .addSelect('sp.grade_level', 'grade_level')
      .addSelect('rt.slug', 'tier_slug')
      .addSelect('rt.name', 'tier_name')
      .addSelect('rt.icon_key', 'tier_icon')
      .addSelect('rt.color', 'tier_color')
      .addSelect('gp.total_solved', 'attempts')
      .orderBy('score', 'DESC')
      .addOrderBy('gp.user_id', 'ASC');

    this.applyDemographicScope(qb, query);
    return qb;
  }

  private allTimeSubjectBoard(query: LeaderboardQueryDto): SelectQueryBuilder<ObjectLiteral> {
    const subjectXp = `(
      SELECT COALESCE(SUM(qs.xp_awarded), 0)
      FROM question_solves qs
      WHERE qs.user_id = sr.user_id AND qs.subject_id = sr.subject_id
    )`;
    const score = query.metric === LeaderboardMetric.XP ? subjectXp : 'sr.rating';
    return this.subjectRatings
      .createQueryBuilder('sr')
      .innerJoin('student_game_profiles', 'gp', 'gp.user_id = sr.user_id')
      .innerJoin('users', 'u', "u.id = sr.user_id AND u.deleted_at IS NULL AND u.role = 'student'")
      .leftJoin('student_profiles', 'sp', 'sp.user_id = sr.user_id')
      .leftJoin('rank_tiers', 'rt', 'rt.id = gp.rank_tier_id')
      .where('sr.subject_id = :subjectId', { subjectId: query.subject_id })
      .andWhere('sr.solved > 0')
      .select('sr.user_id', 'user_id')
      .addSelect('u.username', 'username')
      .addSelect('u.name', 'name')
      .addSelect('u.profile_picture_url', 'avatar_url')
      .addSelect(score, 'score')
      .addSelect('sr.rating', 'rating')
      .addSelect(subjectXp, 'xp')
      .addSelect('gp.level', 'level')
      .addSelect('gp.current_streak', 'current_streak')
      .addSelect('sp.governorate', 'governorate')
      .addSelect('sp.school', 'school')
      .addSelect('sp.grade_level', 'grade_level')
      .addSelect('rt.slug', 'tier_slug')
      .addSelect('rt.name', 'tier_name')
      .addSelect('rt.icon_key', 'tier_icon')
      .addSelect('rt.color', 'tier_color')
      .addSelect('sr.solved', 'attempts')
      .orderBy('score', 'DESC')
      .addOrderBy('sr.user_id', 'ASC');
  }

  private windowedBoard(query: LeaderboardQueryDto): SelectQueryBuilder<ObjectLiteral> {
    // Windowed boards are calculated from the immutable solve ledger. The
    // score is the rating movement or XP actually earned in that period, so a
    // retry with zero award cannot inflate a weekly/monthly board.
    const score =
      query.metric === LeaderboardMetric.XP
        ? 'COALESCE(SUM(qs.xp_awarded), 0)'
        : 'COALESCE(SUM(qs.rating_delta), 0)';
    const qb = this.solves
      .createQueryBuilder('qs')
      .innerJoin('questions', 'q', 'q.id = qs.question_id AND q.deleted_at IS NULL AND q.is_active = true AND q.is_public = true')
      .innerJoin('users', 'u', "u.id = qs.user_id AND u.deleted_at IS NULL AND u.role = 'student'")
      .innerJoin('student_game_profiles', 'gp', 'gp.user_id = qs.user_id')
      .leftJoin('student_profiles', 'sp', 'sp.user_id = qs.user_id')
      .leftJoin('rank_tiers', 'rt', 'rt.id = gp.rank_tier_id')
      .where('qs.created_at >= :since', { since: this.windowStart(query.window) })
      .select('qs.user_id', 'user_id')
      .addSelect('u.username', 'username')
      .addSelect('u.name', 'name')
      .addSelect('u.profile_picture_url', 'avatar_url')
      .addSelect(score, 'score')
      .addSelect('gp.global_rating', 'rating')
      .addSelect('gp.xp', 'xp')
      .addSelect('gp.level', 'level')
      .addSelect('gp.current_streak', 'current_streak')
      .addSelect('sp.governorate', 'governorate')
      .addSelect('sp.school', 'school')
      .addSelect('sp.grade_level', 'grade_level')
      .addSelect('rt.slug', 'tier_slug')
      .addSelect('rt.name', 'tier_name')
      .addSelect('rt.icon_key', 'tier_icon')
      .addSelect('rt.color', 'tier_color')
      .addSelect('COUNT(*)', 'attempts')
      .groupBy('qs.user_id')
      .addGroupBy('u.username')
      .addGroupBy('u.name')
      .addGroupBy('u.profile_picture_url')
      .addGroupBy('gp.global_rating')
      .addGroupBy('gp.xp')
      .addGroupBy('gp.level')
      .addGroupBy('gp.current_streak')
      .addGroupBy('sp.governorate')
      .addGroupBy('sp.school')
      .addGroupBy('sp.grade_level')
      .addGroupBy('rt.slug')
      .addGroupBy('rt.name')
      .addGroupBy('rt.icon_key')
      .addGroupBy('rt.color')
      .orderBy('score', 'DESC')
      .addOrderBy('qs.user_id', 'ASC');

    if (query.scope === LeaderboardScope.SUBJECT) {
      qb.andWhere('qs.subject_id = :subjectId', { subjectId: query.subject_id });
    } else {
      this.applyDemographicScope(qb, query);
    }
    return qb;
  }

  private applyDemographicScope(qb: SelectQueryBuilder<ObjectLiteral>, query: LeaderboardQueryDto): void {
    if (query.scope === LeaderboardScope.GRADE) {
      qb.andWhere('sp.grade_level = :gradeLevel', { gradeLevel: query.grade_level });
    } else if (query.scope === LeaderboardScope.GOVERNORATE) {
      qb.andWhere('sp.governorate = :governorate', { governorate: query.governorate });
    }
  }

  private assertRequiredScopeFilter(query: LeaderboardQueryDto): void {
    if (query.scope === LeaderboardScope.SUBJECT && !query.subject_id) {
      throw new BadRequestException(
        biBody(
          'subject_id is required for a subject leaderboard',
          'Ù…Ø¹Ø±Ù‘Ù Ø§Ù„Ù…Ø§Ø¯Ø© Ù…Ø·Ù„ÙˆØ¨ Ù„Ø¹Ø±Ø¶ Ù„ÙˆØ­Ø© ØµØ¯Ø§Ø±Ø© Ø®Ø§ØµØ© Ø¨Ø§Ù„Ù…Ø§Ø¯Ø©',
        ),
      );
    }
    if (query.scope === LeaderboardScope.GRADE && !query.grade_level) {
      throw new BadRequestException(
        biBody('grade_level is required for a grade leaderboard', 'Ø§Ù„Ù…Ø±Ø­Ù„Ø© Ø§Ù„Ø¯Ø±Ø§Ø³ÙŠØ© Ù…Ø·Ù„ÙˆØ¨Ø©'),
      );
    }
    if (query.scope === LeaderboardScope.GOVERNORATE && !query.governorate) {
      throw new BadRequestException(
        biBody('governorate is required for a governorate leaderboard', 'Ø§Ù„Ù…Ø­Ø§ÙØ¸Ø© Ù…Ø·Ù„ÙˆØ¨Ø©'),
      );
    }
  }

  private windowStart(window: LeaderboardWindow): Date {
    const days = window === LeaderboardWindow.WEEKLY ? 7 : 30;
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  }

  private mapRow(row: RawRow, rank: number): LeaderboardRow {
    return {
      rank,
      user_id: row.user_id,
      username: row.username,
      name: row.name,
      avatar_url: row.avatar_url,
      score: Math.round(Number(row.score) * 100) / 100,
      rating: Math.round(Number(row.rating) * 100) / 100,
      xp: Number(row.xp),
      level: Number(row.level),
      current_streak: Number(row.current_streak),
      governorate: row.governorate,
      school: row.school,
      grade_level: row.grade_level,
      rank_tier:
        row.tier_slug && row.tier_name && row.tier_icon && row.tier_color
          ? {
              slug: row.tier_slug,
              name: row.tier_name,
              icon_key: row.tier_icon,
              color: row.tier_color,
            }
          : null,
      attempts: Number(row.attempts),
    };
  }

  /** A single user's global rating rank, retained for public profiles. */
  public async globalRatingRank(userId: string, rating: number): Promise<number> {
    const higher = await this.profiles
      .createQueryBuilder('gp')
      .where('gp.total_solved > 0')
      .andWhere('gp.global_rating > :rating', { rating })
      .andWhere('gp.user_id != :userId', { userId })
      .getCount();
    return higher + 1;
  }
}
