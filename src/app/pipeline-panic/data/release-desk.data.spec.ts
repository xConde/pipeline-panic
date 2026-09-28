import { createReleaseDesk, RELEASE_DESK, RELEASE_WINDOW_SECONDS } from './release-desk.data';
import { isControlledPrototype } from '../models/game-state.model';
import { NodeType } from '../models/pipeline.model';

describe('Release Desk data', () => {
  it('exports one deterministic, dependency-gated scenario', () => {
    expect(RELEASE_DESK.id).toBe('release-window');
    expect(RELEASE_DESK.parTime).toBe(RELEASE_WINDOW_SECONDS);
    expect(isControlledPrototype(RELEASE_DESK)).toBeTrue();
    expect(RELEASE_DESK.prototypeRules?.dependencyGate?.targetType).toBe(NodeType.Deploy);
    expect(RELEASE_DESK.prototypeRules?.conditionCards).toEqual([{ id: 'agent-pool-1', agentPoolLimit: 1 }]);
  });

  it('returns independent mutable shift data', () => {
    const first = createReleaseDesk();
    const second = createReleaseDesk();

    first.requiredNodes.pop();
    if (first.prototypeRules) first.prototypeRules.agentPoolLimit = 1;

    expect(second.requiredNodes.length).toBe(RELEASE_DESK.requiredNodes.length);
    expect(second.prototypeRules?.agentPoolLimit).toBeUndefined();
    expect(RELEASE_DESK.requiredNodes).toContain(NodeType.Deploy);
  });
});
