import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AttemptState, ExamAttempt } from '../../exams/entities';
import { biBody } from '../../i18n/error-translator.util';
import {
  LeaderboardQueryDto,
  LeaderboardScope,
  LeaderboardWindow,
} from '../dto/leaderboard-query.dto';
import { StudentGameProfile } from '../entities';

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

/** Public leaderboard sourced exclusively from graded attempts on public exams. */
@Injectable()
export class LeaderboardService {
  constructor(
    @InjectRepository(StudentGameProfile)
    private readonly profiles: Repository<StudentGameProfile>,
    @InjectRepository(ExamAttempt)
    private readonly examAttempts: Repository<ExamAttempt>,
  ) {}

  public async getLeaderboard(query: LeaderboardQueryDto): Promise<LeaderboardPage> {
    if (query.scope === LeaderboardScope.SUBJECT && !query.subject_id) {
      throw new BadRequestException(
        biBody(
          'subject_id is required for a subject leaderboard',
          'معرّف المادة مطلوب لعرض لوحة صدارة خاصة بالمادة',
        ),
      );
    }
    if (query.scope === LeaderboardScope.GRADE && !query.grade_level) {
      throw new BadRequestException(
        biBody('grade_level is required for a grade leaderboard', 'المرحلة الدراسية مطلوبة'),
      );
    }
    if (query.scope === LeaderboardScope.GOVERNORATE && !query.governorate) {
      throw new BadRequestException(
        biBody('governorate is required for a governorate leaderboard', 'المحافظة مطلوبة'),
      );
    }

    const page = query.page;
    const limit = query.limit;
    const offset = (page - 1) * limit;
    const percent = 'AVG(a.score_total::numeric / NULLIF(a.max_score, 0)) * 100';
    const qb = this.examAttempts
      .createQueryBuilder('a')
      .innerJoin(
        'exams',
        'exam',
        'exam.id = a.exam_id AND exam.deleted_at IS NULL AND exam.is_public = true',
      )
      .innerJoin('users', 'u', 'u.id = a.student_id AND u.deleted_at IS NULL')
      .leftJoin('student_profiles', 'sp', 'sp.user_id = a.student_id')
      .leftJoin('student_game_profiles', 'gp', 'gp.user_id = a.student_id')
      .leftJoin('rank_tiers', 'rt', 'rt.id = gp.rank_tier_id')
      .where('a.state = :graded', { graded: AttemptState.GRADED })
      .andWhere('a.score_total IS NOT NULL')
      .select('a.student_id', 'user_id')
      .addSelect('u.username', 'username')
      .addSelect('u.name', 'name')
      .addSelect('u.profile_picture_url', 'avatar_url')
      .addSelect(percent, 'score')
      .addSelect(percent, 'rating')
      .addSelect('0', 'xp')
      .addSelect('COALESCE(gp.level, 1)', 'level')
      .addSelect('COALESCE(gp.current_streak, 0)', 'current_streak')
      .addSelect('sp.governorate', 'governorate')
      .addSelect('sp.school', 'school')
      .addSelect('sp.grade_level', 'grade_level')
      .addSelect('rt.slug', 'tier_slug')
      .addSelect('rt.name', 'tier_name')
      .addSelect('rt.icon_key', 'tier_icon')
      .addSelect('rt.color', 'tier_color')
      .addSelect('COUNT(*)', 'attempts')
      .groupBy('a.student_id')
      .addGroupBy('u.username')
      .addGroupBy('u.name')
      .addGroupBy('u.profile_picture_url')
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
      .addOrderBy('a.student_id', 'ASC');

    if (query.scope === LeaderboardScope.SUBJECT) {
      qb.andWhere('exam.subject_id = :subjectId', { subjectId: query.subject_id });
    } else if (query.scope === LeaderboardScope.GRADE) {
      qb.andWhere('sp.grade_level = :gradeLevel', { gradeLevel: query.grade_level });
    } else if (query.scope === LeaderboardScope.GOVERNORATE) {
      qb.andWhere('sp.governorate = :governorate', { governorate: query.governorate });
    }
    if (query.window !== LeaderboardWindow.ALL_TIME) {
      qb.andWhere('a.graded_at >= :since', { since: this.windowStart(query.window) });
    }

    const countQuery = qb
      .clone()
      .select('COUNT(DISTINCT a.student_id)', 'count')
      .orderBy()
      .groupBy();
    const [countRow, raw] = await Promise.all([
      countQuery.getRawOne<{ count: string }>(),
      qb.offset(offset).limit(limit).getRawMany<RawRow>(),
    ]);
    return {
      rows: raw.map((row, index) => this.mapRow(row, offset + index + 1)),
      total: Number(countRow?.count ?? 0),
      page,
      limit,
    };
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

  /** A single user's legacy global rating rank, retained for public profiles. */
  public async globalRatingRank(userId: string, rating: number): Promise<number> {
    const higher = await this.profiles
      .createQueryBuilder('gp')
      .where('gp.global_rating > :rating', { rating })
      .andWhere('gp.user_id != :userId', { userId })
      .getCount();
    return higher + 1;
  }
}
