/**
 * Bloom's taxonomy cognitive level. Optional metadata on a question, used for
 * curriculum coverage reporting and (later) AI classification.
 */
export enum BloomLevel {
  REMEMBER = 'remember',
  UNDERSTAND = 'understand',
  APPLY = 'apply',
  ANALYZE = 'analyze',
  EVALUATE = 'evaluate',
  CREATE = 'create',
}
