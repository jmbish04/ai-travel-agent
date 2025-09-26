export type PipelineStageKey =
  | 'guard'
  | 'parse'
  | 'context'
  | 'plan'
  | 'tool'
  | 'web-search'
  | 'compose'
  | 'verify'
  | 'finalize';

export type PipelineStatusUpdate = {
  stage?: PipelineStageKey;
  message?: string;
  meta?: Record<string, unknown>;
};
