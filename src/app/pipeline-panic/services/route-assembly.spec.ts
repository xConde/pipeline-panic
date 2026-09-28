import { NodeConfig, NodeType } from '../models/pipeline.model';
import { assembleRoute, RouteNodeSpecification, RouteSpecification } from './route-assembly';

describe('assembleRoute', () => {
  const config = (seconds: number): NodeConfig => ({
    cpuRequired: 1,
    memoryRequired: 1,
    timeEstimate: seconds,
    failureRate: 0,
    flakiness: 0,
  });

  function specification(): RouteSpecification {
    return {
      id: 'assembled-release',
      name: 'Assembled Release',
      nodes: [
        { id: 'source', type: NodeType.Source, x: 100, y: 200, config: config(1) },
        {
          id: 'build',
          type: NodeType.Build,
          x: 260,
          y: 200,
          config: { ...config(3), optimizationLevel: 'balanced' },
        },
        { id: 'test', type: NodeType.Test, x: 420, y: 120, config: { ...config(3), coverageThreshold: 75 } },
        { id: 'scan', type: NodeType.SecurityScan, x: 420, y: 280, config: config(4) },
        {
          id: 'deploy',
          type: NodeType.Deploy,
          x: 580,
          y: 200,
          config: { ...config(3), environment: 'dev', strategy: 'rolling' },
        },
      ],
      connections: [
        { from: 'source', to: 'build' },
        { from: 'build', to: 'test' },
        { from: 'build', to: 'scan' },
        { from: 'test', to: 'deploy' },
        { from: 'scan', to: 'deploy' },
      ],
    };
  }

  it('returns the same complete pipeline for the same declarative specification', () => {
    const spec = specification();

    const first = assembleRoute(spec);
    const second = assembleRoute(spec);

    expect(first).toEqual(second);
    expect(first.isValid).toBeTrue();
    expect(first.nodes.map((node) => [node.id, node.x, node.y])).toEqual([
      ['source', 100, 200],
      ['build', 260, 200],
      ['test', 420, 120],
      ['scan', 420, 280],
      ['deploy', 580, 200],
    ]);
    expect(first.nodes.find((node) => node.id === 'deploy')).toEqual(
      jasmine.objectContaining({ inputs: ['test', 'scan'], outputs: [] })
    );
    expect(first.connections.map((connection) => connection.id)).toEqual([
      'assembled-release:connection:0',
      'assembled-release:connection:1',
      'assembled-release:connection:2',
      'assembled-release:connection:3',
      'assembled-release:connection:4',
    ]);
    expect(spec.nodes.every((node) => !('inputs' in node) && !('outputs' in node))).toBeTrue();
  });

  it('rejects a partial, cyclic, dangling, duplicate, or unreachable route', () => {
    const valid = specification();
    const noDeploy: RouteSpecification = {
      ...valid,
      nodes: valid.nodes.filter((node) => node.type !== NodeType.Deploy),
    };
    const cycle: RouteSpecification = {
      ...valid,
      connections: [...valid.connections, { from: 'deploy', to: 'build' }],
    };
    const dangling: RouteSpecification = {
      ...valid,
      connections: [...valid.connections, { from: 'missing', to: 'deploy' }],
    };
    const duplicate: RouteSpecification = { ...valid, nodes: [...valid.nodes, valid.nodes[0]] };
    const unreachable: RouteSpecification = {
      ...valid,
      nodes: [...valid.nodes, { id: 'note', type: NodeType.Notification, x: 700, y: 200, config: config(1) }],
    };

    expect(() => assembleRoute(noDeploy)).toThrowError(/Deploy/);
    expect(() => assembleRoute(cycle)).toThrowError(/acyclic/);
    expect(() => assembleRoute(dangling)).toThrowError(/connection is invalid/);
    expect(() => assembleRoute(duplicate)).toThrowError(/unique/);
    expect(() => assembleRoute(unreachable)).toThrowError(/reachable/);
  });

  it('rejects malformed node boundaries before returning a valid route', () => {
    const valid = specification();
    const source = valid.nodes[0];
    const invalidCases: ReadonlyArray<{ readonly node: RouteNodeSpecification; readonly error: RegExp }> = [
      { node: { ...source, name: '   ' }, error: /non-empty name/ },
      { node: { ...source, x: 10_001 }, error: /invalid position/ },
      {
        node: { ...source, config: { ...source.config, cpuRequired: -1 } },
        error: /invalid configuration/,
      },
      {
        node: { ...source, config: { ...source.config, memoryRequired: -1 } },
        error: /invalid configuration/,
      },
      {
        node: { ...source, config: { ...source.config, failureRate: 1.01 } },
        error: /invalid configuration/,
      },
      {
        node: { ...source, config: { ...source.config, flakiness: -0.01 } },
        error: /invalid configuration/,
      },
      {
        node: { ...source, config: { ...source.config, retryCount: 1.5 } },
        error: /invalid configuration/,
      },
      {
        node: { ...source, config: { ...source.config, retryDelayMs: -1 } },
        error: /invalid configuration/,
      },
    ];

    for (const invalidCase of invalidCases) {
      const invalid: RouteSpecification = {
        ...valid,
        nodes: [invalidCase.node, ...valid.nodes.slice(1)],
      };
      expect(() => assembleRoute(invalid)).toThrowError(invalidCase.error);
    }
  });

  it('rejects malformed timing enums before returning a valid route', () => {
    const invalidCases: ReadonlyArray<{
      readonly type: NodeType;
      readonly property: string;
      readonly value: unknown;
    }> = [
      { type: NodeType.Build, property: 'optimizationLevel', value: 'instant' },
      { type: NodeType.Test, property: 'coverageThreshold', value: 80 },
      { type: NodeType.Deploy, property: 'environment', value: 'qa' },
      { type: NodeType.Deploy, property: 'strategy', value: 'all-at-once' },
    ];

    for (const invalidCase of invalidCases) {
      const valid = specification();
      const targetIndex = valid.nodes.findIndex((node) => node.type === invalidCase.type);
      const target = valid.nodes[targetIndex];
      if (!target) throw new Error(`Missing ${invalidCase.type} test node`);
      const invalidConfig = { ...target.config };
      Object.defineProperty(invalidConfig, invalidCase.property, { value: invalidCase.value });
      const invalid: RouteSpecification = {
        ...valid,
        nodes: valid.nodes.map((node, index) => (index === targetIndex ? { ...target, config: invalidConfig } : node)),
      };

      expect(() => assembleRoute(invalid)).toThrowError(/invalid configuration/);
    }
  });
});
