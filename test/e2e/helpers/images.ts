/**
 * Image keys in the exact shape `POST /marketplace/instructor/uploads/image` issues
 * (`images/marketplace/<uuid>/<uuid>.<ext>`). The course and profile routes accept nothing else for a
 * new cover or photo, so specs that create or edit a course through the API use these instead of a
 * made-up path or URL. Nothing is stored under them: only the shape is checked on save.
 */
export const TEST_IMAGE_KEY =
  'images/marketplace/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jpg';

/** A second, different key, for specs that replace a cover. */
export const TEST_IMAGE_KEY_2 =
  'images/marketplace/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/cccccccc-cccc-4ccc-8ccc-cccccccccccc.jpg';
