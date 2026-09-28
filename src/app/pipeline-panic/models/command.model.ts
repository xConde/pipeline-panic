/**
 * Command pattern interface for undo/redo support.
 * Each command encapsulates a reversible action on the pipeline.
 */
export interface PipelineCommand {
  readonly type: string;
  execute(): void;
  undo(): void;
}
