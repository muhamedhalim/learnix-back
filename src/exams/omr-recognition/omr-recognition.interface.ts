import type { OmrRecognizedAnswer, OmrTemplateLayout } from '../entities/omr-template.types';

export interface OmrRecognitionInput {
  imageBuffer: Buffer;
  template: OmrTemplateLayout;
  /** The sheet this scan is expected to belong to — cross-checked against the decoded QR when present. */
  expectedSheetId: string;
}

export type OmrRecognitionOutcome =
  /** Successfully processed — `perQuestion` is populated (possibly with review-worthy entries). */
  | 'recognized'
  /** The file itself couldn't be decoded as an image at all. */
  | 'invalid_image'
  /** A QR/marker was found but identifies a different sheet/template than expected. */
  | 'template_mismatch'
  /** The image decoded fine but sheet geometry couldn't be established (markers not found/inconsistent). */
  | 'low_quality';

export interface OmrRecognitionResult {
  outcome: OmrRecognitionOutcome;
  /** Empty unless `outcome === 'recognized'`. */
  perQuestion: OmrRecognizedAnswer[];
  /** Bilingual-safe plain description for non-'recognized' outcomes (paired with a translated copy by the caller). */
  errorMessage?: string;
  rawMeta: {
    provider: string;
    rotationAppliedDegrees: number;
    qrDecoded: boolean;
    qrResidualPx: number | null;
    markerConfidences: number[];
  };
}

/**
 * OMR recognition behind an interface so the rest of the application never
 * depends on one particular computer-vision implementation. The concrete
 * implementation is `FiducialMarkerOmrRecognitionProvider`.
 */
export interface OmrRecognitionProvider {
  readonly name: string;
  recognize(input: OmrRecognitionInput): Promise<OmrRecognitionResult>;
}

export const OMR_RECOGNITION_PROVIDER = Symbol('OMR_RECOGNITION_PROVIDER');
