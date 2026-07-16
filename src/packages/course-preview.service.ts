import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { In, IsNull, Repository } from 'typeorm';

import { biBody } from '../i18n/error-translator.util';
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

interface PreviewLesson {
  id: string;
  title: string;
  duration: number | null;
  is_free_preview: boolean;
  locked: boolean;
  /** Playable source — present only for free-preview lessons. */
  video: {
    video_platform: string;
    bunny_video_id: string | null;
    bunny_library_id: string | null;
    video_url: string | null;
    vimeo_embed_url: string | null;
  } | null;
}

/**
 * Builds the public, pre-purchase course preview. Locked lessons are listed but
 * carry no playable source; free-preview lessons expose their embed fields so a
 * teaser plays without a purchase.
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
        where: { package_id: packageId },
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
      intro_video_url: pkg.intro_video_url,
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
        order: { order_index: 'ASC' },
      }),
      this.itemsRepository.find({
        where: { package_id: packageId },
        order: { order_index: 'ASC' },
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
      return {
        id: lesson.id,
        title: lesson.title,
        duration: lesson.duration,
        is_free_preview: free,
        locked: !free,
        video: free
          ? {
              video_platform: lesson.video_platform,
              bunny_video_id: lesson.bunny_video_id,
              bunny_library_id: lesson.bunny_library_id,
              video_url: lesson.video_url,
              vimeo_embed_url: lesson.vimeo_embed_url,
            }
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
