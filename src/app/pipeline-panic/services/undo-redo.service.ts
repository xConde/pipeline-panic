import { Injectable } from '@angular/core';
import { PipelineCommand } from '../models/command.model';

/**
 * Manages undo/redo stacks using the command pattern.
 * Commands are pushed onto the undo stack when executed,
 * and moved between stacks on undo/redo operations.
 */
@Injectable()
export class UndoRedoService {
  private undoStack: PipelineCommand[] = [];
  private redoStack: PipelineCommand[] = [];
  private readonly maxStackSize = 50;

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get undoCount(): number {
    return this.undoStack.length;
  }

  get redoCount(): number {
    return this.redoStack.length;
  }

  /** Execute a command and push it onto the undo stack. Clears redo stack. */
  execute(command: PipelineCommand): void {
    command.execute();
    this.undoStack.push(command);

    // Enforce max stack size — drop oldest command
    if (this.undoStack.length > this.maxStackSize) {
      this.undoStack.shift();
    }

    // Any new action invalidates the redo history
    this.redoStack.length = 0;
  }

  undo(): void {
    const command = this.undoStack.pop();
    if (!command) return;

    command.undo();
    this.redoStack.push(command);
  }

  redo(): void {
    const command = this.redoStack.pop();
    if (!command) return;

    command.execute();
    this.undoStack.push(command);
  }

  /** Clear both stacks (e.g., on level load or phase change). */
  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}
