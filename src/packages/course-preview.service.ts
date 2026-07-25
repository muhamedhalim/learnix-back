import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { In, IsNull, Repository } from 'typeorm';

import { biBody } from '../i18n/error-translator.util';
import { BunnyStreamService } from '../lessons/bunny-stream.service';
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
  video: { signed_url: string; expires_in: number } | null;
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
  ) {}

  public async getPreview(packageId: string): Promise<unknown> {
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
      tags: pkg.tags,
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

  private async buildCurriculum(
    packageId: string,
  ): Promise<{ chapter: { id: string; title: string } | null; lessons: PreviewLesson[] }[]> {
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

    const toPreview = (lesson: Lesson): PreviewLesson => {
      const free = lesson.is_free_preview;
      const videoReady = lesson.bunny_video_id !== null && lesson.bunny_video_status === 'ready';
      const signedUrl =
        free && videoReady
          ? this.bunnyStream.generateSignedEmbedUrl(
              lesson.bunny_video_id as string,
              FREE_PREVIEW_SIGNED_URL_TTL_SECONDS,
            )
          : null;
      return {
        id: lesson.id,
        title: lesson.title,
        duration: lesson.duration,
        is_free_preview: free,
        locked: !free,
        video: signedUrl
          ? { signed_url: signedUrl, expires_in: FREE_PREVIEW_SIGNED_URL_TTL_SECONDS }
          : null,
      };
    };

    const sections: {
      chapter: { id: string; title: string } | null;
      lessons: PreviewLesson[];
    }[] = [];

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
