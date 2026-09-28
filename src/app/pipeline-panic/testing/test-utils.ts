/**
 * Pipeline Panic - Shared Test Utilities
 *
 * Provides type-safe mock creation and common test setup patterns
 * to reduce boilerplate and ensure consistency across test files.
 */

import { ComponentFixture } from '@angular/core/testing';
import {
  Connection,
  NodeConfig,
  NodeStatus,
  NodeType,
  Particle,
  Pipeline,
  PipelineNode,
} from '../models/pipeline.model';
import { Resource } from '../models/game-state.model';
import { PipelinePanicComponent } from '../pipeline-panic.component';

// Node visual constants
const NODE_COLORS: Record<NodeType, string> = {
  [NodeType.Source]: '#60a5fa',
  [NodeType.Build]: '#34d399',
  [NodeType.Test]: '#fbbf24',
  [NodeType.Deploy]: '#a78bfa',
  [NodeType.SecurityScan]: '#f87171',
  [NodeType.QualityGate]: '#10b981',
  [NodeType.Rollback]: '#f59e0b',
  [NodeType.Notification]: '#06b6d4',
  [NodeType.Approval]: '#8b5cf6',
  [NodeType.Parallel]: '#f97316',
  [NodeType.Conditional]: '#ec4899',
  [NodeType.Cache]: '#14b8a6',
  [NodeType.Artifact]: '#6366f1',
};

const NODE_ICONS: Record<NodeType, string> = {
  [NodeType.Source]: 'SRC',
  [NodeType.Build]: 'BLD',
  [NodeType.Test]: 'TST',
  [NodeType.Deploy]: 'DPY',
  [NodeType.SecurityScan]: 'SEC',
  [NodeType.QualityGate]: 'QA',
  [NodeType.Rollback]: 'RBK',
  [NodeType.Notification]: 'NTF',
  [NodeType.Approval]: 'APR',
  [NodeType.Parallel]: 'PAR',
  [NodeType.Conditional]: 'IF',
  [NodeType.Cache]: 'CCH',
  [NodeType.Artifact]: 'ART',
};

/**
 * Creates a type-safe mock PipelineNode for testing
 *
 * @param id - Unique identifier for the node
 * @param type - NodeType enum value
 * @param status - NodeStatus enum value (defaults to Idle)
 * @param overrides - Optional partial overrides for any node property
 * @returns Fully typed PipelineNode
 */
export function createMockNode(
  id: string,
  type: NodeType,
  status: NodeStatus = NodeStatus.Idle,
  overrides: Partial<PipelineNode> = {}
): PipelineNode {
  const defaultConfig: NodeConfig = {
    cpuRequired: 10,
    memoryRequired: 100,
    timeEstimate: 5,
    failureRate: 0,
    flakiness: 0,
  };

  return {
    id,
    type,
    name: type.charAt(0).toUpperCase() + type.slice(1),
    x: 0,
    y: 0,
    status,
    config: { ...defaultConfig, ...overrides.config },
    processingTime: 0,
    cpuUsage: 10,
    memoryUsage: 100,
    inputs: [],
    outputs: [],
    color: NODE_COLORS[type] || '#ffffff',
    icon: NODE_ICONS[type] || 'UNK',
    particles: [] as Particle[],
    executionCount: 0,
    lastStatus: null,
    ...overrides,
  };
}

/**
 * Creates a mock connection between two nodes
 */
export function createMockConnection(
  sourceId: string,
  targetId: string,
  overrides: Partial<Connection> = {}
): Connection {
  return {
    id: `conn-${sourceId}-${targetId}`,
    sourceId,
    targetId,
    status: 'inactive',
    dataFlow: [],
    ...overrides,
  };
}

/**
 * Creates a mock pipeline with given nodes
 */
export function createMockPipeline(nodes: PipelineNode[] = [], connections: Connection[] = []): Pipeline {
  return {
    id: 'test-pipeline',
    name: 'Test Pipeline',
    nodes,
    connections,
    totalExecutionTime: 0,
    successRate: 0,
    throughput: 0,
    totalCpuUsed: 0,
    totalMemoryUsed: 0,
    parallelExecutions: 0,
    isValid: nodes.length > 0,
    isRunning: false,
    lastRunStatus: 'success',
    errors: [],
    runAttempt: 0,
  };
}

/**
 * Creates a mock resource object
 */
export function createMockResource(total: number = 100, used: number = 0, cost: number = 1): Resource {
  return {
    total,
    used,
    available: total - used,
    cost,
  };
}

/**
 * Sets up a game component for testing with a specific level loaded
 *
 * @param fixture - Angular component fixture
 * @param levelIndex - Level to load (0-indexed)
 * @returns Component instance with level loaded
 */
export function setupGameComponent(
  fixture: ComponentFixture<PipelinePanicComponent>,
  levelIndex: number = 0
): PipelinePanicComponent {
  const component = fixture.componentInstance;
  component.ngOnInit();
  component.loadLevel(levelIndex);
  return component;
}

/**
 * Creates a simple valid pipeline for testing (Source -> Deploy)
 */
export function createSimplePipeline(): { nodes: PipelineNode[]; connections: Connection[] } {
  const sourceNode = createMockNode('source-1', NodeType.Source, NodeStatus.Idle, {
    outputs: ['deploy-1'],
  });
  const deployNode = createMockNode('deploy-1', NodeType.Deploy, NodeStatus.Idle, {
    inputs: ['source-1'],
  });

  return {
    nodes: [sourceNode, deployNode],
    connections: [createMockConnection('source-1', 'deploy-1')],
  };
}

/**
 * Creates a complete pipeline with all required nodes for Level 2+
 */
export function createCompletePipeline(): { nodes: PipelineNode[]; connections: Connection[] } {
  const source = createMockNode('source-1', NodeType.Source, NodeStatus.Idle, { outputs: ['build-1'] });
  const build = createMockNode('build-1', NodeType.Build, NodeStatus.Idle, {
    inputs: ['source-1'],
    outputs: ['test-1', 'security-1'],
  });
  const test = createMockNode('test-1', NodeType.Test, NodeStatus.Idle, {
    inputs: ['build-1'],
    outputs: ['deploy-1'],
  });
  const security = createMockNode('security-1', NodeType.SecurityScan, NodeStatus.Idle, {
    inputs: ['build-1'],
    outputs: ['deploy-1'],
  });
  const deploy = createMockNode('deploy-1', NodeType.Deploy, NodeStatus.Idle, {
    inputs: ['test-1', 'security-1'],
  });

  return {
    nodes: [source, build, test, security, deploy],
    connections: [
      createMockConnection('source-1', 'build-1'),
      createMockConnection('build-1', 'test-1'),
      createMockConnection('build-1', 'security-1'),
      createMockConnection('test-1', 'deploy-1'),
      createMockConnection('security-1', 'deploy-1'),
    ],
  };
}

/**
 * Type helper to access private methods in tests
 * Usage: getPrivateMethod(component, 'handleNodeSuccess')(node)
 */
export function getPrivateMethod<T, K extends string>(
  instance: T,
  methodName: K
): T extends { [P in K]: infer M } ? M : never {
  return (instance as Record<string, unknown>)[methodName] as never;
}

/**
 * Waits for async operations to complete
 */
export function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
