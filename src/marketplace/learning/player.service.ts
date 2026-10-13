import { Injectable, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { biBody } from '../../i18n/error-translator.util';
import { BunnyStreamService } from '../../lessons/bunny-stream.service';
import { AwsVideoService, awsAssetId, isAwsRef } from '../../video/aws-video.service';
import type { PlaybackCookie } from '../../video/playback-cookies';
import { AccessService } from '../commerce/access.service';
import { MarketplaceLessonProgress } from '../commerce/entities';
import { LessonContentType } from '../common/enums';
import { MarketplaceCourseLesson, MarketplaceCourseSection } from '../catalog/entities';

/** A 5-minute signed-URL TTL, matching the academic player's own (`LessonsService.getSignedPlaybackUrl`). */
const SIGNED_URL_TTL_SECONDS = 300;

export interface PlayerLesson {
  id: string;
  title: string;
  title_ar: string | null;
  position: number;
  content_type: LessonContentType;
  duration_seconds: number;
  is_free_preview: boolean;
  is_required_for_completion: boolean;
  is_completed: boolean;
  last_position_seconds: number;
}

export interface PlayerSection {
  id: string;
  title: string;
  title_ar: string | null;
  position: number;
  lessons: PlayerLesson[];
}

export interface PlayerData {
  enrollment_id: string;
  course_id: string;
  progress_bps: number;
  completed_at: Date | null;
  sections: PlayerSection[];
}

export interface SignedLessonContent {
  lesson_id: string;
  content_type: LessonContentType;
  content_html: string | null;
  playback_url: string | null;
  expires_in: number | null;
  /** `aws` => `playback_url` is an absolute HLS URL on the API/CDN host authorised by `playback_cookies`. */
  platform?: 'aws' | 'bunny';
  playback_cookies?: PlaybackCookie[];
}

/**
 * T125, contracts §4's player block. Deliberately reads the **live**
 * `marketplace_course_sections`/`marketplace_course_lessons` tables, not
 * `MarketplaceCourseVersion.snapshot` (the immutable, purchase-time record
 * `CourseDetailService`'s public/pre-purchase surface reads) — FR-243
 * requires an already-enrolled learner to see a curriculum change (a
 * lesson added, removed, or reordered) the same way `ProgressService`
 * already recalculates against it, not the frozen state at purchase time.
 * Every method gates through `AccessService.verifyAccessByEnrollment()`
 * first — this service never itself decides who has access.
 */
@Injectable()
export class PlayerService {
  constructor(
    @InjectRepository(MarketplaceCourseSection)
    private readonly sections: Repository<MarketplaceCourseSection>,
    @InjectRepository(MarketplaceCourseLesson)
    private readonly lessons: Repository<MarketplaceCourseLesson>,
    @InjectRepository(MarketplaceLessonProgress)
    private readonly progress: Repository<MarketplaceLessonProgress>,
    private readonly access: AccessService,
    private readonly bunnyStream: BunnyStreamService,
    @Optional() private readonly awsVideo?: AwsVideoService,
  ) {}

  public async getPlayerData(learnerId: string, enrollmentId: string): Promise<PlayerData> {
    const enrollment = await this.access.verifyAccessByEnrollment(learnerId, enrollmentId);

    const sections = await this.sections.find({ where: { course_id: enrollment.course_id }, order: { position: 'ASC' } });
    const sectionIds = sections.map((s) => s.id);
    const lessons = sectionIds.length
      ? await this.lessons.find({
          where: { section_id: In(sectionIds) },
          // The curriculum map never needs the lesson body (`content_html`) or the video id.
          select: [
            'id',
            'section_id',
            'title',
            'title_ar',
            'position',
            'content_type',
            'duration_seconds',
            'is_free_preview',
            'is_required_for_completion',
          ],
          order: { position: 'ASC' },
        })
      : [];
    const progressRows = await this.progress.find({ where: { enrollment_id: enrollment.id } });
    const progressByLesson = new Map(progressRows.map((p) => [p.lesson_id, p]));

    return {
      enrollment_id: enrollment.id,
      course_id: enrollment.course_id,
      progress_bps: enrollment.progress_bps,
      completed_at: enrollment.completed_at,
      sections: sections.map((section) => ({
        id: section.id,
        title: section.title,
        title_ar: section.title_ar,
        position: section.position,
        lessons: lessons
          .filter((lesson) => lesson.section_id === section.id)
          .map((lesson) => {
            const p = progressByLesson.get(lesson.id);
            return {
              id: lesson.id,
              title: lesson.title,
              title_ar: lesson.title_ar,
              position: lesson.position,
              content_type: lesson.content_type,
              duration_seconds: lesson.duration_seconds,
              is_free_preview: lesson.is_free_preview,
              is_required_for_completion: lesson.is_required_for_completion,
              is_completed: p?.is_completed ?? false,
              last_position_seconds: p?.last_position_seconds ?? 0,
            };
          }),
      })),
    };
  }

  /** FR-244: never a durable public address for video — a fresh, short-lived signed URL every request. */
  public async getLessonContent(learnerId: string, enrollmentId: string, lessonId: string): Promise<SignedLessonContent> {
    const enrollment = await this.access.verifyAccessByEnrollment(learnerId, enrollmentId);
    const lesson = await this.lessons
      .createQueryBuilder('l')
      .innerJoin('l.section', 's')
      .where('l.id = :lessonId', { lessonId })
      .andWhere('s.course_id = :courseId', { courseId: enrollment.course_id })
      .getOne();
    if (!lesson) {
      throw new NotFoundException(biBody('Lesson not found in this course', 'الدرس غير موجود في هذه الدورة'));
    }

    if (lesson.content_type !== LessonContentType.VIDEO) {
      return {
        lesson_id: lesson.id,
        content_type: lesson.content_type,
        content_html: lesson.content_html,
        playback_url: null,
        expires_in: null,
      };
    }

    if (!lesson.video_id) {
      throw new NotFoundException(biBody('Video not yet available for this lesson', 'الفيديو غير متوفر بعد لهذا الدرس'));
    }
    if (isAwsRef(lesson.video_id) && this.awsVideo) {
      const grant = await this.awsVideo.grantPlayback(awsAssetId(lesson.video_id));
      return {
        lesson_id: lesson.id,
        content_type: lesson.content_type,
        content_html: null,
        playback_url: grant.hls_url,
        expires_in: Math.max(0, Math.round((Date.parse(grant.expires_at) - Date.now()) / 1000)),
        platform: 'aws',
        playback_cookies: grant.playback_cookies,
      };
    }
    const signedUrl = this.bunnyStream.generateSignedEmbedUrl(lesson.video_id, SIGNED_URL_TTL_SECONDS);
    if (!signedUrl) {
      throw new ServiceUnavailableException(biBody('Video playback is temporarily unavailable', 'تشغيل الفيديو غير متاح مؤقتًا'));
    }

    return {
      lesson_id: lesson.id,
      content_type: lesson.content_type,
      content_html: null,
      playback_url: signedUrl,
      expires_in: SIGNED_URL_TTL_SECONDS,
    };
  }
}
