import type {
  ChapterResponse,
  CourseResponse,
  LessonResponse,
  ResourceResponse,
} from './api-responses.interface';

export function isChapterResponse(obj: unknown): obj is ChapterResponse {
  const chapter = obj as ChapterResponse;
  return (
    typeof chapter === 'object' &&
    Boolean(chapter) &&
    typeof chapter.id === 'number' &&
    typeof chapter.title === 'string' &&
    typeof chapter.course_id === 'number'
  );
}

export function isLessonResponse(obj: unknown): obj is LessonResponse {
  const lesson = obj as LessonResponse;
  return (
    typeof lesson === 'object' &&
    Boolean(lesson) &&
    typeof lesson.id === 'number' &&
    typeof lesson.title === 'string' &&
    typeof lesson.chapter_id === 'number'
  );
}

export function isResourceResponse(obj: unknown): obj is ResourceResponse {
  const resource = obj as ResourceResponse;
  return (
    typeof resource === 'object' &&
    Boolean(resource) &&
    typeof resource.id === 'number' &&
    typeof resource.title === 'string' &&
    typeof resource.filename === 'string'
  );
}

export function isCourseResponse(obj: unknown): obj is CourseResponse {
  const course = obj as CourseResponse;
  return (
    typeof course === 'object' &&
    Boolean(course) &&
    typeof course.id === 'number' &&
    typeof course.title === 'string' &&
    typeof course.description === 'string'
  );
}

export function assertIsArray<T>(
  value: unknown,
  itemValidator?: (item: unknown) => item is T,
): asserts value is T[] {
  if (!Array.isArray(value)) {
    throw new Error('Expected an array');
  }
  if (itemValidator) {
    value.forEach((item, index) => {
      if (!itemValidator(item)) {
        throw new Error(
          `Array item at index ${String(index)} failed validation`,
        );
      }
    });
  }
}
