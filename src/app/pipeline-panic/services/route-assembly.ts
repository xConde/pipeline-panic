import { Connection, NodeConfig, NodeStatus, NodeType, Pipeline, PipelineNode } from '../models/pipeline.model';
import { hasSupportedNodeTimingConfiguration } from './pipeline-scheduling';

export interface RouteNodeSpecification {
  readonly id: string;
  readonly type: NodeType;
  readonly x: number;
  readonly y: number;
  readonly config: Readonly<NodeConfig>;
  readonly name?: string;
}

export interface RouteConnectionSpecification {
  readonly from: string;
  readonly to: string;
}

export interface RouteSpecification {
  readonly id: string;
  readonly name: string;
  readonly nodes: readonly RouteNodeSpecification[];
  readonly connections: readonly RouteConnectionSpecification[];
}

const NODE_APPEARANCE: Readonly<
  Record<NodeType, { readonly name: string; readonly color: string; readonly icon: string }>
> = {
  [NodeType.Source]: { name: 'Source', color: '#60a5fa', icon: 'SRC' },
  [NodeType.Build]: { name: 'Build', color: '#34d399', icon: 'BLD' },
  [NodeType.Test]: { name: 'Test', color: '#fbbf24', icon: 'TST' },
  [NodeType.Deploy]: { name: 'Deploy', color: '#a78bfa', icon: 'DPY' },
  [NodeType.SecurityScan]: { name: 'Security Scan', color: '#f87171', icon: 'SEC' },
  [NodeType.QualityGate]: { name: 'Quality Gate', color: '#10b981', icon: 'QA' },
  [NodeType.Rollback]: { name: 'Rollback', color: '#f59e0b', icon: 'RBK' },
  [NodeType.Notification]: { name: 'Notification', color: '#06b6d4', icon: 'NTF' },
  [NodeType.Approval]: { name: 'Approval', color: '#8b5cf6', icon: 'APR' },
  [NodeType.Parallel]: { name: 'Parallel', color: '#f97316', icon: 'PAR' },
  [NodeType.Conditional]: { name: 'Conditional', color: '#ec4899', icon: 'IF' },
  [NodeType.Cache]: { name: 'Cache', color: '#14b8a6', icon: 'CCH' },
  [NodeType.Artifact]: { name: 'Artifact', color: '#6366f1', icon: 'ART' },
};

const MAX_ROUTE_COORDINATE = 10_000;

/**
 * Assemble a complete pipeline without time, randomness, services, or UI state.
 * Identical specifications produce structurally identical pipelines. Invalid
 * specifications throw before returning a partial route.
 */
export function assembleRoute(specification: RouteSpecification): Pipeline {
  assertRouteSpecification(specification);

  const nodes: PipelineNode[] = specification.nodes.map((nodeSpec) => {
    const appearance = NODE_APPEARANCE[nodeSpec.type];
    return {
      id: nodeSpec.id,
      type: nodeSpec.type,
      name: nodeSpec.name ?? appearance.name,
      x: nodeSpec.x,
      y: nodeSpec.y,
      status: NodeStatus.Idle,
      config: { ...nodeSpec.config },
      processingTime: 0,
      cpuUsage: nodeSpec.config.cpuRequired,
      memoryUsage: nodeSpec.config.memoryRequired,
      inputs: [],
      outputs: [],
      color: appearance.color,
      icon: appearance.icon,
      particles: [],
      executionCount: 0,
      lastStatus: null,
    };
  });
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const connections: Connection[] = specification.connections.map((connectionSpec, index) => {
    const sourceNode = nodesById.get(connectionSpec.from);
    const targetNode = nodesById.get(connectionSpec.to);
    if (!sourceNode || !targetNode) {
      throw new Error(`Validated route connection disappeared: ${connectionSpec.from} -> ${connectionSpec.to}`);
    }
    sourceNode.outputs.push(connectionSpec.to);
    targetNode.inputs.push(connectionSpec.from);
    return {
      id: `${specification.id}:connection:${index}`,
      sourceId: connectionSpec.from,
      targetId: connectionSpec.to,
      status: 'inactive',
      dataFlow: [],
    };
  });

  return {
    id: specification.id,
    name: specification.name,
    nodes,
    connections,
    totalExecutionTime: 0,
    successRate: 0,
    throughput: 0,
    totalCpuUsed: 0,
    totalMemoryUsed: 0,
    parallelExecutions: 0,
    isValid: true,
    isRunning: false,
    lastRunStatus: 'partial',
    errors: [],
    runAttempt: 0,
  };
}

function assertRouteSpecification(specification: RouteSpecification): void {
  if (!specification.id.trim() || !specification.name.trim()) {
    throw new Error('Route specification requires a non-empty id and name');
  }
  if (specification.nodes.length === 0) {
    throw new Error('Route specification requires at least one node');
  }

  const nodeIds = new Set<string>();
  for (const node of specification.nodes) {
    if (!node.id.trim() || nodeIds.has(node.id)) {
      throw new Error(`Route node id must be unique and non-empty: ${node.id}`);
    }
    if (node.name !== undefined && !node.name.trim()) {
      throw new Error(`Route node ${node.id} requires a non-empty name when one is provided`);
    }
    if (
      !Number.isFinite(node.x) ||
      !Number.isFinite(node.y) ||
      node.x < 0 ||
      node.y < 0 ||
      node.x > MAX_ROUTE_COORDINATE ||
      node.y > MAX_ROUTE_COORDINATE
    ) {
      throw new Error(`Route node ${node.id} has an invalid position`);
    }
    if (
      !Number.isFinite(node.config.cpuRequired) ||
      node.config.cpuRequired < 0 ||
      !Number.isFinite(node.config.memoryRequired) ||
      node.config.memoryRequired < 0 ||
      !Number.isFinite(node.config.timeEstimate) ||
      node.config.timeEstimate <= 0 ||
      !isProbability(node.config.failureRate) ||
      !isProbability(node.config.flakiness) ||
      !hasSupportedNodeTimingConfiguration(node.type, node.config) ||
      (node.config.retryCount !== undefined &&
        (!Number.isSafeInteger(node.config.retryCount) || node.config.retryCount < 0)) ||
      (node.config.retryDelayMs !== undefined &&
        (!Number.isFinite(node.config.retryDelayMs) || node.config.retryDelayMs < 0))
    ) {
      throw new Error(`Route node ${node.id} has invalid configuration`);
    }
    nodeIds.add(node.id);
  }

  if (!specification.nodes.some((node) => node.type === NodeType.Source)) {
    throw new Error('Route specification requires a Source node');
  }
  if (!specification.nodes.some((node) => node.type === NodeType.Deploy)) {
    throw new Error('Route specification requires a Deploy node');
  }

  const connectionKeys = new Set<string>();
  const outputsById = new Map(specification.nodes.map((node) => [node.id, [] as string[]]));
  const inputsById = new Map(specification.nodes.map((node) => [node.id, [] as string[]]));
  for (const connection of specification.connections) {
    const key = `${connection.from}\u0000${connection.to}`;
    if (
      connection.from === connection.to ||
      !nodeIds.has(connection.from) ||
      !nodeIds.has(connection.to) ||
      connectionKeys.has(key)
    ) {
      throw new Error(`Route connection is invalid: ${connection.from} -> ${connection.to}`);
    }
    const outputs = outputsById.get(connection.from);
    const inputs = inputsById.get(connection.to);
    if (!outputs || !inputs) {
      throw new Error(`Route connection references an unknown node: ${connection.from} -> ${connection.to}`);
    }
    connectionKeys.add(key);
    outputs.push(connection.to);
    inputs.push(connection.from);
  }

  for (const node of specification.nodes) {
    if (node.type === NodeType.Source && (outputsById.get(node.id)?.length ?? 0) === 0) {
      throw new Error(`Source node ${node.id} requires an output`);
    }
    if (node.type === NodeType.Deploy && (inputsById.get(node.id)?.length ?? 0) === 0) {
      throw new Error(`Deploy node ${node.id} requires an input`);
    }
  }

  const reachable = new Set<string>();
  const pending = specification.nodes.filter((node) => node.type === NodeType.Source).map((node) => node.id);
  while (pending.length > 0) {
    const nodeId = pending.shift();
    if (nodeId === undefined || reachable.has(nodeId)) continue;
    reachable.add(nodeId);
    pending.push(...(outputsById.get(nodeId) ?? []));
  }
  if (reachable.size !== specification.nodes.length) {
    throw new Error('Every assembled route node must be reachable from a Source');
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): void => {
    if (visiting.has(nodeId)) throw new Error('Route specification must be acyclic');
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    for (const outputId of outputsById.get(nodeId) ?? []) visit(outputId);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  specification.nodes.forEach((node) => visit(node.id));
}

function isProbability(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}
