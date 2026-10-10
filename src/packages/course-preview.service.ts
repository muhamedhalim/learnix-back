import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { In, IsNull, Repository } from 'typeorm';

import { ApplicationCacheService } from '../common/cache/application-cache.service';
import { biBody } from '../i18n/error-translator.util';
import { BunnyStreamService } from '../lessons/bunny-stream.service';
import { LessonAwsVideoService } from '../lessons/lesson-aws-video.service';
import type { PlaybackGrant } from '../video/aws-video.service';
import { Lesson } from '../lessons/entities/lesson.entity';
import { LessonStatus } from '../lessons/entities/lesson-status.enum';
import { MediaService } from '../media/media.service';
import { PackagePurchase } from '../payments/entities/package-purchase.entity';
import { ReviewsService } from '../reviews/reviews.service';
import { TeacherProfile } from '../teachers/entities/teacher-profile.entity';
import { User } from '../users/entities/user.entity';
import { CourseChapter } from './entities/course-chapter.entity';
import { CourseStatus } from './entities/course-status.enum';
import { LessonPackage } from './entities/lesson-package.entity';
import { LessonPackageItem } from './entities/lesson-package-item.entity';

/** Free previews are unauthenticated, so the signed URL is kept intentionally short-lived. */
const FREE_PREVIEW_SIGNED_URL_TTL_SECONDS = 10 * 60;

/** Public, anonymous cache TTL for the unsigned half of the preview (T037 a). */
const PREVIEW_CACHE_TTL_MS = 60_000;

interface PreviewLesson {
  id: string;
  title: string;
  duration: number | null;
  is_free_preview: boolean;
  locked: boolean;
  /**
   * Playable source — present only for free-preview lessons whose video has
   * finished encoding. Never exposes bunny_video_id/bunny_library_id/the raw
   * embed URL: this endpoint is public and unauthenticated, so only a
   * short-lived signed URL is safe to hand out.
   */
  video:
    | { signed_url: string; expires_in: number }
    // AWS video: fetch cookies on demand from GET /packages/:id/preview/lessons/:lessonId/playback
    | { platform: 'aws'; lesson_id: string }
    | null;
}

/**
 * Cached shape of one preview lesson (T037 a): the real `video` field is never
 * computed here — only whether the lesson qualifies for one — so the signed
 * URL is generated fresh on every request, after the cache read, and never
 * spends its 10-minute TTL sitting in Redis (rule 8: no cache family or
 * Cache-Control header stores a Bunny signed URL, `expires_in`, or signed
 * playback data). `signable_video_id` never reaches the HTTP body; it exists
 * only to let the post-read mapper sign without a second database round trip.
 * It is not secret (the same id is already observable inside `signed_url`
 * today, `gates/W1-C6d.md` section 3), so holding it in Redis is not a rule 8
 * violation — only the SIGNED value is prohibited from being cached.
 */
interface CachedPreviewLesson {
  id: string;
  title: string;
  duration: number | null;
  is_free_preview: boolean;
  locked: boolean;
  signable_video_id: string | null;
  /** Free-preview lesson whose video is an AWS asset (only the lesson id is cached, never a grant). */
  aws_playback_lesson_id: string | null;
}

interface CachedPreviewSection {
  chapter: { id: string; title: string } | null;
  lessons: CachedPreviewLesson[];
}

/**
 * Builds the public, pre-purchase course preview. Locked lessons are listed but
 * carry no playable source; free-preview lessons expose a short-lived signed
 * playback URL so a teaser plays without a purchase and without leaking any
 * Bunny Stream identifiers.
 */
@Injectable()
export class CoursePreviewService {
  constructor(
    @InjectRepository(LessonPackage)
    private readonly packagesRepository: Repository<LessonPackage>,
    @InjectRepository(LessonPackageItem)
    private readonly itemsRepository: Repository<LessonPackageItem>,
    @InjectRepository(CourseChapter)
    private readonly chaptersRepository: Repository<CourseChapter>,
    @InjectRepository(Lesson)
    private readonly lessonsRepository: Repository<Lesson>,
    @InjectRepository(TeacherProfile)
    private readonly teacherProfilesRepository: Repository<TeacherProfile>,
    @InjectRepository(PackagePurchase)
    private readonly packagePurchasesRepository: Repository<PackagePurchase>,
    private readonly reviewsService: ReviewsService,
    private readonly media: MediaService,
    private readonly bunnyStream: BunnyStreamService,
    private readonly applicationCache: ApplicationCacheService,
    @Optional() private readonly lessonAwsVideo?: LessonAwsVideoService,
  ) {}

  /**
   * Playback grant for ONE free-preview lesson of a published course. Public and unauthenticated by
   * design, so it is strictly limited to free-preview lessons that belong to the course, and the
   * grant is never cached (the route sends `Cache-Control: no-store`).
   */
  public async getPreviewPlayback(packageId: string, lessonId: string): Promise<PlaybackGrant> {
    const notFound = new NotFoundException(biBody('Lesson not found', 'الدرس غير موجود'));
    const pkg = await this.packagesRepository.findOne({
      where: { id: packageId, deleted_at: IsNull(), status: CourseStatus.PUBLISHED, is_active: true },
    });
    if (!pkg || !this.lessonAwsVideo) throw notFound;
    const item = await this.itemsRepository.findOne({ where: { package_id: packageId, lesson_id: lessonId } });
    const lesson = item
      ? await this.lessonsRepository.findOne({
          where: { id: lessonId, deleted_at: IsNull(), status: LessonStatus.PUBLISHED },
        })
      : null;
    if (!lesson || !lesson.is_free_preview || lesson.video_asset_id === null || lesson.bunny_video_status !== 'ready') {
      throw notFound;
    }
    return this.lessonAwsVideo.playback(lesson);
  }

  /**
   * T037 (a): only the unsigned half of the preview is cached. A 404 thrown
   * inside `computePreview` propagates before `getOrCompute` stores anything,
   * so an unpublished/missing course is never cached as "not found".
   */
  public async getPreview(packageId: string): Promise<unknown> {
    const cached = await this.applicationCache.getOrCompute(
      {
        family: 'public_catalog',
        endpoint: 'packages.preview',
        scope: 'public',
        parts: [packageId],
        ttlMs: PREVIEW_CACHE_TTL_MS,
      },
      async () => await this.computePreview(packageId),
    );
    return { ...cached, curriculum: cached.curriculum.map((section) => this.signSection(section)) };
  }

  private signSection(section: CachedPreviewSection): {
    chapter: { id: string; title: string } | null;
    lessons: PreviewLesson[];
  } {
    return {
      chapter: section.chapter,
      lessons: section.lessons.map(({ signable_video_id, aws_playback_lesson_id, ...lesson }) => {
        const signedUrl = signable_video_id
          ? this.bunnyStream.generateSignedEmbedUrl(
              signable_video_id,
              FREE_PREVIEW_SIGNED_URL_TTL_SECONDS,
            )
          : null;
        return {
          ...lesson,
          video: signedUrl
            ? { signed_url: signedUrl, expires_in: FREE_PREVIEW_SIGNED_URL_TTL_SECONDS }
            : aws_playback_lesson_id
              ? { platform: 'aws' as const, lesson_id: aws_playback_lesson_id }
              : null,
        };
      }),
    };
  }

  private async computePreview(packageId: string): Promise<{
    id: string;
    title: string;
    title_ar: string | null;
    description: string | null;
    description_ar: string | null;
    thumbnail_url: string | null;
    intro_video_url: string | null;
    price: number;
    original_price: number | null;
    category: string | null;
    tags: string[];
    requirements: string[];
    what_you_learn: string[];
    faq: unknown[];
    last_updated: Date;
    lessons_count: number;
    students_count: number;
    rating: unknown;
    instructor: unknown;
    curriculum: CachedPreviewSection[];
    related: unknown[];
  }> {
    const pkg = await this.packagesRepository.findOne({
      where: {
        id: packageId,
        deleted_at: IsNull(),
        status: CourseStatus.PUBLISHED,
        is_active: true,
      },
      relations: ['teacher'],
    });
    if (!pkg) {
      throw new NotFoundException(biBody('Course not found', 'الدورة غير موجودة'));
    }

    const [instructor, curriculum, rating, studentsCount, related] = await Promise.all([
      this.buildInstructor(pkg.teacher_id, pkg.teacher),
      this.buildCurriculum(packageId),
      this.reviewsService.getPackageAggregates(packageId),
      this.packagePurchasesRepository.count({
        where: { package_id: packageId, revoked_at: IsNull() },
      }),
      this.buildRelated(pkg),
    ]);

    const lessonsCount = curriculum.reduce((sum, section) => sum + section.lessons.length, 0);

    return {
      id: pkg.id,
      title: pkg.title,
      title_ar: pkg.title_ar,
      description: pkg.description,
      description_ar: pkg.description_ar,
      thumbnail_url: this.mediaUrl(pkg.thumbnail),
      intro_video_url: this.mediaUrl(pkg.intro_video_url),
      price: Number(pkg.price),
      original_price: pkg.original_price != null ? Number(pkg.original_price) : null,
      category: pkg.category,
      tags: pkg.tags ?? [],
      requirements: pkg.requirements ?? [],
      what_you_learn: pkg.what_you_learn ?? [],
      faq: pkg.faq ?? [],
      last_updated: pkg.updated_at,
      lessons_count: lessonsCount,
      students_count: studentsCount,
      rating,
      instructor,
      curriculum,
      related,
    };
  }

  private async buildInstructor(teacherId: string, teacher: User | null): Promise<unknown> {
    const profile = await this.teacherProfilesRepository.findOne({
      where: { user_id: teacherId },
      select: { bio: true, years_of_experience: true },
    });
    return {
      id: teacherId,
      name: teacher?.name ?? 'Instructor',
      avatar: teacher ? this.mediaUrl(teacher.profile_picture_url) : null,
      bio: profile?.bio ?? null,
      years_of_experience: profile?.years_of_experience ?? null,
    };
  }

  private async buildCurriculum(packageId: string): Promise<CachedPreviewSection[]> {
    const [chapters, items] = await Promise.all([
      this.chaptersRepository.find({
        where: { package_id: packageId },
        order: { order_index: 'ASC', id: 'ASC' },
        take: 500,
      }),
      this.itemsRepository.find({
        where: { package_id: packageId },
        order: { order_index: 'ASC', id: 'ASC' },
        take: 500,
      }),
    ]);

    const lessonIds = items.map((i) => i.lesson_id);
    const lessons =
      lessonIds.length > 0
        ? await this.lessonsRepository.find({
            where: {
              id: In(lessonIds),
              deleted_at: IsNull(),
              status: LessonStatus.PUBLISHED,
            },
          })
        : [];
    const lessonMap = new Map(lessons.map((l) => [l.id, l]));

    const toPreview = (lesson: Lesson): CachedPreviewLesson => {
      const free = lesson.is_free_preview;
      const videoReady = lesson.bunny_video_id !== null && lesson.bunny_video_status === 'ready';
      const awsReady = lesson.video_asset_id !== null && lesson.bunny_video_status === 'ready';
      return {
        id: lesson.id,
        title: lesson.title,
        duration: lesson.duration,
        is_free_preview: free,
        locked: !free,
        signable_video_id: free && videoReady ? (lesson.bunny_video_id as string) : null,
        aws_playback_lesson_id: free && awsReady ? lesson.id : null,
      };
    };

    const sections: CachedPreviewSection[] = [];

    for (const chapter of chapters) {
      const chapterLessons = items
        .filter((i) => i.chapter_id === chapter.id)
        .map((i) => lessonMap.get(i.lesson_id))
        .filter((l): l is Lesson => l !== undefined)
        .map(toPreview);
      sections.push({
        chapter: { id: chapter.id, title: chapter.title },
        lessons: chapterLessons,
      });
    }

    // Uncategorised lessons (no chapter) go into a trailing null section.
    const uncategorised = items
      .filter((i) => i.chapter_id === null)
      .map((i) => lessonMap.get(i.lesson_id))
      .filter((l): l is Lesson => l !== undefined)
      .map(toPreview);
    if (uncategorised.length > 0) {
      sections.push({ chapter: null, lessons: uncategorised });
    }

    return sections;
  }

  private async buildRelated(pkg: LessonPackage): Promise<unknown[]> {
    const qb = this.packagesRepository
      .createQueryBuilder('p')
      .where('p.deleted_at IS NULL')
      .andWhere('p.status = :status', { status: CourseStatus.PUBLISHED })
      .andWhere('p.id != :id', { id: pkg.id });

    if (pkg.category) {
      qb.andWhere('(p.category = :category OR p.teacher_id = :teacherId)', {
        category: pkg.category,
        teacherId: pkg.teacher_id,
      });
    } else {
      qb.andWhere('p.teacher_id = :teacherId', { teacherId: pkg.teacher_id });
    }

    const related = await qb.take(4).getMany();
    return related.map((r) => ({
      id: r.id,
      title: r.title,
      thumbnail_url: this.mediaUrl(r.thumbnail),
      price: Number(r.price),
      category: r.category,
    }));
  }

  private mediaUrl(path: string | null): string | null {
    return this.media.resolveThumbnailUrl(path);
  }
}
