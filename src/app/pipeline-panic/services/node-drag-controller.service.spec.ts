import { TestBed } from '@angular/core/testing';
import { NodeStatus, NodeType, PipelineNode } from '../models/pipeline.model';
import { GAME_CONSTANTS } from '../game-constants';
import { NodeDragControllerService } from './node-drag-controller.service';

function mkNode(x: number, y: number): PipelineNode {
  return {
    id: 'n1',
    type: NodeType.Build,
    name: 'Build',
    x,
    y,
    status: NodeStatus.Idle,
    config: { cpuRequired: 0, memoryRequired: 0, timeEstimate: 0, failureRate: 0, flakiness: 0 },
    processingTime: 0,
    cpuUsage: 0,
    memoryUsage: 0,
    inputs: [],
    outputs: [],
    color: '#000',
    icon: 'BLD',
    particles: [],
    executionCount: 0,
    lastStatus: null,
  };
}

describe('NodeDragControllerService', () => {
  let svc: NodeDragControllerService;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [NodeDragControllerService] });
    svc = TestBed.inject(NodeDragControllerService);
  });

  it('starts in a non-dragging state', () => {
    expect(svc.isDragging()).toBeFalse();
    expect(svc.draggedNode()).toBeNull();
  });

  it('startDrag captures the node and offset', () => {
    const node = mkNode(100, 100);
    svc.startDrag(node, 110, 105);
    expect(svc.isDragging()).toBeTrue();
    expect(svc.draggedNode()).toBe(node);
  });

  it('dragTo snaps to the grid (default 20px)', () => {
    const node = mkNode(100, 100);
    svc.startDrag(node, 100, 100); // offset 0,0
    svc.dragTo(213, 217, 1000, 1000);
    expect(node.x).toBe(220); // 213 → snap to 220
    expect(node.y).toBe(220); // 217 → snap to 220
  });

  it('dragTo respects a custom grid size', () => {
    const node = mkNode(100, 100);
    svc.setGridSize(50);
    svc.startDrag(node, 100, 100);
    svc.dragTo(160, 160, 1000, 1000);
    expect(node.x).toBe(150); // snap to 50
    expect(node.y).toBe(150);
  });

  it('dragTo clamps to canvas bounds (left/top)', () => {
    const node = mkNode(100, 100);
    svc.startDrag(node, 100, 100);
    svc.dragTo(-9999, -9999, 1000, 1000);
    const r = GAME_CONSTANTS.NODE_RADIUS;
    expect(node.x).toBe(r);
    expect(node.y).toBe(r);
  });

  it('dragTo clamps to canvas bounds (right/bottom)', () => {
    const node = mkNode(100, 100);
    svc.startDrag(node, 100, 100);
    svc.dragTo(99999, 99999, 500, 400);
    const r = GAME_CONSTANTS.NODE_RADIUS;
    expect(node.x).toBe(500 - r);
    expect(node.y).toBe(400 - r);
  });

  it('endDrag returns a DragMoveRecord when the node actually moved', () => {
    const node = mkNode(100, 100);
    svc.startDrag(node, 100, 100);
    svc.dragTo(220, 220, 1000, 1000);

    const record = svc.endDrag();
    expect(record).not.toBeNull();
    expect(record).toEqual(
      jasmine.objectContaining({
        node,
        fromX: 100,
        fromY: 100,
        toX: 220,
        toY: 220,
      })
    );

    // State must be reset after endDrag
    expect(svc.isDragging()).toBeFalse();
    expect(svc.draggedNode()).toBeNull();
  });

  it('endDrag returns null when the node ended at its starting position', () => {
    const node = mkNode(100, 100);
    svc.startDrag(node, 110, 105);
    // No dragTo call — ends at original position
    expect(svc.endDrag()).toBeNull();
    expect(svc.isDragging()).toBeFalse();
  });

  it('endDrag returns null when no drag was in progress', () => {
    expect(svc.endDrag()).toBeNull();
  });

  it('cancel resets state without returning a record', () => {
    const node = mkNode(100, 100);
    svc.startDrag(node, 100, 100);
    svc.cancel();
    expect(svc.isDragging()).toBeFalse();
    expect(svc.draggedNode()).toBeNull();
  });

  it('dragTo is a no-op when no drag is in progress', () => {
    const node = mkNode(100, 100);
    svc.dragTo(500, 500, 1000, 1000);
    expect(node.x).toBe(100);
    expect(node.y).toBe(100);
  });
});
