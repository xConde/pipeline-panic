import { Injectable } from '@angular/core';
import { NodeStatus, NodeType, Pipeline, PipelineNode } from '../models/pipeline.model';
import { GAME_CONSTANTS } from '../game-constants';

@Injectable()
export class PipelineBuilderService {
  private pipelineCounter = 0;

  constructor() {}

  /** Validate coordinates are finite, non-NaN numbers within reasonable bounds. */
  static isValidCoordinate(x: number, y: number): boolean {
    return Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x <= 10000 && y <= 10000;
  }

  /** Check if a position overlaps with any existing node. Returns the conflicting node or null. */
  isNodeTooClose(x: number, y: number, existingNodes: PipelineNode[], excludeId?: string): PipelineNode | null {
    const minSpacing = GAME_CONSTANTS.MIN_NODE_SPACING;
    for (const node of existingNodes) {
      if (excludeId && node.id === excludeId) continue;
      const dx = node.x - x;
      const dy = node.y - y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance < minSpacing) {
        return node;
      }
    }
    return null;
  }

  /** Extended connection validation with level constraints. */
  canConnectWithConstraints(
    source: PipelineNode,
    target: PipelineNode,
    pipeline: Pipeline,
    maxConnections: number
  ): boolean {
    if (!this.canConnect(source, target)) return false;
    if (pipeline.connections.length >= maxConnections) return false;
    return true;
  }

  createEmptyPipeline(): Pipeline {
    return {
      id: `pipeline-${Date.now()}-${this.pipelineCounter++}`,
      name: 'New Pipeline',
      nodes: [],
      connections: [],
      totalExecutionTime: 0,
      successRate: 0,
      throughput: 0,
      totalCpuUsed: 0,
      totalMemoryUsed: 0,
      parallelExecutions: 0,
      isValid: false,
      isRunning: false,
      lastRunStatus: 'partial',
      errors: [],
      // Execution history for retry-aware logging
      runAttempt: 0,
      lastFailedNodeType: undefined,
    };
  }

  canConnect(source: PipelineNode, target: PipelineNode): boolean {
    // Can't connect to self
    if (source.id === target.id) {
      return false;
    }

    // Check if already connected
    if (source.outputs.includes(target.id)) {
      return false;
    }

    // Check for valid node type connections
    const invalidConnections: [NodeType, NodeType][] = [
      [NodeType.Deploy, NodeType.Source],
      [NodeType.Deploy, NodeType.Build],
      [NodeType.Test, NodeType.Source],
    ];

    for (const [from, to] of invalidConnections) {
      if (source.type === from && target.type === to) {
        return false;
      }
    }

    return true;
  }

  hasCycles(pipeline: Pipeline): boolean {
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    const dfs = (nodeId: string): boolean => {
      visited.add(nodeId);
      recursionStack.add(nodeId);

      const node = pipeline.nodes.find((n) => n.id === nodeId);
      if (!node) return false;

      for (const outputId of node.outputs) {
        if (!visited.has(outputId)) {
          if (dfs(outputId)) {
            return true;
          }
        } else if (recursionStack.has(outputId)) {
          return true;
        }
      }

      recursionStack.delete(nodeId);
      return false;
    };

    for (const node of pipeline.nodes) {
      if (!visited.has(node.id)) {
        if (dfs(node.id)) {
          return true;
        }
      }
    }

    return false;
  }

  validatePipeline(pipeline: Pipeline): boolean {
    pipeline.errors = [];

    // Check for source node
    const hasSource = pipeline.nodes.some((n) => n.type === NodeType.Source);
    if (!hasSource) {
      pipeline.errors.push({
        nodeId: '',
        type: 'config',
        message: 'Pipeline must have at least one source node',
        severity: 'error',
        suggestion: 'Add a Source node to fetch code',
      });
    }

    // Check for deploy node
    const hasDeploy = pipeline.nodes.some((n) => n.type === NodeType.Deploy);
    if (!hasDeploy) {
      pipeline.errors.push({
        nodeId: '',
        type: 'config',
        message: 'Pipeline must have at least one deploy node',
        severity: 'error',
        suggestion: 'Add a Deploy node to complete the pipeline',
      });
    }

    // Check for cycles
    if (this.hasCycles(pipeline)) {
      pipeline.errors.push({
        nodeId: '',
        type: 'connection',
        message: 'Pipeline contains circular dependencies',
        severity: 'error',
        suggestion: 'Remove connections that create loops',
      });
    }

    // Check for critical connection issues (errors that prevent execution)
    for (const node of pipeline.nodes) {
      // Source nodes MUST have outputs - otherwise pipeline can't flow
      if (node.type === NodeType.Source && node.outputs.length === 0) {
        pipeline.errors.push({
          nodeId: node.id,
          type: 'connection',
          message: `${node.name} has no outputs - pipeline cannot flow`,
          severity: 'error',
          suggestion: 'Connect Source to downstream nodes (Build, Test, etc.)',
        });
      }

      // Deploy nodes MUST have inputs - otherwise they never execute
      if (node.type === NodeType.Deploy && node.inputs.length === 0) {
        pipeline.errors.push({
          nodeId: node.id,
          type: 'connection',
          message: `${node.name} has no inputs - will never execute`,
          severity: 'error',
          suggestion: 'Connect upstream nodes (Build, Test, etc.) to Deploy',
        });
      }
    }

    // Check for orphaned nodes (warnings - non-critical)
    for (const node of pipeline.nodes) {
      if (node.type !== NodeType.Source && node.inputs.length === 0) {
        pipeline.errors.push({
          nodeId: node.id,
          type: 'connection',
          message: `${node.name} is not connected to any input`,
          severity: 'warning',
          suggestion: 'Connect this node to upstream nodes',
        });
      }

      if (node.type !== NodeType.Deploy && node.outputs.length === 0) {
        pipeline.errors.push({
          nodeId: node.id,
          type: 'connection',
          message: `${node.name} is not connected to any output`,
          severity: 'warning',
          suggestion: 'Connect this node to downstream nodes',
        });
      }
    }

    // Check reachability: every non-source node must be reachable from a source
    if (hasSource && !this.hasCycles(pipeline)) {
      const reachable = this.getReachableNodes(pipeline);
      for (const node of pipeline.nodes) {
        if (node.type !== NodeType.Source && !reachable.has(node.id)) {
          pipeline.errors.push({
            nodeId: node.id,
            type: 'connection',
            message: `${node.name} is not reachable from any Source node`,
            severity: 'warning',
            suggestion: 'Connect this node to the pipeline flow',
          });
        }
      }
    }

    pipeline.isValid = pipeline.errors.filter((e) => e.severity === 'error').length === 0;
    return pipeline.isValid;
  }

  /**
   * Return true when every node of `targetType` transitively depends on at
   * least one node of every required upstream type. This is intentionally a
   * pure topology query: callers decide whether a failed rule is a warning or
   * a hard level constraint.
   */
  hasRequiredUpstreamNodes(pipeline: Pipeline, targetType: NodeType, requiredTypes: NodeType[]): boolean {
    return (
      pipeline.nodes.some((node) => node.type === targetType) &&
      this.getMissingRequiredUpstreamNodeTypes(pipeline, targetType, requiredTypes).length === 0
    );
  }

  /**
   * Name the exact dependency types missing upstream of any target node.
   * Presentation can use this to explain a blocked action beside the action,
   * instead of reducing every topology mistake to "wire a route into Deploy".
   */
  getMissingRequiredUpstreamNodeTypes(pipeline: Pipeline, targetType: NodeType, requiredTypes: NodeType[]): NodeType[] {
    const targetNodes = pipeline.nodes.filter((node) => node.type === targetType);
    if (targetNodes.length === 0) return [...requiredTypes];

    const missing = new Set<NodeType>();
    for (const targetNode of targetNodes) {
      const upstreamIds = this.getUpstreamNodeIds(pipeline, targetNode);
      for (const requiredType of requiredTypes) {
        const hasType = pipeline.nodes.some((node) => upstreamIds.has(node.id) && node.type === requiredType);
        if (!hasType) missing.add(requiredType);
      }
    }
    return requiredTypes.filter((requiredType) => missing.has(requiredType));
  }

  private getUpstreamNodeIds(pipeline: Pipeline, targetNode: PipelineNode): Set<string> {
    const upstreamIds = new Set<string>();
    const pendingIds = [...targetNode.inputs];

    while (pendingIds.length > 0) {
      const nodeId = pendingIds.pop();
      if (nodeId === undefined || upstreamIds.has(nodeId)) continue;

      upstreamIds.add(nodeId);
      const node = pipeline.nodes.find((candidate) => candidate.id === nodeId);
      if (node) {
        pendingIds.push(...node.inputs);
      }
    }

    return upstreamIds;
  }

  /** Get all node IDs reachable from any source node via outputs. */
  private getReachableNodes(pipeline: Pipeline): Set<string> {
    const reachable = new Set<string>();
    const queue: string[] = [];

    // Start from all source nodes
    for (const node of pipeline.nodes) {
      if (node.type === NodeType.Source) {
        reachable.add(node.id);
        queue.push(node.id);
      }
    }

    // BFS traversal
    while (queue.length > 0) {
      const currentId = queue.shift();
      if (currentId === undefined) break;
      const node = pipeline.nodes.find((n) => n.id === currentId);
      if (!node) continue;

      for (const outputId of node.outputs) {
        if (!reachable.has(outputId)) {
          reachable.add(outputId);
          queue.push(outputId);
        }
      }
    }

    return reachable;
  }

  getExecutionOrder(pipeline: Pipeline): PipelineNode[] {
    const ordered: PipelineNode[] = [];
    const visited = new Set<string>();

    const visit = (nodeId: string): void => {
      if (visited.has(nodeId)) return;

      const node = pipeline.nodes.find((n) => n.id === nodeId);
      if (!node) return;

      // Visit dependencies first
      for (const inputId of node.inputs) {
        visit(inputId);
      }

      visited.add(nodeId);
      ordered.push(node);
    };

    // Visit all nodes to ensure full topological ordering
    for (const node of pipeline.nodes) {
      visit(node.id);
    }

    return ordered;
  }

  resetPipeline(pipeline: Pipeline): void {
    for (const node of pipeline.nodes) {
      node.status = NodeStatus.Idle;
      node.processingTime = 0;
      node.particles = [];

      // RTG (2026-06-23): clear per-run execution history so the runner's
      // `if (node.executionCount === 0)` retry-seed guard re-fires on the NEXT run and
      // re-reads the current config.retryCount. Without this, a Test node that consumed
      // its retries in run 1 silently gets ZERO retries on every Reset-and-rerun while the
      // palette still shows the configured count — silently nullifying the retry mechanic.
      node.executionCount = 0;
      node.retriesRemaining = undefined;
      node.lastStatus = null;
      node.lastFailureReason = undefined;

      // Reset round-robin index for Conditional nodes
      // This ensures consistent behavior across pipeline resets
      if (node.type === NodeType.Conditional && node.config.conditionIndex !== undefined) {
        node.config.conditionIndex = 0;
      }
    }

    for (const connection of pipeline.connections) {
      connection.status = 'inactive';
      connection.dataFlow = [];
    }

    pipeline.isRunning = false;
    pipeline.totalExecutionTime = 0;
  }
}
