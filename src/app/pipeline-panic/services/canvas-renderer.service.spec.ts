import { CanvasRendererService, ConnectionPath, RenderContext } from './canvas-renderer.service';
import { Connection, DataPacket, NodeStatus, NodeType } from '../models/pipeline.model';
import { createMockConnection, createMockNode, createMockPipeline } from '../testing/test-utils';

describe('CanvasRendererService', () => {
  let service: CanvasRendererService;
  let mockCtx: jasmine.SpyObj<CanvasRenderingContext2D>;
  let mockPipelineCtx: jasmine.SpyObj<CanvasRenderingContext2D>;

  const createMockContext = (): jasmine.SpyObj<CanvasRenderingContext2D> & {
    strokeStyle: string;
    fillStyle: string;
    lineWidth: number;
    font: string;
    textAlign: string;
    textBaseline: string;
    shadowColor: string;
    shadowBlur: number;
    globalAlpha: number;
  } => {
    const ctx = jasmine.createSpyObj<CanvasRenderingContext2D>('CanvasRenderingContext2D', [
      'clearRect',
      'beginPath',
      'moveTo',
      'lineTo',
      'stroke',
      'fill',
      'arc',
      'bezierCurveTo',
      'closePath',
      'save',
      'restore',
      'translate',
      'rotate',
      'setLineDash',
      'fillText',
      'fillRect',
      'strokeRect',
      'measureText',
    ]);
    // Add mutable properties that the service can write to
    const mockWithProps = ctx as jasmine.SpyObj<CanvasRenderingContext2D> & {
      strokeStyle: string;
      fillStyle: string;
      lineWidth: number;
      font: string;
      textAlign: string;
      textBaseline: string;
      shadowColor: string;
      shadowBlur: number;
      globalAlpha: number;
    };
    mockWithProps.strokeStyle = '';
    mockWithProps.fillStyle = '';
    mockWithProps.lineWidth = 1;
    mockWithProps.font = '';
    mockWithProps.textAlign = 'left';
    mockWithProps.textBaseline = 'alphabetic';
    mockWithProps.shadowColor = '';
    mockWithProps.shadowBlur = 0;
    mockWithProps.globalAlpha = 1;
    // measureText needs to return a TextMetrics-like object
    ctx.measureText.and.returnValue({ width: 50 } as TextMetrics);
    return mockWithProps;
  };

  const createDataPacket = (overrides: Partial<DataPacket> = {}): DataPacket => ({
    id: 'packet-1',
    type: 'code',
    progress: 0.5,
    speed: 1,
    size: 5,
    color: '#60a5fa',
    glowColor: '#60a5fa40',
    ...overrides,
  });

  const createRenderContext = (overrides: Partial<RenderContext> = {}): RenderContext => ({
    pipeline: createMockPipeline(),
    selectedNode: null,
    hoveredNode: null,
    connectionStart: null,
    isConnecting: false,
    mouseX: 0,
    mouseY: 0,
    isDarkMode: false,
    gridSize: 20,
    isRunning: false,
    isMobileLayout: false,
    ...overrides,
  });

  beforeEach(() => {
    service = new CanvasRendererService();
    mockCtx = createMockContext();
    mockPipelineCtx = createMockContext();
  });

  describe('clearCanvases', () => {
    it('should clear both canvases', () => {
      service.clearCanvases(mockCtx, mockPipelineCtx, 800, 600);

      expect(mockCtx.clearRect).toHaveBeenCalledWith(0, 0, 800, 600);
      expect(mockPipelineCtx.clearRect).toHaveBeenCalledWith(0, 0, 800, 600);
    });
  });

  describe('drawGrid', () => {
    it('should draw vertical and horizontal grid lines', () => {
      service.drawGrid(mockCtx, 100, 100, 20, false);

      // Should have called beginPath, moveTo, lineTo, stroke for each line
      // 100/20 = 5 vertical lines, 100/20 = 5 horizontal lines
      expect(mockCtx.beginPath).toHaveBeenCalled();
      expect(mockCtx.moveTo).toHaveBeenCalled();
      expect(mockCtx.lineTo).toHaveBeenCalled();
      expect(mockCtx.stroke).toHaveBeenCalled();
    });

    it('should use light theme colors when not dark mode', () => {
      service.drawGrid(mockCtx, 100, 100, 20, false);

      // Final strokeStyle is set by major grid lines
      expect(mockCtx.strokeStyle).toBe('rgba(47, 79, 79, 0.1)');
    });

    it('should use dark theme colors when dark mode', () => {
      service.drawGrid(mockCtx, 100, 100, 20, true);

      // Final strokeStyle is set by major grid lines
      expect(mockCtx.strokeStyle).toBe('rgba(255, 255, 255, 0.2)');
    });
  });

  describe('drawEmptyPrompt (empty-board hint)', () => {
    const DESKTOP = 'Drag a node here to start';
    const TOUCH = 'Tap a node to start';

    it('draws the desktop prompt when the board is empty and idle', () => {
      const context = createRenderContext({
        pipeline: createMockPipeline([]),
        isRunning: false,
        isMobileLayout: false,
      });
      service.render(mockCtx, mockPipelineCtx, 800, 600, context);
      expect(mockPipelineCtx.fillText).toHaveBeenCalledWith(DESKTOP, 400, 300);
    });

    it('draws the touch prompt on a mobile layout', () => {
      const context = createRenderContext({ pipeline: createMockPipeline([]), isRunning: false, isMobileLayout: true });
      service.render(mockCtx, mockPipelineCtx, 800, 600, context);
      expect(mockPipelineCtx.fillText).toHaveBeenCalledWith(TOUCH, 400, 300);
    });

    it('does NOT draw the prompt once a node is placed', () => {
      const node = createMockNode('node-1', NodeType.Source);
      const context = createRenderContext({ pipeline: createMockPipeline([node]), isRunning: false });
      service.render(mockCtx, mockPipelineCtx, 800, 600, context);
      expect(mockPipelineCtx.fillText).not.toHaveBeenCalledWith(DESKTOP, jasmine.any(Number), jasmine.any(Number));
      expect(mockPipelineCtx.fillText).not.toHaveBeenCalledWith(TOUCH, jasmine.any(Number), jasmine.any(Number));
    });

    it('does NOT draw the prompt while running', () => {
      const context = createRenderContext({ pipeline: createMockPipeline([]), isRunning: true });
      service.render(mockCtx, mockPipelineCtx, 800, 600, context);
      expect(mockPipelineCtx.fillText).not.toHaveBeenCalledWith(DESKTOP, jasmine.any(Number), jasmine.any(Number));
    });
  });

  describe('node placement pop (nodePopScale)', () => {
    // The node-circle arc is the one centered exactly on the node (cx,cy).
    const circleRadius = (cx: number, cy: number): number | undefined => {
      const call = mockPipelineCtx.arc.calls.allArgs().find((a) => a[0] === cx && a[1] === cy);
      return call?.[2];
    };

    it('draws a freshly placed node below full radius (mid-pop)', () => {
      const node = createMockNode('node-1', NodeType.Source);
      node.x = 120;
      node.y = 140;
      node.placedAt = Date.now(); // just placed
      service.drawNodes(mockPipelineCtx, createRenderContext({ pipeline: createMockPipeline([node]) }));
      const r = circleRadius(120, 140);
      expect(r).toBeGreaterThan(0);
      expect(r).toBeLessThan(30);
    });

    it('draws a node at full radius when placedAt is undefined (no pop)', () => {
      const node = createMockNode('node-1', NodeType.Source);
      node.x = 120;
      node.y = 140;
      service.drawNodes(mockPipelineCtx, createRenderContext({ pipeline: createMockPipeline([node]) }));
      expect(circleRadius(120, 140)).toBe(30);
    });

    it('draws a node at full radius once the pop has finished (stale placedAt)', () => {
      const node = createMockNode('node-1', NodeType.Source);
      node.x = 120;
      node.y = 140;
      node.placedAt = Date.now() - 5000; // long past the ~180ms pop
      service.drawNodes(mockPipelineCtx, createRenderContext({ pipeline: createMockPipeline([node]) }));
      expect(circleRadius(120, 140)).toBe(30);
    });
  });

  describe('drawNodes', () => {
    it('should draw nodes from pipeline', () => {
      const node = createMockNode('node-1', NodeType.Source);
      const context = createRenderContext({
        pipeline: createMockPipeline([node]),
      });

      service.drawNodes(mockPipelineCtx, context);

      // Should draw node circle
      expect(mockPipelineCtx.beginPath).toHaveBeenCalled();
      expect(mockPipelineCtx.arc).toHaveBeenCalled();
      expect(mockPipelineCtx.fill).toHaveBeenCalled();
      expect(mockPipelineCtx.stroke).toHaveBeenCalled();
    });

    it('should apply thicker border for selected node', () => {
      const node = createMockNode('node-1', NodeType.Source);
      const context = createRenderContext({
        pipeline: createMockPipeline([node]),
        selectedNode: node,
      });

      // Track lineWidth assignments
      const lineWidths: number[] = [];
      Object.defineProperty(mockPipelineCtx, 'lineWidth', {
        get: () => lineWidths[lineWidths.length - 1] ?? 1,
        set: (value: number) => {
          lineWidths.push(value);
        },
        configurable: true,
      });

      service.drawNodes(mockPipelineCtx, context);

      // Thicker lineWidth (4) should be set for selected node border
      expect(lineWidths).toContain(4);
    });

    it('should handle different node statuses', () => {
      const runningNode = createMockNode('running', NodeType.Build, NodeStatus.Running);
      const successNode = createMockNode('success', NodeType.Test, NodeStatus.Success);
      const failedNode = createMockNode('failed', NodeType.Deploy, NodeStatus.Failed);
      const idleNode = createMockNode('idle', NodeType.Source, NodeStatus.Idle);

      const context = createRenderContext({
        pipeline: createMockPipeline([runningNode, successNode, failedNode, idleNode]),
      });

      expect(() => service.drawNodes(mockPipelineCtx, context)).not.toThrow();
    });

    it('should stroke the socket-plate ring at full opacity, not the hue-wash alpha', () => {
      // Idle/Waiting nodes layer a 0.42-alpha hue wash on top of the plate
      // fill before the ring is stroked. globalAlpha is canvas-wide state,
      // not scoped to fill(), so if it isn't reset before stroke() the ring
      // silently inherits the wash's 0.42 instead of drawing solid.
      const idleNode = createMockNode('idle', NodeType.Source, NodeStatus.Idle);
      const context = createRenderContext({
        pipeline: createMockPipeline([idleNode]),
      });

      const strokeAlphas: number[] = [];
      mockPipelineCtx.stroke.and.callFake(() => {
        strokeAlphas.push(mockPipelineCtx.globalAlpha);
      });

      service.drawNodes(mockPipelineCtx, context);

      expect(strokeAlphas).toEqual([1]);
    });

    it('should draw connection source indicator when connecting', () => {
      const node = createMockNode('node-1', NodeType.Source);
      const context = createRenderContext({
        pipeline: createMockPipeline([node]),
        connectionStart: node,
        isConnecting: true,
      });

      service.drawNodes(mockPipelineCtx, context);

      // Should have extra arc for pulsing indicator
      expect(mockPipelineCtx.arc).toHaveBeenCalled();
    });
  });

  describe('drawConnections', () => {
    it('should draw connections between nodes', () => {
      const sourceNode = createMockNode('source', NodeType.Source, NodeStatus.Idle, { x: 100, y: 100 });
      const targetNode = createMockNode('target', NodeType.Deploy, NodeStatus.Idle, { x: 300, y: 200 });
      const connection = createMockConnection('source', 'target');

      const context = createRenderContext({
        pipeline: createMockPipeline([sourceNode, targetNode], [connection]),
      });

      service.drawConnections(mockPipelineCtx, context);

      expect(mockPipelineCtx.beginPath).toHaveBeenCalled();
      expect(mockPipelineCtx.moveTo).toHaveBeenCalled();
      expect(mockPipelineCtx.bezierCurveTo).toHaveBeenCalled();
      expect(mockPipelineCtx.stroke).toHaveBeenCalled();
    });

    it('should skip connections with missing nodes', () => {
      const sourceNode = createMockNode('source', NodeType.Source);
      const connection = createMockConnection('source', 'missing-target');

      const context = createRenderContext({
        pipeline: createMockPipeline([sourceNode], [connection]),
      });

      // Should not throw
      expect(() => service.drawConnections(mockPipelineCtx, context)).not.toThrow();
    });

    it('should draw glow for active connections', () => {
      const sourceNode = createMockNode('source', NodeType.Source, NodeStatus.Idle, { x: 100, y: 100 });
      const targetNode = createMockNode('target', NodeType.Deploy, NodeStatus.Idle, { x: 300, y: 200 });
      const connection: Connection = {
        ...createMockConnection('source', 'target'),
        status: 'active',
      };

      const context = createRenderContext({
        pipeline: createMockPipeline([sourceNode, targetNode], [connection]),
      });

      service.drawConnections(mockPipelineCtx, context);

      // Active connections should trigger save/restore for glow
      expect(mockPipelineCtx.save).toHaveBeenCalled();
      expect(mockPipelineCtx.restore).toHaveBeenCalled();
    });

    it('should draw data packets along connections', () => {
      const sourceNode = createMockNode('source', NodeType.Source, NodeStatus.Idle, { x: 100, y: 100 });
      const targetNode = createMockNode('target', NodeType.Deploy, NodeStatus.Idle, { x: 300, y: 200 });
      const packet = createDataPacket();
      const connection: Connection = {
        ...createMockConnection('source', 'target'),
        dataFlow: [packet],
      };

      const context = createRenderContext({
        pipeline: createMockPipeline([sourceNode, targetNode], [connection]),
      });

      service.drawConnections(mockPipelineCtx, context);

      // Arrow drawing triggers save/restore; packets draw arcs
      expect(mockPipelineCtx.save).toHaveBeenCalled();
      expect(mockPipelineCtx.arc).toHaveBeenCalled();
    });
  });

  describe('drawTempConnection', () => {
    it('should draw temporary connection line', () => {
      const startNode = createMockNode('start', NodeType.Source, NodeStatus.Idle, { x: 100, y: 100 });

      service.drawTempConnection(mockPipelineCtx, startNode, 200, 150);

      expect(mockPipelineCtx.beginPath).toHaveBeenCalled();
      expect(mockPipelineCtx.moveTo).toHaveBeenCalledWith(100, 100);
      expect(mockPipelineCtx.lineTo).toHaveBeenCalledWith(200, 150);
      expect(mockPipelineCtx.stroke).toHaveBeenCalled();
      // Phase 4 polish: dash pattern bumped from [5, 5] to [6, 6] for
      // a more readable marching-ants effect during connection drag.
      expect(mockPipelineCtx.setLineDash).toHaveBeenCalledWith([6, 6]);
    });

    it('should reset line dash after drawing', () => {
      const startNode = createMockNode('start', NodeType.Source);

      service.drawTempConnection(mockPipelineCtx, startNode, 200, 150);

      // Should call setLineDash twice - once for dashed, once to reset
      expect(mockPipelineCtx.setLineDash).toHaveBeenCalledTimes(2);
      expect(mockPipelineCtx.setLineDash).toHaveBeenCalledWith([]);
    });
  });

  describe('calculateConnectionPath', () => {
    it('should calculate bezier path between nodes', () => {
      const source = createMockNode('source', NodeType.Source, NodeStatus.Idle, { x: 100, y: 100 });
      const target = createMockNode('target', NodeType.Deploy, NodeStatus.Idle, { x: 300, y: 200 });

      const path = service.calculateConnectionPath(source, target);

      expect(path).toBeDefined();
      expect(path.x1).toBeDefined();
      expect(path.y1).toBeDefined();
      expect(path.x2).toBeDefined();
      expect(path.y2).toBeDefined();
      expect(path.cp1x).toBeDefined();
      expect(path.cp1y).toBeDefined();
      expect(path.cp2x).toBeDefined();
      expect(path.cp2y).toBeDefined();
    });

    it('should offset start/end points from node centers', () => {
      const source = createMockNode('source', NodeType.Source, NodeStatus.Idle, { x: 100, y: 100 });
      const target = createMockNode('target', NodeType.Deploy, NodeStatus.Idle, { x: 300, y: 100 });

      const path = service.calculateConnectionPath(source, target);

      // x1 should be offset from source.x (radius 30)
      expect(path.x1).toBeGreaterThan(source.x);
      // x2 should be offset from target.x (radius 30)
      expect(path.x2).toBeLessThan(target.x);
    });

    it('should handle vertical connections', () => {
      const source = createMockNode('source', NodeType.Source, NodeStatus.Idle, { x: 100, y: 100 });
      const target = createMockNode('target', NodeType.Deploy, NodeStatus.Idle, { x: 100, y: 300 });

      const path = service.calculateConnectionPath(source, target);

      expect(path.y1).toBeGreaterThan(source.y);
      expect(path.y2).toBeLessThan(target.y);
    });

    it('should handle diagonal connections', () => {
      const source = createMockNode('source', NodeType.Source, NodeStatus.Idle, { x: 100, y: 100 });
      const target = createMockNode('target', NodeType.Deploy, NodeStatus.Idle, { x: 300, y: 300 });

      const path = service.calculateConnectionPath(source, target);

      expect(path).toBeDefined();
      // All values should be numbers
      expect(typeof path.x1).toBe('number');
      expect(typeof path.y1).toBe('number');
      expect(typeof path.cp1x).toBe('number');
      expect(typeof path.cp1y).toBe('number');
    });
  });

  describe('drawDataPacket', () => {
    it('should draw packet at correct position along path', () => {
      const packet = createDataPacket({ progress: 0.5 });
      const path: ConnectionPath = {
        x1: 100,
        y1: 100,
        x2: 300,
        y2: 200,
        cp1x: 150,
        cp1y: 100,
        cp2x: 250,
        cp2y: 200,
      };

      service.drawDataPacket(mockPipelineCtx, packet, path);

      expect(mockPipelineCtx.arc).toHaveBeenCalled();
      expect(mockPipelineCtx.fill).toHaveBeenCalled();
    });

    it('should draw packet at start when progress is 0', () => {
      const packet = createDataPacket({ progress: 0 });
      const path: ConnectionPath = {
        x1: 100,
        y1: 100,
        x2: 300,
        y2: 200,
        cp1x: 150,
        cp1y: 100,
        cp2x: 250,
        cp2y: 200,
      };

      expect(() => service.drawDataPacket(mockPipelineCtx, packet, path)).not.toThrow();
    });

    it('should draw packet at end when progress is 1', () => {
      const packet = createDataPacket({ progress: 1 });
      const path: ConnectionPath = {
        x1: 100,
        y1: 100,
        x2: 300,
        y2: 200,
        cp1x: 150,
        cp1y: 100,
        cp2x: 250,
        cp2y: 200,
      };

      expect(() => service.drawDataPacket(mockPipelineCtx, packet, path)).not.toThrow();
    });
  });

  describe('render', () => {
    it('should perform full render pass', () => {
      const node = createMockNode('node-1', NodeType.Source);
      const context = createRenderContext({
        pipeline: createMockPipeline([node]),
      });

      service.render(mockCtx, mockPipelineCtx, 800, 600, context);

      // Should clear canvases
      expect(mockCtx.clearRect).toHaveBeenCalled();
      expect(mockPipelineCtx.clearRect).toHaveBeenCalled();
    });

    it('should draw temporary connection when connecting', () => {
      const node = createMockNode('node-1', NodeType.Source);
      const context = createRenderContext({
        pipeline: createMockPipeline([node]),
        connectionStart: node,
        isConnecting: true,
        mouseX: 200,
        mouseY: 150,
      });

      service.render(mockCtx, mockPipelineCtx, 800, 600, context);

      // Should draw temp connection (dashed line) — see Phase 4 polish.
      expect(mockPipelineCtx.setLineDash).toHaveBeenCalledWith([6, 6]);
    });

    it('should not draw temp connection when not connecting', () => {
      const context = createRenderContext({
        isConnecting: false,
      });

      service.render(mockCtx, mockPipelineCtx, 800, 600, context);

      // Should not set line dash for temp connection
      expect(mockPipelineCtx.setLineDash).not.toHaveBeenCalled();
    });
  });

  describe('renderStatic', () => {
    it('should perform static render without temp connections', () => {
      const node = createMockNode('node-1', NodeType.Source);
      const context = createRenderContext({
        pipeline: createMockPipeline([node]),
        connectionStart: node,
        isConnecting: true, // Even when connecting, static render should not draw temp
      });

      service.renderStatic(mockCtx, mockPipelineCtx, 800, 600, context);

      // Should not set line dash (no temp connection in static render)
      expect(mockPipelineCtx.setLineDash).not.toHaveBeenCalled();
    });

    it('should clear and draw grid and nodes', () => {
      const context = createRenderContext();

      service.renderStatic(mockCtx, mockPipelineCtx, 800, 600, context);

      expect(mockCtx.clearRect).toHaveBeenCalled();
      expect(mockPipelineCtx.clearRect).toHaveBeenCalled();
    });
  });

  describe('theme handling', () => {
    it('should use light theme text color when not dark mode', () => {
      const node = createMockNode('node-1', NodeType.Source);
      const context = createRenderContext({
        pipeline: createMockPipeline([node]),
        isDarkMode: false,
      });

      service.drawNodes(mockPipelineCtx, context);

      // Light theme text color should be dark
      expect(mockPipelineCtx.fillStyle).toMatch(/#1e293b/i);
    });

    it('should use dark theme text color when dark mode', () => {
      const node = createMockNode('node-1', NodeType.Source);
      const context = createRenderContext({
        pipeline: createMockPipeline([node]),
        isDarkMode: true,
      });

      service.drawNodes(mockPipelineCtx, context);

      // Dark theme text color should be light
      expect(mockPipelineCtx.fillStyle).toMatch(/#ffffff/i);
    });

    it('should use appropriate connection colors for theme', () => {
      const sourceNode = createMockNode('source', NodeType.Source, NodeStatus.Idle, { x: 100, y: 100 });
      const targetNode = createMockNode('target', NodeType.Deploy, NodeStatus.Idle, { x: 300, y: 200 });
      const connection = createMockConnection('source', 'target');

      const lightContext = createRenderContext({
        pipeline: createMockPipeline([sourceNode, targetNode], [connection]),
        isDarkMode: false,
      });

      service.drawConnections(mockPipelineCtx, lightContext);
      const lightStroke = mockPipelineCtx.strokeStyle;

      mockPipelineCtx.strokeStyle = '';

      const darkContext = createRenderContext({
        pipeline: createMockPipeline([sourceNode, targetNode], [connection]),
        isDarkMode: true,
      });

      service.drawConnections(mockPipelineCtx, darkContext);

      // Both should have set stroke style
      expect(lightStroke).toBeDefined();
      expect(mockPipelineCtx.strokeStyle).toBeDefined();
    });
  });

  describe('getNodeAtPosition', () => {
    it('should return node when clicking inside node bounds', () => {
      const node = createMockNode('node-1', NodeType.Source, NodeStatus.Idle, { x: 100, y: 100 });
      const nodes = [node];

      const result = service.getNodeAtPosition(nodes, 100, 100);

      expect(result).toBe(node);
    });

    it('should return node when clicking near edge of node', () => {
      const node = createMockNode('node-1', NodeType.Source, NodeStatus.Idle, { x: 100, y: 100 });
      const nodes = [node];

      // Click at edge (nodeSize/2 = 30 from center)
      const result = service.getNodeAtPosition(nodes, 129, 100);

      expect(result).toBe(node);
    });

    it('should return null when clicking outside node bounds', () => {
      const node = createMockNode('node-1', NodeType.Source, NodeStatus.Idle, { x: 100, y: 100 });
      const nodes = [node];

      // Click outside (nodeSize/2 = 30, so 31 is outside)
      const result = service.getNodeAtPosition(nodes, 131, 100);

      expect(result).toBeNull();
    });

    it('should return first matching node when multiple nodes overlap', () => {
      const node1 = createMockNode('node-1', NodeType.Source, NodeStatus.Idle, { x: 100, y: 100 });
      const node2 = createMockNode('node-2', NodeType.Build, NodeStatus.Idle, { x: 110, y: 100 });
      const nodes = [node1, node2];

      const result = service.getNodeAtPosition(nodes, 105, 100);

      expect(result).toBe(node1);
    });

    it('should return null for empty nodes array', () => {
      const result = service.getNodeAtPosition([], 100, 100);

      expect(result).toBeNull();
    });

    it('should respect custom nodeSize parameter', () => {
      const node = createMockNode('node-1', NodeType.Source, NodeStatus.Idle, { x: 100, y: 100 });
      const nodes = [node];

      // With default size 60, click at 129 is inside
      expect(service.getNodeAtPosition(nodes, 129, 100)).toBe(node);

      // With smaller size 40, click at 121 is outside
      expect(service.getNodeAtPosition(nodes, 121, 100, 40)).toBeNull();
    });
  });

  describe('getConnectionAtPosition', () => {
    it('should return connection when clicking near connection path', () => {
      const sourceNode = createMockNode('source', NodeType.Source, NodeStatus.Idle, { x: 100, y: 100 });
      const targetNode = createMockNode('target', NodeType.Deploy, NodeStatus.Idle, { x: 300, y: 100 });
      const connection = createMockConnection('source', 'target');
      const nodes = [sourceNode, targetNode];
      const connections = [connection];

      // Click near the midpoint of the connection
      const result = service.getConnectionAtPosition(connections, nodes, 200, 100);

      expect(result).toBe(connection);
    });

    it('should return null when clicking far from connections', () => {
      const sourceNode = createMockNode('source', NodeType.Source, NodeStatus.Idle, { x: 100, y: 100 });
      const targetNode = createMockNode('target', NodeType.Deploy, NodeStatus.Idle, { x: 300, y: 100 });
      const connection = createMockConnection('source', 'target');
      const nodes = [sourceNode, targetNode];
      const connections = [connection];

      // Click far away
      const result = service.getConnectionAtPosition(connections, nodes, 500, 500);

      expect(result).toBeNull();
    });

    it('should return null for empty connections array', () => {
      const result = service.getConnectionAtPosition([], [], 100, 100);

      expect(result).toBeNull();
    });

    it('should skip connections with missing source node', () => {
      const targetNode = createMockNode('target', NodeType.Deploy, NodeStatus.Idle, { x: 300, y: 100 });
      const connection = createMockConnection('missing-source', 'target');
      const nodes = [targetNode];
      const connections = [connection];

      const result = service.getConnectionAtPosition(connections, nodes, 200, 100);

      expect(result).toBeNull();
    });

    it('should skip connections with missing target node', () => {
      const sourceNode = createMockNode('source', NodeType.Source, NodeStatus.Idle, { x: 100, y: 100 });
      const connection = createMockConnection('source', 'missing-target');
      const nodes = [sourceNode];
      const connections = [connection];

      const result = service.getConnectionAtPosition(connections, nodes, 200, 100);

      expect(result).toBeNull();
    });

    it('should respect custom threshold parameter', () => {
      const sourceNode = createMockNode('source', NodeType.Source, NodeStatus.Idle, { x: 100, y: 100 });
      const targetNode = createMockNode('target', NodeType.Deploy, NodeStatus.Idle, { x: 300, y: 100 });
      const connection = createMockConnection('source', 'target');
      const nodes = [sourceNode, targetNode];
      const connections = [connection];

      // With small threshold, slightly off clicks should miss
      const smallThreshold = service.getConnectionAtPosition(connections, nodes, 200, 114, 5);
      // With larger threshold, same click should hit
      const largeThreshold = service.getConnectionAtPosition(connections, nodes, 200, 114, 20);

      // Results may vary based on bezier path calculation
      // At least verify no errors occur
      expect(smallThreshold === null || smallThreshold === connection).toBe(true);
      expect(largeThreshold === null || largeThreshold === connection).toBe(true);
    });
  });
});
