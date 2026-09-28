import { Injectable } from '@angular/core';
import {
  CANVAS_EMPTY_PROMPT_FONT,
  CANVAS_NODE_HUE_WASH_ALPHA,
  CANVAS_NODE_ICON_FONT,
  CANVAS_NODE_LABEL_FONT,
  CANVAS_NODE_PLATE_FILL_DARK,
  CANVAS_NODE_PLATE_FILL_LIGHT,
} from '../game-constants';
import { Connection, DataPacket, NodeStatus, Pipeline, PipelineNode } from '../models/pipeline.model';

/**
 * Connection path for bezier curve rendering
 */
export interface ConnectionPath {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  cp1x: number;
  cp1y: number;
  cp2x: number;
  cp2y: number;
}

/**
 * Render context containing all state needed for rendering
 */
export interface RenderContext {
  pipeline: Pipeline;
  selectedNode: PipelineNode | null;
  hoveredNode: PipelineNode | null;
  connectionStart: PipelineNode | null;
  isConnecting: boolean;
  mouseX: number;
  mouseY: number;
  isDarkMode: boolean;
  gridSize: number;
  isRunning: boolean;
  /** Width-gated layout flag (matches CSS $breakpoint-mobile) — drives tap vs drag copy. */
  isMobileLayout: boolean;
}

/**
 * CanvasRendererService - Handles all canvas rendering for Pipeline Panic
 *
 * Responsibilities:
 * - Draw grid background
 * - Draw pipeline nodes with status indicators
 * - Draw connections between nodes
 * - Draw temporary connections during connection mode
 * - Draw data packets flowing through connections
 *
 * This service is stateless - all state is passed in via RenderContext.
 * The component owns the canvas contexts and passes them to render methods.
 */
@Injectable()
export class CanvasRendererService {
  /**
   * Clear both canvases
   */
  clearCanvases(
    ctx: CanvasRenderingContext2D,
    pipelineCtx: CanvasRenderingContext2D,
    width: number,
    height: number
  ): void {
    // Clear using the logical dimensions passed in (already accounting for scale)
    ctx.clearRect(0, 0, width, height);
    pipelineCtx.clearRect(0, 0, width, height);
  }

  /**
   * Draw the background grid.
   * Batches all minor lines into a single path and all major lines into
   * another single path to minimise draw calls per frame.
   */
  drawGrid(ctx: CanvasRenderingContext2D, width: number, height: number, gridSize: number, isDarkMode: boolean): void {
    // Fill background first - solid color for contrast
    ctx.fillStyle = isDarkMode ? '#1a1b1e' : '#f5f3f0';
    ctx.fillRect(0, 0, width, height);

    // Minor grid lines — single batched path
    ctx.strokeStyle = isDarkMode ? 'rgba(255, 255, 255, 0.12)' : 'rgba(47, 79, 79, 0.06)';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    for (let x = gridSize; x < width; x += gridSize) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
    }
    for (let y = gridSize; y < height; y += gridSize) {
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
    }
    ctx.stroke();

    // Major grid lines (every 5 cells) — single batched path
    const majorGridSize = gridSize * 5;
    ctx.strokeStyle = isDarkMode ? 'rgba(255, 255, 255, 0.2)' : 'rgba(47, 79, 79, 0.1)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= width; x += majorGridSize) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
    }
    for (let y = 0; y <= height; y += majorGridSize) {
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
    }
    ctx.stroke();
  }

  /**
   * One faint, centered hint when the board is empty and idle, drawn where the player is
   * actually looking. Vanishes the instant the first node lands and
   * never draws during a run. Theme-aware muted color, width-gated tap/drag copy.
   */
  private drawEmptyPrompt(
    pipelineCtx: CanvasRenderingContext2D,
    width: number,
    height: number,
    context: RenderContext
  ): void {
    if (context.isRunning || context.pipeline.nodes.length > 0) return;
    // Avoid directional copy on touch because the shelf may sit above or below the canvas.
    const text = context.isMobileLayout ? 'Tap a node to start' : 'Drag a node here to start';
    pipelineCtx.fillStyle = context.isDarkMode ? 'rgba(255, 255, 255, 0.32)' : 'rgba(47, 79, 79, 0.32)';
    pipelineCtx.font = CANVAS_EMPTY_PROMPT_FONT;
    pipelineCtx.textAlign = 'center';
    pipelineCtx.textBaseline = 'middle';
    pipelineCtx.fillText(text, width / 2, height / 2);
  }

  /**
   * Scale-in "pop" factor for a freshly placed node: 0.6 -> 1.05 (overshoot) -> 1.0 over
   * ~180ms, then rests at 1.0 forever. Allocation/string free (runs per node per frame).
   * Returns 1 (no pop) when placedAt is missing/stale — template restore, undo/redo, old saves.
   */
  private nodePopScale(node: PipelineNode): number {
    if (node.placedAt == null) return 1;
    const POP_MS = 180;
    const t = (Date.now() - node.placedAt) / POP_MS;
    if (t < 0 || t >= 1) return 1; // not started / done / clock skew -> rest size
    if (t < 0.6) {
      const k = t / 0.6; // 0..1 grow phase
      const e = 1 - (1 - k) * (1 - k); // easeOutQuad
      return 0.6 + (1.05 - 0.6) * e;
    }
    const k = (t - 0.6) / 0.4; // 0..1 settle phase
    const e = 1 - (1 - k) * (1 - k);
    return 1.05 + (1.0 - 1.05) * e;
  }

  /**
   * Draw all pipeline nodes
   */
  drawNodes(pipelineCtx: CanvasRenderingContext2D, context: RenderContext): void {
    const textColor = context.isDarkMode ? '#ffffff' : '#1e293b';
    const hoverColor = context.isDarkMode ? '#ffffff' : '#1e293b';

    context.pipeline.nodes.forEach((node) => {
      const isHovered = node === context.hoveredNode;
      const isSelected = node === context.selectedNode;
      const isConnectionSource = context.isConnecting && context.connectionStart?.id === node.id;
      // Highlight nodes that are valid drop targets while the user is
      // dragging out a connection — anything except the source itself.
      const isConnectionTarget = context.isConnecting && isHovered && context.connectionStart?.id !== node.id;

      // Connection mode indicator - pulsing ring around source node
      if (isConnectionSource) {
        this.drawConnectionSourceIndicator(pipelineCtx, node);
      }
      if (isConnectionTarget) {
        this.drawConnectionTargetIndicator(pipelineCtx, node);
      }

      // NO shadow blur - borders-only design approach
      // Selected state shown with thicker border instead

      // Node circle — only the disc scales for the placement pop; icon/label/rings stay put.
      const drawRadius = 30 * this.nodePopScale(node);
      pipelineCtx.beginPath();
      pipelineCtx.arc(node.x, node.y, drawRadius, 0, Math.PI * 2);

      // Fill based on status. Idle/Waiting nodes get the desk-neutral socket
      // plate (applyNodeFill reports true) instead of a saturated status
      // color — a patch-jack face, not a flat colored disc.
      const isSocketPlate = this.applyNodeFill(pipelineCtx, node, context.isDarkMode);
      pipelineCtx.fill();

      // Layer a translucent stage-hue wash over the plate, on the SAME
      // circular path (no extra beginPath/arc — one path, two fills, zero
      // added allocation). This is the bounded "socket" the hue lives in;
      // it deliberately reuses the evidence rail's stage-segment recipe
      // (see CANVAS_NODE_HUE_WASH_ALPHA) so a node and its rail segment
      // below read as the same fitting under the same hue.
      if (isSocketPlate) {
        pipelineCtx.fillStyle = node.color;
        pipelineCtx.globalAlpha = CANVAS_NODE_HUE_WASH_ALPHA;
        pipelineCtx.fill();
        // Reset before the ring stroke below — globalAlpha is canvas-wide
        // state, not scoped to fill(), so without this reset the ring would
        // silently inherit the wash's 0.42 instead of drawing at full
        // strength (the SCSS .rail-stage analog keeps its border-left
        // accent fully opaque while only its background gets the wash).
        pipelineCtx.globalAlpha = 1;
      }

      // Border - thicker when selected for clear visual feedback. On a
      // socket plate this hairline-adjacent ring (unselected/unhovered: 2px
      // solid node.color) IS the bounded hue element the fitting reads by.
      pipelineCtx.strokeStyle = isSelected ? hoverColor : isHovered ? hoverColor : node.color;
      pipelineCtx.lineWidth = isSelected ? 4 : isHovered ? 3 : 2;
      pipelineCtx.stroke();

      // Reset alpha
      pipelineCtx.globalAlpha = 1;

      // Icon - larger, bolder, monospace. Ink-colored on the neutral socket
      // plate (matches the label chip's ink below it, and stays legible
      // against the light hue wash in both themes); white on the saturated
      // status fills (running/success/failed/etc.) for traffic-light
      // contrast, unchanged from before.
      pipelineCtx.font = CANVAS_NODE_ICON_FONT;
      pipelineCtx.textAlign = 'center';
      pipelineCtx.textBaseline = 'middle';
      pipelineCtx.fillStyle = isSocketPlate ? textColor : '#ffffff';
      pipelineCtx.fillText(node.icon, node.x, node.y);

      // Name label - cleaner background with border
      const textMetrics = pipelineCtx.measureText(node.name);
      const textWidth = textMetrics.width;
      const textHeight = 16;
      const padding = 6;

      // Background rectangle — same plate material as the node's own socket.
      pipelineCtx.fillStyle = context.isDarkMode ? CANVAS_NODE_PLATE_FILL_DARK : CANVAS_NODE_PLATE_FILL_LIGHT;
      pipelineCtx.fillRect(
        node.x - textWidth / 2 - padding,
        node.y + 45 - textHeight / 2,
        textWidth + padding * 2,
        textHeight
      );

      // Border around label for definition
      pipelineCtx.strokeStyle = context.isDarkMode ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)';
      pipelineCtx.lineWidth = 0.5;
      pipelineCtx.strokeRect(
        node.x - textWidth / 2 - padding,
        node.y + 45 - textHeight / 2,
        textWidth + padding * 2,
        textHeight
      );

      // Label text - semibold for better readability
      pipelineCtx.font = CANVAS_NODE_LABEL_FONT;
      pipelineCtx.fillStyle = textColor;
      pipelineCtx.fillText(node.name, node.x, node.y + 45);
    });
  }

  /**
   * Draw pulsing indicator around connection source node
   */
  private drawConnectionSourceIndicator(pipelineCtx: CanvasRenderingContext2D, node: PipelineNode): void {
    const pulseSize = 35 + Math.sin(Date.now() / 200) * 5;
    pipelineCtx.beginPath();
    pipelineCtx.arc(node.x, node.y, pulseSize, 0, Math.PI * 2);
    pipelineCtx.strokeStyle = '#60a5fa';
    pipelineCtx.lineWidth = 3;
    pipelineCtx.globalAlpha = 0.6;
    pipelineCtx.stroke();
    pipelineCtx.globalAlpha = 1;
  }

  /**
   * Draw drop-target indicator: a solid ring around the hovered node
   * during connection drag, telling the user "release here to connect".
   */
  private drawConnectionTargetIndicator(pipelineCtx: CanvasRenderingContext2D, node: PipelineNode): void {
    pipelineCtx.beginPath();
    pipelineCtx.arc(node.x, node.y, 38, 0, Math.PI * 2);
    pipelineCtx.strokeStyle = '#10b981'; // accept-green
    pipelineCtx.lineWidth = 3;
    pipelineCtx.globalAlpha = 0.85;
    pipelineCtx.stroke();
    pipelineCtx.globalAlpha = 1;
  }

  /**
   * Apply fill style based on node status. Returns true when this node got
   * the desk-neutral "socket plate" treatment (Idle/Waiting) rather than a
   * saturated status fill, so the caller knows to layer the hue wash on top
   * and pick ink (not white) for the icon text.
   *
   * Status color palette:
   *   Success   = #10b981 (green)
   *   Failed    = #ef4444 (red)
   *   RolledBack = #f97316 (orange-500) — distinct from both; deploy failed
   *                but run recovered. NOT a success.
   *   Retrying  = #f59e0b (amber) — transitional, pulsing
   */
  private applyNodeFill(pipelineCtx: CanvasRenderingContext2D, node: PipelineNode, isDarkMode: boolean): boolean {
    if (node.status === NodeStatus.Running) {
      pipelineCtx.fillStyle = node.color;
      pipelineCtx.globalAlpha = 0.5 + Math.sin(Date.now() / 200) * 0.5;
    } else if (node.status === NodeStatus.Retrying) {
      pipelineCtx.fillStyle = '#f59e0b'; // Amber/orange for retrying
      pipelineCtx.globalAlpha = 0.7 + Math.sin(Date.now() / 300) * 0.3; // Slow pulse
    } else if (node.status === NodeStatus.Success) {
      pipelineCtx.fillStyle = '#10b981';
      pipelineCtx.globalAlpha = 1;
    } else if (node.status === NodeStatus.Failed) {
      pipelineCtx.fillStyle = '#ef4444';
      pipelineCtx.globalAlpha = 1;
    } else if (node.status === NodeStatus.RolledBack) {
      // P2: Orange — deploy failed and rolled back. NOT green (not a success).
      pipelineCtx.fillStyle = '#f97316'; // orange-500
      pipelineCtx.globalAlpha = 1;
    } else if (node.status === NodeStatus.Cancelled) {
      // Cancelled: an upstream node failed or rolled back, so this never ran. Muted grey
      // so the player can see it was stopped, not idle.
      pipelineCtx.fillStyle = '#6b7280'; // gray-500
      pipelineCtx.globalAlpha = 0.55;
    } else if (node.status === NodeStatus.Skipped) {
      // Skipped: a Conditional routed past this branch. Dim slate, clearly "did not run".
      pipelineCtx.fillStyle = '#94a3b8'; // slate-400
      pipelineCtx.globalAlpha = 0.4;
    } else {
      // Idle / Waiting — the socket plate. The stage hue is layered on top
      // by the caller as a translucent wash, not baked into this fill.
      pipelineCtx.fillStyle = isDarkMode ? CANVAS_NODE_PLATE_FILL_DARK : CANVAS_NODE_PLATE_FILL_LIGHT;
      pipelineCtx.globalAlpha = 1;
      return true;
    }
    return false;
  }

  /**
   * Draw all connections between nodes
   */
  drawConnections(pipelineCtx: CanvasRenderingContext2D, context: RenderContext): void {
    const inactiveConnectionColor = context.isDarkMode ? 'rgba(255, 255, 255, 0.3)' : 'rgba(30, 41, 59, 0.4)';

    context.pipeline.connections.forEach((conn) => {
      const source = context.pipeline.nodes.find((n) => n.id === conn.sourceId);
      const target = context.pipeline.nodes.find((n) => n.id === conn.targetId);

      if (!source || !target) return;

      const path = this.calculateConnectionPath(source, target);
      const isActive = conn.status === 'active';

      // Draw glow for active connections
      if (isActive) {
        this.drawConnectionGlow(pipelineCtx, path);
      }

      // Draw connection line. Idle wiring reads as a hairline (matches the
      // evidence rail's .rail-tick weight in styles/_canvas.scss); a run in
      // progress gets the heavier, brighter line so live data flow reads
      // clearly against it.
      pipelineCtx.beginPath();
      pipelineCtx.strokeStyle = isActive ? '#60a5fa' : inactiveConnectionColor;
      pipelineCtx.lineWidth = isActive ? 3 : 1.5;
      pipelineCtx.moveTo(path.x1, path.y1);
      pipelineCtx.bezierCurveTo(path.cp1x, path.cp1y, path.cp2x, path.cp2y, path.x2, path.y2);
      pipelineCtx.stroke();

      // Draw arrow
      this.drawArrow(pipelineCtx, path.x2, path.y2, Math.atan2(path.y2 - path.cp2y, path.x2 - path.cp2x));

      // Draw data packets (no save/restore needed — packets don't modify transform)
      conn.dataFlow.forEach((packet) => {
        this.drawDataPacket(pipelineCtx, packet, path);
      });
    });
  }

  /**
   * Draw glow effect for active connections
   */
  private drawConnectionGlow(pipelineCtx: CanvasRenderingContext2D, path: ConnectionPath): void {
    pipelineCtx.beginPath();
    pipelineCtx.strokeStyle = '#60a5fa20';
    pipelineCtx.lineWidth = 12;
    pipelineCtx.moveTo(path.x1, path.y1);
    pipelineCtx.bezierCurveTo(path.cp1x, path.cp1y, path.cp2x, path.cp2y, path.x2, path.y2);
    pipelineCtx.stroke();

    pipelineCtx.beginPath();
    pipelineCtx.strokeStyle = '#60a5fa40';
    pipelineCtx.lineWidth = 6;
    pipelineCtx.moveTo(path.x1, path.y1);
    pipelineCtx.bezierCurveTo(path.cp1x, path.cp1y, path.cp2x, path.cp2y, path.x2, path.y2);
    pipelineCtx.stroke();
  }

  /**
   * Draw temporary connection line during connection mode.
   *
   * Marching-ants effect: the dash offset advances over time so the
   * line visibly flows from source toward the cursor. The endpoint
   * gets a small filled dot to anchor the visual to the pointer.
   */
  drawTempConnection(
    pipelineCtx: CanvasRenderingContext2D,
    startNode: PipelineNode,
    mouseX: number,
    mouseY: number
  ): void {
    // Flow rate: 60 px/sec drift along the dash pattern.
    const dashOffset = -((Date.now() / 1000) * 60) % 12;

    // Soft outer glow — gives the line presence without box-shadow.
    pipelineCtx.beginPath();
    pipelineCtx.strokeStyle = 'rgba(96, 165, 250, 0.18)';
    pipelineCtx.lineWidth = 8;
    pipelineCtx.lineCap = 'round';
    pipelineCtx.moveTo(startNode.x, startNode.y);
    pipelineCtx.lineTo(mouseX, mouseY);
    pipelineCtx.stroke();

    // Animated dashed line.
    pipelineCtx.beginPath();
    pipelineCtx.strokeStyle = 'rgba(96, 165, 250, 0.95)';
    pipelineCtx.lineWidth = 2.5;
    pipelineCtx.setLineDash([6, 6]);
    pipelineCtx.lineDashOffset = dashOffset;
    pipelineCtx.lineCap = 'round';
    pipelineCtx.moveTo(startNode.x, startNode.y);
    pipelineCtx.lineTo(mouseX, mouseY);
    pipelineCtx.stroke();
    pipelineCtx.setLineDash([]);
    pipelineCtx.lineDashOffset = 0;

    // Endpoint dot at cursor — tells the user where the connection
    // will land if they release now.
    pipelineCtx.beginPath();
    pipelineCtx.fillStyle = 'rgba(96, 165, 250, 0.95)';
    pipelineCtx.arc(mouseX, mouseY, 4, 0, Math.PI * 2);
    pipelineCtx.fill();
  }

  /**
   * Calculate bezier curve path between two nodes
   */
  calculateConnectionPath(source: PipelineNode, target: PipelineNode): ConnectionPath {
    const dx = target.x - source.x;
    const dy = target.y - source.y;

    // Start and end points (edge of circles)
    const angle = Math.atan2(dy, dx);
    const x1 = source.x + Math.cos(angle) * 30;
    const y1 = source.y + Math.sin(angle) * 30;
    const x2 = target.x - Math.cos(angle) * 30;
    const y2 = target.y - Math.sin(angle) * 30;

    // Control points for bezier curve
    const cp1x = x1 + dx * 0.3;
    const cp1y = y1;
    const cp2x = x2 - dx * 0.3;
    const cp2y = y2;

    return { x1, y1, x2, y2, cp1x, cp1y, cp2x, cp2y };
  }

  /**
   * Draw filled arrow at connection end. Filled triangle reads more
   * clearly at small sizes than the previous open V — makes the
   * connection direction immediately obvious without zooming in.
   */
  private drawArrow(pipelineCtx: CanvasRenderingContext2D, x: number, y: number, angle: number): void {
    const arrowSize = 11;
    const arrowWidth = 7;
    pipelineCtx.save();
    pipelineCtx.translate(x, y);
    pipelineCtx.rotate(angle);
    pipelineCtx.beginPath();
    pipelineCtx.moveTo(0, 0);
    pipelineCtx.lineTo(-arrowSize, -arrowWidth / 2);
    pipelineCtx.lineTo(-arrowSize * 0.7, 0);
    pipelineCtx.lineTo(-arrowSize, arrowWidth / 2);
    pipelineCtx.closePath();
    // Inherit current strokeStyle as fill so active connections get the
    // bright blue arrow and idle connections get the muted color.
    pipelineCtx.fillStyle = pipelineCtx.strokeStyle;
    pipelineCtx.fill();
    pipelineCtx.restore();
  }

  /**
   * Draw data packet flowing along connection
   */
  drawDataPacket(pipelineCtx: CanvasRenderingContext2D, packet: DataPacket, path: ConnectionPath): void {
    const t = packet.progress;
    const x = this.bezierPoint(t, path.x1, path.cp1x, path.cp2x, path.x2);
    const y = this.bezierPoint(t, path.y1, path.cp1y, path.cp2y, path.y2);

    // Outer glow via semi-transparent circle
    pipelineCtx.beginPath();
    pipelineCtx.arc(x, y, packet.size * 1.5, 0, Math.PI * 2);
    pipelineCtx.fillStyle = packet.glowColor;
    pipelineCtx.fill();

    // Main packet
    pipelineCtx.beginPath();
    pipelineCtx.arc(x, y, packet.size, 0, Math.PI * 2);
    pipelineCtx.fillStyle = packet.color;
    pipelineCtx.fill();
  }

  /**
   * Calculate point on cubic bezier curve
   */
  private bezierPoint(t: number, p0: number, p1: number, p2: number, p3: number): number {
    return (
      Math.pow(1 - t, 3) * p0 +
      3 * Math.pow(1 - t, 2) * t * p1 +
      3 * (1 - t) * Math.pow(t, 2) * p2 +
      Math.pow(t, 3) * p3
    );
  }

  /**
   * Full render pass - draws everything
   */
  render(
    ctx: CanvasRenderingContext2D,
    pipelineCtx: CanvasRenderingContext2D,
    width: number,
    height: number,
    context: RenderContext
  ): void {
    // Clear canvases
    this.clearCanvases(ctx, pipelineCtx, width, height);

    // Draw grid
    this.drawGrid(ctx, width, height, context.gridSize, context.isDarkMode);

    // Draw connections
    this.drawConnections(pipelineCtx, context);

    // Draw nodes
    this.drawNodes(pipelineCtx, context);

    // Draw temporary connection if in connection mode. Suppress the trailing line while the
    // cursor is outside the canvas (e.g. over the node palette) so it doesn't streak off-board
    // toward the panel — the armed source node stays highlighted to show the pending state.
    const cursorOnCanvas =
      context.mouseX >= 0 && context.mouseX <= width && context.mouseY >= 0 && context.mouseY <= height;
    if (context.isConnecting && context.connectionStart && cursorOnCanvas) {
      this.drawTempConnection(pipelineCtx, context.connectionStart, context.mouseX, context.mouseY);
    }

    this.drawEmptyPrompt(pipelineCtx, width, height, context);
  }

  /**
   * Static render pass - for paused state (no animations)
   */
  renderStatic(
    ctx: CanvasRenderingContext2D,
    pipelineCtx: CanvasRenderingContext2D,
    width: number,
    height: number,
    context: RenderContext
  ): void {
    this.clearCanvases(ctx, pipelineCtx, width, height);
    this.drawGrid(ctx, width, height, context.gridSize, context.isDarkMode);
    this.drawConnections(pipelineCtx, context);
    this.drawNodes(pipelineCtx, context);
    this.drawEmptyPrompt(pipelineCtx, width, height, context);
  }

  // ==================== HIT TESTING ====================

  /**
   * Find the node at the given position
   * @param nodes Array of pipeline nodes to search
   * @param x X coordinate
   * @param y Y coordinate
   * @param nodeSize Size of nodes (default 60)
   * @returns The node at position, or null if none found
   */
  getNodeAtPosition(nodes: PipelineNode[], x: number, y: number, nodeSize: number = 60): PipelineNode | null {
    return (
      nodes.find((node) => {
        return (
          x >= node.x - nodeSize / 2 &&
          x <= node.x + nodeSize / 2 &&
          y >= node.y - nodeSize / 2 &&
          y <= node.y + nodeSize / 2
        );
      }) || null
    );
  }

  /**
   * Find the connection at the given position
   * @param connections Array of connections to search
   * @param nodes Array of nodes for looking up connection endpoints
   * @param x X coordinate
   * @param y Y coordinate
   * @param threshold Distance threshold for hit detection (default 15)
   * @returns The connection at position, or null if none found
   */
  getConnectionAtPosition(
    connections: Connection[],
    nodes: PipelineNode[],
    x: number,
    y: number,
    threshold: number = 15
  ): Connection | null {
    for (const conn of connections) {
      const source = nodes.find((n) => n.id === conn.sourceId);
      const target = nodes.find((n) => n.id === conn.targetId);

      if (!source || !target) continue;

      // Calculate path for hit testing
      const path = this.calculateConnectionPath(source, target);

      // Sample points along the actual bezier curve for reliable hit detection
      for (let t = 0.1; t <= 0.9; t += 0.1) {
        const px = this.bezierPoint(t, path.x1, path.cp1x, path.cp2x, path.x2);
        const py = this.bezierPoint(t, path.y1, path.cp1y, path.cp2y, path.y2);
        const distance = Math.sqrt(Math.pow(x - px, 2) + Math.pow(y - py, 2));
        if (distance < threshold) {
          return conn;
        }
      }
    }

    return null;
  }
}
