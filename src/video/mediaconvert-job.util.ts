import type { CreateJobCommandInput } from '@aws-sdk/client-mediaconvert';

/**
 * MediaConvert job for one uploaded lesson video: an adaptive HLS ladder (360p / 540p / 720p,
 * H.264 + AAC, 6 s segments) and a poster frame. Basic tier (single-pass QVBR AVC), which is what
 * the cost model assumes.
 *
 * Outputs (all under s3://<output bucket>/video/<assetId>/):
 *   hls/index.m3u8            master playlist (variants hls/index_360p.m3u8 ...)
 *   thumb/poster.0000000.jpg  poster frame
 */
export interface MediaConvertJobInput {
  assetId: string;
  inputUri: string;
  outputBucket: string;
  roleArn: string;
  queueArn?: string;
}

interface Rung {
  suffix: string;
  width: number;
  height: number;
  maxBitrate: number;
  audioBitrate: number;
}

export const VIDEO_LADDER: readonly Rung[] = [
  { suffix: '_360p', width: 640, height: 360, maxBitrate: 800_000, audioBitrate: 96_000 },
  { suffix: '_540p', width: 960, height: 540, maxBitrate: 1_600_000, audioBitrate: 128_000 },
  { suffix: '_720p', width: 1280, height: 720, maxBitrate: 3_000_000, audioBitrate: 128_000 },
];

export const OUTPUT_PREFIX = (assetId: string): string => `video/${assetId}/`;
export const MASTER_PLAYLIST_PATH = 'hls/index.m3u8';

export function buildMediaConvertJob(input: MediaConvertJobInput): CreateJobCommandInput {
  const base = `s3://${input.outputBucket}/${OUTPUT_PREFIX(input.assetId)}`;

  return {
    Role: input.roleArn,
    ...(input.queueArn !== undefined ? { Queue: input.queueArn } : {}),
    // Job events carry this back, which is how the worker maps an event to its asset.
    UserMetadata: { assetId: input.assetId },
    StatusUpdateInterval: 'SECONDS_60',
    AccelerationSettings: { Mode: 'DISABLED' },
    Settings: {
      TimecodeConfig: { Source: 'ZEROBASED' },
      Inputs: [
        {
          FileInput: input.inputUri,
          TimecodeSource: 'ZEROBASED',
          VideoSelector: {},
          AudioSelectors: { 'Audio Selector 1': { DefaultSelection: 'DEFAULT' } },
        },
      ],
      OutputGroups: [
        {
          Name: 'HLS',
          OutputGroupSettings: {
            Type: 'HLS_GROUP_SETTINGS',
            HlsGroupSettings: {
              Destination: `${base}hls/index`,
              SegmentLength: 6,
              MinSegmentLength: 0,
              ManifestDurationFormat: 'INTEGER',
              DirectoryStructure: 'SINGLE_DIRECTORY',
              ManifestCompression: 'NONE',
              OutputSelection: 'MANIFESTS_AND_SEGMENTS',
              SegmentControl: 'SEGMENTED_FILES',
              StreamInfResolution: 'INCLUDE',
              CodecSpecification: 'RFC_4281',
            },
          },
          Outputs: VIDEO_LADDER.map((rung) => ({
            NameModifier: rung.suffix,
            ContainerSettings: { Container: 'M3U8', M3u8Settings: {} },
            VideoDescription: {
              Width: rung.width,
              Height: rung.height,
              ScalingBehavior: 'DEFAULT',
              CodecSettings: {
                Codec: 'H_264',
                H264Settings: {
                  RateControlMode: 'QVBR',
                  QvbrSettings: { QvbrQualityLevel: 7 },
                  MaxBitrate: rung.maxBitrate,
                  GopSize: 2,
                  GopSizeUnits: 'SECONDS',
                  SceneChangeDetect: 'TRANSITION_DETECTION',
                  CodecProfile: 'MAIN',
                  CodecLevel: 'AUTO',
                },
              },
            },
            AudioDescriptions: [
              {
                AudioSourceName: 'Audio Selector 1',
                CodecSettings: {
                  Codec: 'AAC',
                  AacSettings: {
                    Bitrate: rung.audioBitrate,
                    CodingMode: 'CODING_MODE_2_0',
                    SampleRate: 48_000,
                  },
                },
              },
            ],
          })),
        },
        {
          Name: 'Poster',
          OutputGroupSettings: {
            Type: 'FILE_GROUP_SETTINGS',
            FileGroupSettings: { Destination: `${base}thumb/poster` },
          },
          Outputs: [
            {
              ContainerSettings: { Container: 'RAW' },
              VideoDescription: {
                Width: 1280,
                Height: 720,
                ScalingBehavior: 'DEFAULT',
                CodecSettings: {
                  Codec: 'FRAME_CAPTURE',
                  FrameCaptureSettings: {
                    FramerateNumerator: 1,
                    FramerateDenominator: 10,
                    MaxCaptures: 1,
                    Quality: 80,
                  },
                },
              },
            },
          ],
        },
      ],
    },
  };
}
