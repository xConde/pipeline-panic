import { NodeConfig, NodeType } from '../models/pipeline.model';
import {
  assembleReleaseWindowRoute,
  matchesReleaseWindowRoutePlan,
  RELEASE_ROUTE_PLANS,
} from './release-window-routes';

describe('release window routes', () => {
  const configFor = (type: NodeType): NodeConfig => ({
    cpuRequired: 1,
    memoryRequired: 1,
    timeEstimate: type === NodeType.Parallel ? 0.2 : 1,
    failureRate: 0,
    flakiness: 0,
  });

  it('offers two legible operational structures without timing spoilers', () => {
    expect(RELEASE_ROUTE_PLANS.map((plan) => plan.id)).toEqual(['serial', 'parallel']);
    expect(
      RELEASE_ROUTE_PLANS.every((plan) => !/\d+(\.\d+)?s\b/.test(`${plan.description} ${plan.topology}`))
    ).toBeTrue();
  });

  it('assembles the inherited serial route as one complete chain', () => {
    const route = assembleReleaseWindowRoute('serial', { width: 1000, height: 360 }, configFor);

    expect(route.nodes.map((node) => node.id)).toEqual(['source', 'build', 'test', 'scan', 'parallel', 'deploy']);
    expect(route.connections.map((connection) => `${connection.sourceId}->${connection.targetId}`)).toEqual([
      'source->build',
      'build->test',
      'test->scan',
      'scan->parallel',
      'parallel->deploy',
    ]);
  });

  it('assembles split checks that both rejoin at Deploy', () => {
    const route = assembleReleaseWindowRoute('parallel', { width: 1000, height: 360 }, configFor);
    const deploy = route.nodes.find((node) => node.type === NodeType.Deploy);
    const splitter = route.nodes.find((node) => node.type === NodeType.Parallel);

    expect(splitter?.outputs).toEqual(['test', 'scan']);
    expect(deploy?.inputs).toEqual(['test', 'scan']);
  });

  it('keeps every dealt node inside compact canvas geometry', () => {
    const width = 360;
    const height = 240;
    for (const plan of RELEASE_ROUTE_PLANS) {
      const route = assembleReleaseWindowRoute(plan.id, { width, height }, configFor);
      expect(route.nodes.every((node) => node.x >= 0 && node.x <= width)).toBeTrue();
      expect(route.nodes.every((node) => node.y >= 0 && node.y <= height)).toBeTrue();
    }
  });

  it('keeps the authored label through position and config edits', () => {
    const route = assembleReleaseWindowRoute('parallel', { width: 1000, height: 360 }, configFor);
    route.nodes[0].x += 80;
    route.nodes[1].config.timeEstimate = 4;

    expect(matchesReleaseWindowRoutePlan(route, 'parallel')).toBeTrue();
  });

  it('rejects an authored label after a topology edit', () => {
    const route = assembleReleaseWindowRoute('serial', { width: 1000, height: 360 }, configFor);
    route.connections[1] = {
      ...route.connections[1],
      targetId: 'scan',
    };

    expect(matchesReleaseWindowRoutePlan(route, 'serial')).toBeFalse();
  });
});
