import { Injectable, signal } from '@angular/core';
import { PipelineNode } from '../models/pipeline.model';
import { GAME_CONSTANTS } from '../game-constants';

/**
 * Result of `endDrag()` when a node was actually dragged. Returned to the
 * caller so they can record an undo command. `null` if no drag was in
 * progress, or if the node ended at its starting position (no-op move).
 */
export interface DragMoveRecord {
  readonly node: PipelineNode;
  readonly fromX: number;
  readonly fromY: number;
  readonly toX: number;
  readonly toY: number;
}

/**
 * Owns the "dragging a node" state machine and the coordinate math that
 * goes with it. Pulls the drag offset / origin / clamping logic out of
 * the parent component's mouse and touch handlers.
 *
 * The parent still owns:
 *  - DOM event listeners (mouseDown / mouseMove / mouseUp / touch*)
 *  - canvas refs and bounding-rect lookups
 *  - hit testing (`getNodeAtPosition`)
 *  - undo/redo recording
 *
 * This service intentionally does NOT own the pipeline or any
 * connection logic — it only manages the geometry of moving one node
 * around the canvas with snap-to-grid + bounds clamping.
 *
 * Component-scoped — provide in the parent component's `providers` array.
 */
@Injectable()
export class NodeDragControllerService {
  private readonly _isDragging = signal(false);
  private readonly _draggedNode = signal<PipelineNode | null>(null);

  /** Read-only signal: whether a drag is currently in progress. */
  readonly isDragging = this._isDragging.asReadonly();

  /** Read-only signal: the node currently being dragged, if any. */
  readonly draggedNode = this._draggedNode.asReadonly();

  /** Default grid step (CSS pixels). Overridden via `gridSize` setter. */
  private gridSize = 20;

  // Internal state captured at drag start.
  private offsetX = 0;
  private offsetY = 0;
  private originX = 0;
  private originY = 0;

  /** Update the snap-to-grid step. Defaults to 20. */
  setGridSize(size: number): void {
    if (size > 0) this.gridSize = size;
  }

  /**
   * Begin dragging `node`. Captures both the original position (for
   * potential undo) and the offset from the pointer to the node center.
   */
  startDrag(node: PipelineNode, pointerX: number, pointerY: number): void {
    this._draggedNode.set(node);
    this._isDragging.set(true);
    this.originX = node.x;
    this.originY = node.y;
    this.offsetX = pointerX - node.x;
    this.offsetY = pointerY - node.y;
  }

  /**
   * Update the dragged node's position to follow the pointer, snapped to
   * the grid and clamped inside the parent canvas bounds. Mutates the
   * node in place so render loops pick up the new coords without an
   * additional event hop.
   *
   * Caller passes `canvasWidth` / `canvasHeight` so the service can
   * stay agnostic of which DOM element backs the canvas.
   */
  dragTo(pointerX: number, pointerY: number, canvasWidth: number, canvasHeight: number): void {
    const node = this._draggedNode();
    if (!node) return;
    const newX = Math.round((pointerX - this.offsetX) / this.gridSize) * this.gridSize;
    const newY = Math.round((pointerY - this.offsetY) / this.gridSize) * this.gridSize;
    const radius = GAME_CONSTANTS.NODE_RADIUS;
    node.x = Math.max(radius, Math.min(canvasWidth - radius, newX));
    node.y = Math.max(radius, Math.min(canvasHeight - radius, newY));
  }

  /**
   * Finalize the drag. Returns a `DragMoveRecord` if the node moved, or
   * `null` if the drag ended at the same coordinates (or no drag was in
   * progress). Either way, internal state is fully reset before this
   * method returns.
   */
  endDrag(): DragMoveRecord | null {
    const node = this._draggedNode();
    const wasDragging = this._isDragging();

    // Always reset state so a future drag starts clean.
    this._draggedNode.set(null);
    this._isDragging.set(false);

    if (!wasDragging || !node) return null;

    const moved = this.originX !== node.x || this.originY !== node.y;
    if (!moved) return null;

    return {
      node,
      fromX: this.originX,
      fromY: this.originY,
      toX: node.x,
      toY: node.y,
    };
  }

  /** Cancel without recording a move. Used on Esc / programmatic abort. */
  cancel(): void {
    this._draggedNode.set(null);
    this._isDragging.set(false);
  }
}
