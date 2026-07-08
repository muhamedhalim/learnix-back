import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import {
  LeaderboardMetric,
  LeaderboardQueryDto,
  LeaderboardScope,
  LeaderboardWindow,
} from '../dto/leaderboard-query.dto';
import { StudentGameProfile, StudentSubjectRating, XpEvent } from '../entities';

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
}

/**
 * DB-backed leaderboards (source of truth). All-time rating/XP boards read the
 * cached `student_game_profiles`; subject boards read `student_subject_ratings`;
 * windowed (weekly/monthly) boards aggregate the `xp_events` ledger. Redis ZSET
 * acceleration for the hottest boards is layered on in the jobs slice.
 */
@Injectable()
export class LeaderboardService {
  constructor(
    @InjectRepository(StudentGameProfile)
    private readonly profiles: Repository<StudentGameProfile>,
    @InjectRepository(StudentSubjectRating)
    private readonly subjectRatings: Repository<StudentSubjectRating>,
    @InjectRepository(XpEvent)
    private readonly xpEvents: Repository<XpEvent>,
  ) {}

  public async getLeaderboard(query: LeaderboardQueryDto): Promise<LeaderboardPage> {
    const page = query.page;
    const limit = query.limit;
    const offset = (page - 1) * limit;

    if (query.scope === LeaderboardScope.SUBJECT) {
      if (!query.subject_id) throw new BadRequestException('subject_id is required for a subject leaderboard');
      return this.subjectBoard(query.subject_id, offset, limit, page);
    }
    if (query.window !== LeaderboardWindow.ALL_TIME) {
      return this.windowedXpBoard(query, offset, limit, page);
    }
    return this.allTimeBoard(query, offset, limit, page);
  }

  /** All-time rating/XP board from the cached game profiles (+ optional geo/grade filter). */
  private async allTimeBoard(
    query: LeaderboardQueryDto,
    offset: number,
    limit: number,
    page: number,
  ): Promise<LeaderboardPage> {
    const orderCol = query.metric === LeaderboardMetric.XP ? 'gp.xp' : 'gp.global_rating';
    const qb = this.baseProfileQuery()
      .addSelect(`${orderCol}`, 'score')
      .orderBy(orderCol, 'DESC')
      .addOrderBy('gp.updated_at', 'ASC');
    this.applyScopeFilter(qb, query);

    const total = await this.countProfiles(query);
    const raw = await qb.offset(offset).limit(limit).getRawMany<RawRow>();
    return { rows: raw.map((r, i) => this.mapRow(r, offset + i + 1)), total, page, limit };
  }

  /** All-time per-subject rating board. */
  private async subjectBoard(
    subjectId: string,
    offset: number,
    limit: number,
    page: number,
  ): Promise<LeaderboardPage> {
    const qb = this.subjectRatings
      .createQueryBuilder('ssr')
      .innerJoin('users', 'u', 'u.id = ssr.user_id AND u.deleted_at IS NULL')
      .leftJoin('student_game_profiles', 'gp', 'gp.user_id = ssr.user_id')
      .leftJoin('student_profiles', 'sp', 'sp.user_id = ssr.user_id')
      .leftJoin('rank_tiers', 'rt', 'rt.id = gp.rank_tier_id')
      .where('ssr.subject_id = :sid', { sid: subjectId })
      .select('ssr.user_id', 'user_id')
      .addSelect('u.username', 'username')
      .addSelect('u.name', 'name')
      .addSelect('u.profile_picture_url', 'avatar_url')
      .addSelect('ssr.rating', 'score')
      .addSelect('ssr.rating', 'rating')
      .addSelect('COALESCE(gp.xp, 0)', 'xp')
      .addSelect('COALESCE(gp.level, 1)', 'level')
      .addSelect('COALESCE(gp.current_streak, 0)', 'current_streak')
      .addSelect('sp.governorate', 'governorate')
      .addSelect('sp.school', 'school')
      .addSelect('sp.grade_level', 'grade_level')
      .addSelect('rt.slug', 'tier_slug')
      .addSelect('rt.name', 'tier_name')
      .addSelect('rt.icon_key', 'tier_icon')
      .addSelect('rt.color', 'tier_color')
      .orderBy('ssr.rating', 'DESC')
      .addOrderBy('ssr.updated_at', 'ASC');

    const total = await this.subjectRatings.count({ where: { subject_id: subjectId } });
    const raw = await qb.offset(offset).limit(limit).getRawMany<RawRow>();
    return { rows: raw.map((r, i) => this.mapRow(r, offset + i + 1)), total, page, limit };
  }

  /** Weekly/monthly XP board aggregated from the ledger (+ optional geo/grade filter). */
  private async windowedXpBoard(
    query: LeaderboardQueryDto,
    offset: number,
    limit: number,
    page: number,
  ): Promise<LeaderboardPage> {
    const since = this.windowStart(query.window);
    const qb = this.xpEvents
      .createQueryBuilder('e')
      .innerJoin('users', 'u', 'u.id = e.user_id AND u.deleted_at IS NULL')
      .leftJoin('student_game_profiles', 'gp', 'gp.user_id = e.user_id')
      .leftJoin('student_profiles', 'sp', 'sp.user_id = e.user_id')
      .leftJoin('rank_tiers', 'rt', 'rt.id = gp.rank_tier_id')
      .where('e.occurred_at >= :since', { since })
      .select('e.user_id', 'user_id')
      .addSelect('u.username', 'username')
      .addSelect('u.name', 'name')
      .addSelect('u.profile_picture_url', 'avatar_url')
      .addSelect('SUM(e.amount)', 'score')
      .addSelect('COALESCE(gp.global_rating, 1200)', 'rating')
      .addSelect('SUM(e.amount)', 'xp')
      .addSelect('COALESCE(gp.level, 1)', 'level')
      .addSelect('COALESCE(gp.current_streak, 0)', 'current_streak')
      .addSelect('sp.governorate', 'governorate')
      .addSelect('sp.school', 'school')
      .addSelect('sp.grade_level', 'grade_level')
      .addSelect('rt.slug', 'tier_slug')
      .addSelect('rt.name', 'tier_name')
      .addSelect('rt.icon_key', 'tier_icon')
      .addSelect('rt.color', 'tier_color')
      .groupBy('e.user_id')
      .addGroupBy('u.username')
      .addGroupBy('u.name')
      .addGroupBy('u.profile_picture_url')
      .addGroupBy('gp.global_rating')
      .addGroupBy('gp.level')
      .addGroupBy('gp.current_streak')
      .addGroupBy('sp.governorate')
      .addGroupBy('sp.school')
      .addGroupBy('sp.grade_level')
      .addGroupBy('rt.slug')
      .addGroupBy('rt.name')
      .addGroupBy('rt.icon_key')
      .addGroupBy('rt.color')
      .orderBy('score', 'DESC');
    if (query.scope === LeaderboardScope.GRADE && query.grade_level) {
      qb.andWhere('sp.grade_level = :g', { g: query.grade_level });
    }
    if (query.scope === LeaderboardScope.GOVERNORATE && query.governorate) {
      qb.andWhere('sp.governorate = :gov', { gov: query.governorate });
    }

    const raw = await qb.offset(offset).limit(limit).getRawMany<RawRow>();
    // Total = distinct earners in-window with the same filter.
    const countRow = await qb
      .clone()
      .offset(0)
      .limit(1)
      .select('COUNT(DISTINCT e.user_id)', 'c')
      .orderBy()
      .groupBy()
      .getRawOne<{ c: string }>();
    const total = countRow ? Number(countRow.c) : raw.length;
    return { rows: raw.map((r, i) => this.mapRow(r, offset + i + 1)), total, page, limit };
  }

  private baseProfileQuery() {
    return this.profiles
      .createQueryBuilder('gp')
      .innerJoin('users', 'u', 'u.id = gp.user_id AND u.deleted_at IS NULL')
      .leftJoin('student_profiles', 'sp', 'sp.user_id = gp.user_id')
      .leftJoin('rank_tiers', 'rt', 'rt.id = gp.rank_tier_id')
      .select('gp.user_id', 'user_id')
      .addSelect('u.username', 'username')
      .addSelect('u.name', 'name')
      .addSelect('u.profile_picture_url', 'avatar_url')
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
      .addSelect('rt.color', 'tier_color');
  }

  private applyScopeFilter(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    qb: any,
    query: LeaderboardQueryDto,
  ): void {
    if (query.scope === LeaderboardScope.GRADE) {
      if (!query.grade_level) throw new BadRequestException('grade_level is required for a grade leaderboard');
      qb.andWhere('sp.grade_level = :g', { g: query.grade_level });
    }
    if (query.scope === LeaderboardScope.GOVERNORATE) {
      if (!query.governorate) throw new BadRequestException('governorate is required for a governorate leaderboard');
      qb.andWhere('sp.governorate = :gov', { gov: query.governorate });
    }
  }

  private async countProfiles(query: LeaderboardQueryDto): Promise<number> {
    const qb = this.profiles
      .createQueryBuilder('gp')
      .innerJoin('users', 'u', 'u.id = gp.user_id AND u.deleted_at IS NULL')
      .leftJoin('student_profiles', 'sp', 'sp.user_id = gp.user_id');
    this.applyScopeFilter(qb, query);
    return qb.getCount();
  }

  private windowStart(window: LeaderboardWindow): Date {
    const days = window === LeaderboardWindow.WEEKLY ? 7 : 30;
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  }

  private mapRow(r: RawRow, rank: number): LeaderboardRow {
    return {
      rank,
      user_id: r.user_id,
      username: r.username,
      name: r.name,
      avatar_url: r.avatar_url,
      score: Math.round(Number(r.score) * 100) / 100,
      rating: Math.round(Number(r.rating) * 100) / 100,
      xp: Number(r.xp),
      level: Number(r.level),
      current_streak: Number(r.current_streak),
      governorate: r.governorate,
      school: r.school,
      grade_level: r.grade_level,
      rank_tier:
        r.tier_slug && r.tier_name && r.tier_icon && r.tier_color
          ? { slug: r.tier_slug, name: r.tier_name, icon_key: r.tier_icon, color: r.tier_color }
          : null,
    };
  }

  /** A single user's global rank (1-based) by rating — for the public profile. */
  public async globalRatingRank(userId: string, rating: number): Promise<number> {
    const higher = await this.profiles
      .createQueryBuilder('gp')
      .where('gp.global_rating > :r', { r: rating })
      .andWhere('gp.user_id != :uid', { uid: userId })
      .getCount();
    return higher + 1;
  }
}
