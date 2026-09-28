import { TestBed } from '@angular/core/testing';
import { NodeType } from '../models/pipeline.model';
import { RELEASE_DESK_ID } from '../data/release-desk.data';
import { GameEngineService } from './game-engine.service';

describe('GameEngineService', () => {
  let service: GameEngineService;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [GameEngineService] });
    service = TestBed.inject(GameEngineService);
  });

  it('loads only the authored release desk', () => {
    const levels = service.loadLevels();

    expect(levels.length).toBe(1);
    expect(levels[0].id).toBe(RELEASE_DESK_ID);
    expect(levels[0].prototypeRules?.deterministic).toBeTrue();
  });

  it('loads the stages needed for the two-ticket judgment loop', () => {
    const [desk] = service.loadLevels();

    expect(desk.requiredNodes).toEqual([
      NodeType.Source,
      NodeType.Build,
      NodeType.Test,
      NodeType.SecurityScan,
      NodeType.Parallel,
      NodeType.Deploy,
    ]);
    expect(desk.prototypeRules?.conditionCards?.map((card) => card.id)).toEqual(['agent-pool-1']);
  });

  it('returns independent mutable desk data on each load', () => {
    const [first] = service.loadLevels();
    first.requiredNodes.pop();

    const [second] = service.loadLevels();
    expect(second.requiredNodes).toContain(NodeType.Deploy);
    expect(second.prototypeRules?.conditionCards?.length).toBe(1);
    expect(second.prototypeRules?.conditionCards).not.toBe(first.prototypeRules?.conditionCards);
  });
});
