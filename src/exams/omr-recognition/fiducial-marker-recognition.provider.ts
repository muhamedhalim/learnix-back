import { Injectable, Logger } from '@nestjs/common';

import type {
  OmrBubbleSpec,
  OmrMarkerSpec,
  OmrOptionBubble,
  OmrQuestionLayout,
  OmrRecognizedAnswer,
} from '../entities/omr-template.types';
import { QuestionType } from '../entities/question-type.enum';
import {
  classifyExclusiveMark,
  classifyIndependentMarks,
  sampleBubbleFillRatio,
} from './bubble-sampling.util';
import {
  BUBBLE_SAMPLE_RADIUS_FACTOR,
  MAX_QR_RESIDUAL_FRACTION,
  MIN_ADAPTIVE_THRESHOLD,
  MAX_ADAPTIVE_THRESHOLD,
  QR_SEARCH_MAX_DIMENSION_PX,
  RECOGNITION_PROVIDER_NAME,
  WORKING_MAX_DIMENSION_PX,
} from './constants';
import { type DetectedMarker, detectFiducialMarker } from './fiducial-detection.util';
import { applyHomography, computeHomography, distance, type Point2D } from './geometry.util';
import { decodeToRaster, type RasterImage, rotateImageBuffer } from './image-buffer.util';
import { otsuThreshold } from './otsu.util';
import type {
  OmrRecognitionInput,
  OmrRecognitionProvider,
  OmrRecognitionResult,
} from './omr-recognition.interface';
import {
  decodeSheetIdFromQrPayload,
  detectQr,
  estimatePhotoRotationDegrees,
  rotationCorrectionForPhotoRotation,
  type QrDetection,
} from './qr.util';

type MarkerCorner = 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight';

/**
 * Hand-rolled, dependency-light OMR recognition: 4 fiducial corner markers +
 * homography for geometry, an identity QR (decode-only, kept out of the
 * geometry solve), a per-sheet Otsu-adaptive fill threshold, and margin-based
 * mark classification. See the module doc comments in `geometry.util.ts`,
 * `qr.util.ts`, `fiducial-detection.util.ts`, and `bubble-sampling.util.ts`
 * for the reasoning behind each piece.
 */
@Injectable()
export class FiducialMarkerOmrRecognitionProvider implements OmrRecognitionProvider {
  public readonly name = RECOGNITION_PROVIDER_NAME;
  private readonly logger = new Logger(FiducialMarkerOmrRecognitionProvider.name);

  public async recognize(input: OmrRecognitionInput): Promise<OmrRecognitionResult> {
    const { imageBuffer, template, expectedSheetId } = input;

    let searchPass: RasterImage;
    try {
      searchPass = await decodeToRaster(imageBuffer, QR_SEARCH_MAX_DIMENSION_PX);
    } catch (err) {
      return this.fail(
        'invalid_image',
        `Could not decode the uploaded image: ${describeError(err)}`,
      );
    }

    const qr = detectQr(searchPass.rgba, searchPass.width, searchPass.height);
    let rotationApplied: 0 | 90 | 180 | 270 = 0;
    let workingBuffer = imageBuffer;

    if (qr) {
      const sheetIdFromQr = decodeSheetIdFromQrPayload(qr.data);
      if (sheetIdFromQr !== null && sheetIdFromQr !== expectedSheetId) {
        return this.fail(
          'template_mismatch',
          'The scanned sheet identifies a different exam/sheet than expected.',
        );
      }
      const photoRotation = estimatePhotoRotationDegrees(qr);
      rotationApplied = rotationCorrectionForPhotoRotation(photoRotation);
      if (rotationApplied !== 0) {
        try {
          workingBuffer = await rotateImageBuffer(imageBuffer, rotationApplied);
        } catch (err) {
          return this.fail(
            'invalid_image',
            `Could not correct scan rotation: ${describeError(err)}`,
          );
        }
      }
    }

    let working: RasterImage;
    try {
      working = await decodeToRaster(workingBuffer, WORKING_MAX_DIMENSION_PX);
    } catch (err) {
      return this.fail(
        'invalid_image',
        `Could not decode the uploaded image: ${describeError(err)}`,
      );
    }

    // Re-detect on the working-resolution (possibly rotated) image — used
    // below purely as a free 5th validation point, never for geometry itself.
    const qrForValidation = detectQr(working.rgba, working.width, working.height);

    const globalThreshold = estimateGlobalInkThreshold(working.gray);
    const pxPerMm =
      (working.width / template.pageWidthMm + working.height / template.pageHeightMm) / 2;
    const markerExpectedSizePx = template.markers.topLeft.sizeMm * pxPerMm;
    const searchHalfWindowMm = Math.max(template.markers.topLeft.sizeMm * 2.5, 12);

    const corners: Record<MarkerCorner, DetectedMarker | null> = {
      topLeft: this.findMarker(
        working,
        template.markers.topLeft,
        pxPerMm,
        searchHalfWindowMm,
        globalThreshold,
        markerExpectedSizePx,
      ),
      topRight: this.findMarker(
        working,
        template.markers.topRight,
        pxPerMm,
        searchHalfWindowMm,
        globalThreshold,
        markerExpectedSizePx,
      ),
      bottomLeft: this.findMarker(
        working,
        template.markers.bottomLeft,
        pxPerMm,
        searchHalfWindowMm,
        globalThreshold,
        markerExpectedSizePx,
      ),
      bottomRight: this.findMarker(
        working,
        template.markers.bottomRight,
        pxPerMm,
        searchHalfWindowMm,
        globalThreshold,
        markerExpectedSizePx,
      ),
    };
    const missingCorners = (Object.keys(corners) as MarkerCorner[]).filter(
      (k) => corners[k] === null,
    );
    if (missingCorners.length > 0) {
      this.logger.warn(`Fiducial markers not found: ${missingCorners.join(', ')}`);
      return this.fail(
        'low_quality',
        'Could not locate the sheet’s corner markers. Please rescan with the full sheet visible, flat, and well-lit.',
      );
    }

    const src: [Point2D, Point2D, Point2D, Point2D] = [
      corner(template.markers.topLeft),
      corner(template.markers.topRight),
      corner(template.markers.bottomLeft),
      corner(template.markers.bottomRight),
    ];
    const dst: [Point2D, Point2D, Point2D, Point2D] = [
      corners.topLeft!.center,
      corners.topRight!.center,
      corners.bottomLeft!.center,
      corners.bottomRight!.center,
    ];
    const homography = computeHomography(src, dst);
    if (!homography) {
      return this.fail(
        'low_quality',
        'Could not compute the sheet’s geometry from its corner markers.',
      );
    }

    let qrResidualPx: number | null = null;
    if (qrForValidation) {
      const qrCenterTemplate: Point2D = {
        x: template.qr.x + template.qr.sizeMm / 2,
        y: template.qr.y + template.qr.sizeMm / 2,
      };
      const predicted = applyHomography(homography, qrCenterTemplate);
      const actual = averageOf([
        qrForValidation.topLeftCorner,
        qrForValidation.topRightCorner,
        qrForValidation.bottomLeftCorner,
        qrForValidation.bottomRightCorner,
      ]);
      qrResidualPx = distance(predicted, actual);
      const maxResidualPx = MAX_QR_RESIDUAL_FRACTION * Math.max(working.width, working.height);
      if (qrResidualPx > maxResidualPx) {
        return this.fail(
          'template_mismatch',
          'The sheet’s geometry is inconsistent with its identity marker — possibly the wrong template or a damaged scan.',
        );
      }
    }

    const bubbleRadiusPx = template.bubbleRadiusMm * pxPerMm * BUBBLE_SAMPLE_RADIUS_FACTOR;
    const allRatios: number[] = [];
    const perQuestionRatios = template.questions.map((question) => {
      const ratios = question.bubbles.map((bubble) => {
        const photoPoint = applyHomography(homography, { x: bubble.x, y: bubble.y });
        const ratio = sampleBubbleFillRatio(
          working.gray,
          working.width,
          working.height,
          photoPoint,
          bubbleRadiusPx,
          globalThreshold,
        );
        allRatios.push(ratio);
        return ratio;
      });
      return { question, ratios };
    });

    const adaptiveThreshold = Math.min(
      MAX_ADAPTIVE_THRESHOLD,
      Math.max(MIN_ADAPTIVE_THRESHOLD, otsuThreshold(allRatios)),
    );

    const perQuestion: OmrRecognizedAnswer[] = perQuestionRatios.map(({ question, ratios }) =>
      this.classifyQuestion(question, ratios, adaptiveThreshold),
    );

    return {
      outcome: 'recognized',
      perQuestion,
      rawMeta: {
        provider: this.name,
        rotationAppliedDegrees: rotationApplied,
        qrDecoded: qr !== null,
        qrResidualPx,
        markerConfidences: [
          corners.topLeft!.confidence,
          corners.topRight!.confidence,
          corners.bottomLeft!.confidence,
          corners.bottomRight!.confidence,
        ],
      },
    };
  }

  private findMarker(
    working: RasterImage,
    marker: OmrMarkerSpec,
    pxPerMm: number,
    halfWindowMm: number,
    darkThreshold: number,
    expectedSizePx: number,
  ): DetectedMarker | null {
    const centerX = marker.x * pxPerMm;
    const centerY = marker.y * pxPerMm;
    const halfWindowPx = halfWindowMm * pxPerMm;
    return detectFiducialMarker(
      working.gray,
      working.width,
      working.height,
      {
        x0: centerX - halfWindowPx,
        y0: centerY - halfWindowPx,
        x1: centerX + halfWindowPx,
        y1: centerY + halfWindowPx,
      },
      darkThreshold,
      expectedSizePx,
    );
  }

  private classifyQuestion(
    question: OmrQuestionLayout,
    ratios: number[],
    threshold: number,
  ): OmrRecognizedAnswer {
    if (question.type === QuestionType.MULTIPLE_SELECT) {
      const result = classifyIndependentMarks(ratios, threshold);
      // Symmetric with the exclusive-mark branch below: `detected` is
      // non-null if and only if the classification is 'confident' — 'blank'
      // reports null uniformly across all question types (not `{optionIds:
      // []}`), even though that's ALSO a valid "explicitly chose nothing"
      // response shape — a paper sheet can't distinguish the two, and
      // OmrProcessor only ever reads `detected` for 'confident' anyway.
      const detected =
        result.status === 'confident'
          ? {
              optionIds: question.bubbles
                .filter((_, i) => result.selected[i])
                .filter(isOptionBubble)
                .map((bubble) => bubble.optionId),
            }
          : null;
      return {
        exam_question_id: question.examQuestionId,
        status: result.status,
        confidence: result.confidence,
        detected,
        raw: { fillRatios: ratios, threshold, margin: null },
      };
    }

    const result = classifyExclusiveMark(ratios, threshold);
    let detected: Record<string, unknown> | null = null;
    if (result.status === 'confident' && result.selectedIndex !== null) {
      const bubble = question.bubbles[result.selectedIndex]!;
      detected =
        bubble.kind === 'boolean' ? { value: bubble.value } : { optionId: bubble.optionId };
    }
    return {
      exam_question_id: question.examQuestionId,
      status: result.status,
      confidence: result.confidence,
      detected,
      raw: { fillRatios: ratios, threshold, margin: result.margin },
    };
  }

  private fail(
    outcome: 'invalid_image' | 'template_mismatch' | 'low_quality',
    errorMessage: string,
  ): OmrRecognitionResult {
    return {
      outcome,
      perQuestion: [],
      errorMessage,
      rawMeta: {
        provider: this.name,
        rotationAppliedDegrees: 0,
        qrDecoded: false,
        qrResidualPx: null,
        markerConfidences: [],
      },
    };
  }
}

function corner(marker: OmrMarkerSpec): Point2D {
  return { x: marker.x, y: marker.y };
}

function isOptionBubble(bubble: OmrBubbleSpec): bubble is OmrOptionBubble {
  return bubble.kind === 'option';
}

function averageOf(points: readonly Point2D[]): Point2D {
  return {
    x: points.reduce((s, p) => s + p.x, 0) / points.length,
    y: points.reduce((s, p) => s + p.y, 0) / points.length,
  };
}

/** Global ink/paper threshold from a bounded sample of the image's own luminance distribution. */
function estimateGlobalInkThreshold(gray: Uint8ClampedArray): number {
  const maxSamples = 5000;
  const step = Math.max(1, Math.floor(gray.length / maxSamples));
  const samples: number[] = [];
  for (let i = 0; i < gray.length; i += step) samples.push(gray[i]!);
  const threshold = otsuThreshold(samples);
  // Clamp to a sane ink/paper range so a degenerate (near-uniform) sample never
  // classifies the whole page as entirely dark or entirely light.
  return Math.min(220, Math.max(60, threshold));
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error';
}

// Re-exported so the caller (processor/service) can type QR-decode results without importing
// qr.util.ts directly — keeps the recognition module's public surface in one place.
export type { QrDetection };
