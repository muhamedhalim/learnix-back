/**
 * Tunable constants for the fiducial-marker recognition pipeline. Centralized
 * here (rather than scattered magic numbers) so they're documented and
 * directly unit-testable against the programmatic fixtures.
 */

/** Provider identity stamped onto `OmrSheet.recognition_provider`. */
export const RECOGNITION_PROVIDER_NAME = 'fiducial-marker-v1';

/** A4 in millimetres — the only supported page size for now. */
export const PAGE_WIDTH_MM = 210;
export const PAGE_HEIGHT_MM = 297;

/** Printable-area margin from the physical page edge (survives printer/scan-crop loss). */
export const PAGE_MARGIN_MM = 14;

export const MARKER_SIZE_MM = 8;
export const QR_SIZE_MM = 22;
export const BUBBLE_RADIUS_MM = 2.2;

/** Layout geometry — single-column, one row per question (see the layout generator's scope note). */
export const HEADER_HEIGHT_MM = 46;
export const ROW_HEIGHT_MM = 12;
export const LABEL_COLUMN_WIDTH_MM = 12;
export const BUBBLE_SPACING_MM = 12;
/** Reject template generation above this — keeps the single-page layout simple and reliable
 *  (a much larger option set would need per-row spacing so tight it hurts detection reliability). */
export const MAX_OPTIONS_PER_QUESTION = 8;

/** Longest-edge cap for the (fast) QR search pass. */
export const QR_SEARCH_MAX_DIMENSION_PX = 1200;
/** Longest-edge cap for the (precision) bubble-sampling pass — bounds worst-case work within the job timeout. */
export const WORKING_MAX_DIMENSION_PX = 3000;

/** Fiducial marker candidate validation (in the working-resolution image). */
export const MARKER_MIN_DARK_PIXELS = 20;
/** Aspect ratio (bbox width/height) must fall within [1/this, this] of a perfect square. */
export const MARKER_MAX_ASPECT_RATIO = 2.0;
/** Dark-pixel count ÷ bounding-box area must clear this floor — rejects scattered noise. */
export const MARKER_MIN_FILL_DENSITY = 0.35;
/** Expected marker bbox size, as a fraction of its nominal mm size converted to px, tolerance band. */
export const MARKER_SIZE_TOLERANCE_LOW = 0.35;
export const MARKER_SIZE_TOLERANCE_HIGH = 3.0;

/** Max acceptable reprojection residual for the QR-as-5th-point homography sanity check, in px
 *  (scaled relative to image working resolution — see `fiducial-marker-recognition.provider.ts`). */
export const MAX_QR_RESIDUAL_FRACTION = 0.03;

/** Exclusive-mark classification (single_choice / true_false). */
export const MIN_CONFIDENT_MARGIN = 0.12;

/** Independent-mark classification (multiple_select): indeterminate band around the adaptive threshold. */
export const INDEPENDENT_MARGIN_BAND = 0.08;

/** Floor/ceiling clamp for the per-sheet Otsu-derived fill-ratio threshold — guards degenerate
 *  sheets (e.g. all-blank) from producing a nonsensical adaptive threshold. */
export const MIN_ADAPTIVE_THRESHOLD = 0.18;
export const MAX_ADAPTIVE_THRESHOLD = 0.55;

/** Bubble sampling radius, in pixels, as a fraction of the estimated px-per-mm scale. */
export const BUBBLE_SAMPLE_RADIUS_FACTOR = 0.85;
