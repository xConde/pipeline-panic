import { NodeConfig, NodeType, Pipeline } from '../models/pipeline.model';
import { assembleRoute, RouteConnectionSpecification, RouteNodeSpecification } from '../services/route-assembly';

export type ReleaseRoutePlanId = 'serial' | 'parallel';

export interface ReleaseRoutePlan {
  readonly id: ReleaseRoutePlanId;
  readonly label: string;
  readonly kicker: string;
  readonly description: string;
  readonly topology: string;
  readonly changeLabel: string;
}

export const RELEASE_ROUTE_PLANS: readonly ReleaseRoutePlan[] = [
  {
    id: 'serial',
    label: 'Single-file review',
    kicker: 'Inherited route',
    description: 'Each check waits for the one before it. Easy to audit, expensive on the clock.',
    topology: 'Source → Build → Test → Security → Parallel → Deploy',
    changeLabel: '0 checks overlap',
  },
  {
    id: 'parallel',
    label: 'Split the checks',
    kicker: 'Route change',
    description: 'Test and Security leave the splitter together, then both report to Deploy.',
    topology: 'Source → Build → Parallel → [Test + Security] → Deploy',
    changeLabel: '2 checks overlap',
  },
] as const;

interface RouteViewport {
  readonly width: number;
  readonly height: number;
}

type ConfigFactory = (type: NodeType) => NodeConfig;

const RELEASE_NODE_TYPES: Readonly<Record<string, NodeType>> = {
  source: NodeType.Source,
  build: NodeType.Build,
  test: NodeType.Test,
  scan: NodeType.SecurityScan,
  parallel: NodeType.Parallel,
  deploy: NodeType.Deploy,
};

const RELEASE_NODE_NAMES: Readonly<Record<string, string>> = {
  source: 'Git Source',
  build: 'Build',
  test: 'Test',
  scan: 'Security Scan',
  parallel: 'Parallel',
  deploy: 'Deploy',
};

const SERIAL_CONNECTIONS: readonly RouteConnectionSpecification[] = [
  { from: 'source', to: 'build' },
  { from: 'build', to: 'test' },
  { from: 'test', to: 'scan' },
  { from: 'scan', to: 'parallel' },
  { from: 'parallel', to: 'deploy' },
];

const PARALLEL_CONNECTIONS: readonly RouteConnectionSpecification[] = [
  { from: 'source', to: 'build' },
  { from: 'build', to: 'parallel' },
  { from: 'parallel', to: 'test' },
  { from: 'parallel', to: 'scan' },
  { from: 'test', to: 'deploy' },
  { from: 'scan', to: 'deploy' },
];

/**
 * Deal one of the two authored release routes onto the desk.
 *
 * The route choice is declarative and deterministic. Coordinates are derived
 * from the live canvas only so the same complete route reads cleanly from phone
 * to desktop; schedule behavior never depends on the viewport.
 */
export function assembleReleaseWindowRoute(
  planId: ReleaseRoutePlanId,
  viewport: RouteViewport,
  configFor: ConfigFactory
): Pipeline {
  const plan = RELEASE_ROUTE_PLANS.find((candidate) => candidate.id === planId);
  if (!plan) throw new Error(`Unknown release route plan: ${planId}`);

  const positions = routePositions(planId, viewport);
  const nodes: RouteNodeSpecification[] = Object.entries(RELEASE_NODE_TYPES).map(([id, type]) => ({
    id,
    type,
    name: RELEASE_NODE_NAMES[id],
    x: positions[id].x,
    y: positions[id].y,
    config: configFor(type),
  }));

  return assembleRoute({
    id: `release-window:${planId}`,
    name: plan.label,
    nodes,
    connections: planId === 'serial' ? SERIAL_CONNECTIONS : PARALLEL_CONNECTIONS,
  });
}

/**
 * Does the live graph still have the authored plan's topology?
 *
 * Positions and node settings are deliberately ignored: moving a stage or
 * changing a lever does not turn it into a different route. Extra/missing
 * stages, duplicate stage types, or changed edges do. Keeping this check beside
 * the declarative plans prevents the presentation label from becoming a second
 * source of truth after an expert hand-edit.
 */
export function matchesReleaseWindowRoutePlan(pipeline: Pipeline, planId: ReleaseRoutePlanId): boolean {
  const expectedConnections = planId === 'serial' ? SERIAL_CONNECTIONS : PARALLEL_CONNECTIONS;
  const expectedTypes = Object.values(RELEASE_NODE_TYPES);
  if (pipeline.nodes.length !== expectedTypes.length || pipeline.connections.length !== expectedConnections.length) {
    return false;
  }

  const nodesByType = new Map<NodeType, string>();
  for (const node of pipeline.nodes) {
    if (!expectedTypes.includes(node.type) || nodesByType.has(node.type)) return false;
    nodesByType.set(node.type, node.id);
  }

  const expectedEdges = new Set(
    expectedConnections.map(
      ({ from, to }) =>
        `${nodesByType.get(RELEASE_NODE_TYPES[from]) ?? ''}->${nodesByType.get(RELEASE_NODE_TYPES[to]) ?? ''}`
    )
  );
  return pipeline.connections.every((connection) =>
    expectedEdges.has(`${connection.sourceId}->${connection.targetId}`)
  );
}

function routePositions(
  planId: ReleaseRoutePlanId,
  viewport: RouteViewport
): Readonly<Record<string, { readonly x: number; readonly y: number }>> {
  const width = clamp(viewport.width, 320, 1600);
  const height = clamp(viewport.height, 220, 720);
  const compact = width < 620;

  if (compact) {
    const x = [width * 0.16, width * 0.5, width * 0.84];
    // The bottom row sits high enough that node labels clear the touch-hint
    // strip overlaid on the compact bay canvas.
    const y = [height * 0.24, height * 0.6];
    if (planId === 'serial') {
      return {
        source: { x: x[0], y: y[0] },
        build: { x: x[1], y: y[0] },
        test: { x: x[2], y: y[0] },
        scan: { x: x[2], y: y[1] },
        parallel: { x: x[1], y: y[1] },
        deploy: { x: x[0], y: y[1] },
      };
    }
    return {
      source: { x: x[0], y: y[0] },
      build: { x: x[1], y: y[0] },
      parallel: { x: x[2], y: y[0] },
      test: { x: x[1], y: y[1] },
      scan: { x: x[2], y: y[1] },
      deploy: { x: x[0], y: y[1] },
    };
  }

  const centerY = height * 0.48;
  const branchOffset = Math.min(92, height * 0.24);
  const columns = [width * 0.08, width * 0.25, width * 0.42, width * 0.6, width * 0.77, width * 0.92];
  if (planId === 'serial') {
    return {
      source: { x: columns[0], y: centerY },
      build: { x: columns[1], y: centerY },
      test: { x: columns[2], y: centerY },
      scan: { x: columns[3], y: centerY },
      parallel: { x: columns[4], y: centerY },
      deploy: { x: columns[5], y: centerY },
    };
  }
  return {
    source: { x: columns[0], y: centerY },
    build: { x: columns[1], y: centerY },
    parallel: { x: columns[2], y: centerY },
    test: { x: columns[3], y: centerY - branchOffset },
    scan: { x: columns[3], y: centerY + branchOffset },
    deploy: { x: columns[5], y: centerY },
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}
