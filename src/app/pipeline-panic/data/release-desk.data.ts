import { Level } from '../models/game-state.model';
import { NodeType } from '../models/pipeline.model';

/** The one clock the Release Desk asks the operator to judge. */
export const RELEASE_WINDOW_SECONDS = 12;
export const RELEASE_DESK_ID = 'release-window';

/**
 * The only player-facing scenario.
 *
 * Additional tickets are conditions and authored routes within this shift, not
 * entries in a score-driven level catalogue. Keeping one exported object makes
 * it impossible for a stale campaign level to become reachable by index.
 */
export const RELEASE_DESK: Level = {
  id: RELEASE_DESK_ID,
  name: 'The Release Window',
  description: `Call whether a known-good release clears ${RELEASE_WINDOW_SECONDS} seconds`,
  requiredNodes: [
    NodeType.Source,
    NodeType.Build,
    NodeType.Test,
    NodeType.SecurityScan,
    NodeType.Parallel,
    NodeType.Deploy,
  ],
  maxNodes: 10,
  maxConnections: 12,
  cpuLimit: 200,
  memoryLimit: 2000,
  prototypeRules: {
    deterministic: true,
    conditionCards: [{ id: 'agent-pool-1', agentPoolLimit: 1 }],
    dependencyGate: {
      targetType: NodeType.Deploy,
      requiredUpstreamTypes: [NodeType.Build, NodeType.Test, NodeType.SecurityScan, NodeType.Parallel],
    },
  },
  parTime: RELEASE_WINDOW_SECONDS,
};

/** The component mutates the active condition, so every shift gets a fresh copy. */
export function createReleaseDesk(): Level {
  return {
    ...RELEASE_DESK,
    requiredNodes: [...RELEASE_DESK.requiredNodes],
    prototypeRules: RELEASE_DESK.prototypeRules
      ? {
          ...RELEASE_DESK.prototypeRules,
          conditionCards: [...(RELEASE_DESK.prototypeRules.conditionCards ?? [])],
          dependencyGate: RELEASE_DESK.prototypeRules.dependencyGate
            ? {
                ...RELEASE_DESK.prototypeRules.dependencyGate,
                requiredUpstreamTypes: [...RELEASE_DESK.prototypeRules.dependencyGate.requiredUpstreamTypes],
              }
            : undefined,
        }
      : undefined,
  };
}
