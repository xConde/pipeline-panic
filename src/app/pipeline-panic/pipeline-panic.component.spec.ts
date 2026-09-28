import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Connection, NodeType } from './models/pipeline.model';
import { PrototypeConditionCard } from './models/game-state.model';
import { AudioService } from './services/audio.service';
import { GameEngineService } from './services/game-engine.service';
import { PipelineBuilderService } from './services/pipeline-builder.service';
import { PipelineRunnerService, RunnerEvent } from './services/pipeline-runner.service';
import { ResourceManagerService } from './services/resource-manager.service';
import { RELEASE_DESK_ID } from './data/release-desk.data';
import { PipelinePanicComponent, RELEASE_DESK_LEVEL_INDEX } from './pipeline-panic.component';

describe('PipelinePanicComponent release desk', () => {
  let fixture: ComponentFixture<PipelinePanicComponent>;
  let component: PipelinePanicComponent;
  let runner: PipelineRunnerService;
  let builder: PipelineBuilderService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [PipelinePanicComponent] }).compileComponents();
    fixture = TestBed.createComponent(PipelinePanicComponent);
    component = fixture.componentInstance;
    runner = fixture.debugElement.injector.get(PipelineRunnerService);
    builder = fixture.debugElement.injector.get(PipelineBuilderService);
    const audio = fixture.debugElement.injector.get(AudioService);
    spyOn(audio, 'initialize');
    spyOn(audio, 'play');
    fixture.detectChanges();
  });

  afterEach(() => fixture.destroy());

  function settle(verdict: 'released' | 'locked', call: 'ships' | 'locks'): void {
    const forecast = component.releaseWindowForecast();
    const actualSeconds = forecast?.durationSeconds ?? (verdict === 'released' ? 10 : 14);
    component.dispatchState.set('resolved');
    component.playerCall.set(call);
    component.releaseWindowOutcome.set({
      verdict,
      predictedSeconds: actualSeconds,
      actualSeconds,
      predictionDeltaSeconds: 0,
      criticalPathLabel: forecast?.criticalPathLabel ?? 'Git Source → Build → Deploy',
      marginSeconds: verdict === 'released' ? 2 : 0,
      requiredReductionSeconds: verdict === 'locked' ? 2 : 0,
    });
    fixture.detectChanges();
  }

  function chooseParallelRouteAndReachTicketTwo(): void {
    settle('locked', 'locks');
    component.selectReleaseRoutePlan('parallel');
    settle('released', 'ships');
    component.takeNextTicket();
    fixture.detectChanges();
  }

  /**
   * Drives a real stamp -> dispatch -> runner-resolution cycle instead of
   * writing releaseWindowOutcome directly the way settle() does. runPipeline
   * is faked the same minimal way the "single dispatch trigger" test does
   * (this suite never spins up the real scheduler timers), but
   * recordReleaseWindowOutcome itself runs for real off a genuine
   * pipeline-complete runner event.
   */
  function dispatchAndResolveForReal(call: 'ships' | 'locks', elapsedSeconds: number, success: boolean): void {
    const forecastAtStart = component.releaseWindowForecast();
    spyOn(component, 'runPipeline').and.callFake(() => {
      (runner as unknown as { _isRunning: boolean })._isRunning = true;
      (component as unknown as { activeReleaseWindowForecast: unknown }).activeReleaseWindowForecast = forecastAtStart;
    });

    component.stampAndDispatch(call);
    component.gameState.elapsedTime = elapsedSeconds;
    (component as unknown as { handleRunnerEvent(event: RunnerEvent): void }).handleRunnerEvent({
      type: 'pipeline-complete',
      result: {
        success,
        missingRequired: false,
        failedCount: 0,
        cancelledCount: 0,
        successCount: 6,
        rolledBackCount: 0,
        totalNodes: 6,
        artifactMarks: [],
      },
    });
    fixture.detectChanges();
  }

  it('renders a visually-hidden h1 with the project title (projects-detail unmounts its own on demo launch)', () => {
    const h1 = (fixture.nativeElement as HTMLElement).querySelector('h1.sr-only');
    expect(h1?.textContent?.trim()).toBe('Pipeline Panic');
  });

  it('opens directly on the only authored release desk', () => {
    expect(component.levels().length).toBe(1);
    expect(component.levelIndex()).toBe(RELEASE_DESK_LEVEL_INDEX);
    expect(component.currentLevel()?.id).toBe(RELEASE_DESK_ID);
    expect(component.activeReleaseRoutePlanId()).toBe('serial');
    expect(component.pipeline.isValid).toBeTrue();
  });

  it('makes the first meaningful act a two-option verdict stamp', () => {
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('.opening-deal-overlay')).toBeNull();
    expect(host.querySelector('.difficulty-overlay')).toBeNull();
    expect(host.querySelectorAll('.stamp').length).toBe(2);
    expect(component.canStamp).toBeTrue();
  });

  it('withholds the computed answer until the player makes a call', () => {
    const text = fixture.nativeElement.textContent ?? '';
    expect(text).toContain("Does this fix make tonight's window?");
    expect(text).toContain('gate shuts at 12.0s until morning');
    expect(text).toContain('Does it make the 12.0s window? Stamp what the gate will do.');
    expect(text).not.toContain('Longest chain');
    expect(fixture.nativeElement.querySelector('.route-choice')).toBeNull();
  });

  it('derives the ticket-1 window number from the level rather than a hardcoded copy string', () => {
    const engine = fixture.debugElement.injector.get(GameEngineService);
    const desk = component.currentLevel()!;
    spyOn(engine, 'loadLevels').and.returnValue([{ ...desk, parTime: 20 }]);

    component.loadLevel(RELEASE_DESK_LEVEL_INDEX);
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent ?? '';
    expect(text).toContain('gate shuts at 20.0s until morning');
    expect(text).toContain('Does it make the 20.0s window? Stamp what the gate will do.');
    expect(text).not.toContain('12.0');
  });

  it('uses a stamp as the single dispatch trigger', () => {
    component.restoreDealtRoute();
    expect(component.releaseWindowForecast()?.verdict).not.toBe('incomplete');
    expect(component.canStamp).toBeTrue();
    const run = spyOn(component, 'runPipeline').and.callFake(() => {
      (runner as unknown as { _isRunning: boolean })._isRunning = true;
    });
    component.stampAndDispatch('locks');

    expect(component.playerCall()).toBe('locks');
    expect(component.dispatchState()).toBe('committed');
    expect(component.ticketAttemptCount()).toBe(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('keeps the patch bay secondary while leaving the verdict stamps reachable', () => {
    const desk = fixture.nativeElement as HTMLElement;
    // Closed bay: the graph editor and its tools stay behind the explicit open.
    expect(desk.querySelector('app-node-palette')).toBeNull();
    expect(desk.querySelector('app-pipeline-toolbar')).toBeNull();

    component.togglePrototypeWorkbench();
    fixture.detectChanges();

    expect(desk.querySelector('app-node-palette')).not.toBeNull();
    expect(desk.querySelectorAll('.stamp').length).toBe(2);
    expect(desk.textContent).toContain('Every edit redraws the rail. The stamp still makes the call.');
  });

  it('docks the patch tools inside the shelf strip beneath the canvas, not a left column', () => {
    component.togglePrototypeWorkbench();
    fixture.detectChanges();

    const desk = fixture.nativeElement as HTMLElement;
    const toolbar = desk.querySelector('app-pipeline-toolbar');
    expect(toolbar).not.toBeNull();
    // The tools belong to the shelf that holds the stages they edit, so the
    // hand that picks a stage is already on the control that removes it.
    const shelf = toolbar?.closest('.sidebar-left') ?? null;
    expect(shelf).not.toBeNull();
    // The shelf now flows inside the canvas column as a horizontal strip
    // rather than living in a separate left sidebar column that squeezes it.
    expect(desk.querySelector('.canvas-main app-pipeline-toolbar')).not.toBeNull();

    // ...and it sits between the canvas and the maintenance rail: brief,
    // then full-width canvas, then the shelf strip, then the rail.
    const canvasWrapper = desk.querySelector('.canvas-wrapper');
    const dispatchRail = desk.querySelector('.dispatch-rail');
    expect(canvasWrapper).not.toBeNull();
    expect(dispatchRail).not.toBeNull();
    expect(!!(canvasWrapper!.compareDocumentPosition(shelf!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBeTrue();
    expect(!!(shelf!.compareDocumentPosition(dispatchRail!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBeTrue();
  });

  it('does not revive campaign controls in the patch bay, including while a resource refusal is shown', () => {
    component.togglePrototypeWorkbench();
    fixture.detectChanges();

    // Trigger a real budget refusal so the guarantee is checked against the
    // one code path that used to print CPU/memory language, not just the
    // idle bay.
    const resourceManager = fixture.debugElement.injector.get(ResourceManagerService);
    spyOn(resourceManager, 'canAddNode').and.returnValue(false);
    spyOn(resourceManager, 'getForecast').and.returnValue({
      cpuAfter: 999,
      memoryAfter: 50,
      cpuOverBudget: true,
      memoryOverBudget: false,
    });
    const addNode = (component as unknown as { addNode(type: NodeType, x: number, y: number): boolean }).addNode.bind(
      component
    );
    expect(addNode(NodeType.Build, 9000, 9000)).toBeFalse();
    fixture.detectChanges();
    expect(component.placementRefusedReason()).not.toBeNull();

    const text = fixture.nativeElement.textContent ?? '';

    expect(text).not.toContain('Templates');
    expect(text).not.toContain('Export');
    expect(text).not.toContain('Resources');
    expect(text).not.toContain('CPU');
    expect(text).not.toContain('Memory');
    expect(fixture.nativeElement.querySelector('.terminal-panel')).toBeNull();
  });

  it('restores the last authored route after a hand edit', () => {
    component.pipeline.nodes.pop();
    (component as unknown as { validatePipeline(): boolean }).validatePipeline();
    expect(component.activeReleaseRoutePlanId()).toBeNull();

    component.restoreDealtRoute();

    expect(component.activeReleaseRoutePlanId()).toBe('serial');
    expect(component.pipeline.nodes.length).toBe(6);
    expect(component.pipeline.isValid).toBeTrue();
  });

  it('earns the route choice only after a correct receipt', () => {
    settle('locked', 'ships');
    expect(component.callAccuracy()).toBe('wrong');
    expect(component.routeChoiceAvailable()).toBeFalse();

    settle('locked', 'locks');
    expect(component.callAccuracy()).toBe('correct');
    expect(component.routeChoiceAvailable()).toBeTrue();
    expect(fixture.nativeElement.querySelectorAll('.route-choice-card').length).toBe(1);
  });

  it('cannot advance by replaying the route whose answer was just measured', () => {
    settle('locked', 'locks');

    component.selectReleaseRoutePlan('serial');

    expect(component.activeReleaseRoutePlanId()).toBe('serial');
    expect(component.routeDecisionMade()).toBeFalse();
    expect(component.canAdvanceTicket()).toBeFalse();
    expect(component.releaseRouteOptions().map(({ plan }) => plan.id)).toEqual(['parallel']);
  });

  it('states route trades in checks and seconds instead of abstract pips', () => {
    settle('locked', 'locks');
    const text = fixture.nativeElement.textContent ?? '';

    expect(text).toContain('2 checks overlap');
    expect(text).toContain('Reclaims');
    expect(text).not.toContain('Tempo');
    expect(text).not.toContain('Safety');
  });

  it('deals the selected route and hides the previous answer', () => {
    settle('locked', 'locks');
    component.selectReleaseRoutePlan('parallel');

    expect(component.activeReleaseRoutePlanId()).toBe('parallel');
    expect(component.routeDecisionMade()).toBeTrue();
    expect(component.dispatchState()).toBe('drafting');
    expect(component.releaseWindowOutcome()).toBeNull();
    expect(component.pipeline.connections.length).toBe(6);
  });

  it('changes one operating rule without rebuilding the learned route', () => {
    chooseParallelRouteAndReachTicketTwo();

    expect(component.activeConditionId()).toBe('agent-pool-1');
    expect(component.currentLevel()?.prototypeRules?.agentPoolLimit).toBe(1);
    expect(component.activeReleaseRoutePlanId()).toBe('parallel');
    expect(component.pipeline.nodes.length).toBe(6);
    expect(component.dispatchState()).toBe('drafting');
  });

  it('exposes concrete shortcut levers only on the changed ticket', () => {
    expect(component.releaseLevers.every((lever) => !component.leverAvailable(lever))).toBeTrue();
    chooseParallelRouteAndReachTicketTwo();

    expect(component.releaseLevers.every((lever) => component.leverAvailable(lever))).toBeTrue();
    const text = fixture.nativeElement.textContent ?? '';
    expect(text).toContain('Build');
    expect(text).toContain('Evidence');
    expect(text).toContain('Dispatch');
  });

  it('keeps the slowest supported ticket-two schedule fully on the evidence rail', () => {
    chooseParallelRouteAndReachTicketTwo();
    const build = component.pipeline.nodes.find((node) => node.type === NodeType.Build)!;
    const test = component.pipeline.nodes.find((node) => node.type === NodeType.Test)!;
    const deploy = component.pipeline.nodes.find((node) => node.type === NodeType.Deploy)!;
    build.config.optimizationLevel = 'thorough';
    test.config.coverageThreshold = 90;
    deploy.config.strategy = 'canary';

    (component as unknown as { validatePipeline(): boolean }).validatePipeline();

    const finish = component.releaseWindowForecast()?.durationSeconds ?? 0;
    expect(finish).toBeGreaterThan(15);
    expect(component.railSpanSeconds()).toBeGreaterThanOrEqual(finish);
    expect(component.railLockPercent()).toBeLessThan(80);
    expect(component.railStages().every((stage) => stage.leftPercent + stage.widthPercent <= 100.001)).toBeTrue();
    expect(component.playheadPercent()).toBeLessThanOrEqual(100);
  });

  it('ends the shift with an explanatory closeout, not score or stars', () => {
    chooseParallelRouteAndReachTicketTwo();
    settle('locked', 'locks');
    component.completeShift();
    fixture.detectChanges();

    expect(component.shiftComplete()).toBeTrue();
    expect(fixture.nativeElement.textContent).toContain('Two rules read, two calls made.');
    const closeoutText = (fixture.nativeElement.querySelector('.shift-closeout')?.textContent ?? '').toLowerCase();
    expect(closeoutText).not.toContain('score');
    expect(closeoutText).not.toContain('star');
    expect(closeoutText).not.toContain('grade');
    expect(closeoutText).not.toContain('%');
    expect(fixture.nativeElement.querySelector('.level-complete-modal')).toBeNull();
  });

  it('signs off with a two-row shift ledger recording each ticket', () => {
    component.ticketAttemptCount.set(1);
    settle('locked', 'locks'); // ticket 1, attempt 1, correct — earns "First read"
    component.selectReleaseRoutePlan('parallel');
    settle('released', 'ships'); // ticket 1, attempt 2 after the route change, correct
    component.takeNextTicket();
    fixture.detectChanges();

    settle('locked', 'locks'); // ticket 2, correct, no traded marks — earns "Honest lock"
    component.completeShift();
    fixture.detectChanges();

    const ledger = component.shiftLedger();
    expect(ledger.length).toBe(2);

    // Ledger entry 1 reflects the LIVE outcome at the moment of advancing —
    // the second (post-route-change) attempt, not the first stamp. The feat
    // stays "First read" via the sticky tracking even though this second
    // attempt's own live earnedFeat() would no longer qualify for it.
    expect(ledger[0].ticket).toBe(1);
    expect(ledger[0].call).toBe('ships');
    expect(ledger[0].verdict).toBe('released');
    expect(ledger[0].feat).toBe('First read');
    // The route change was taken on ticket 1, so its recorded label is the
    // changed route, not the inherited default — proof the row reads its own
    // captured value rather than a hardcoded initial one.
    expect(ledger[0].routeLabel).toBe('Split the checks');
    expect(ledger[0].secondsReclaimedOnRouteChange).not.toBeNull();
    expect(ledger[0].secondsReclaimedOnRouteChange as number).toBeGreaterThan(0);

    expect(ledger[1].ticket).toBe(2);
    expect(ledger[1].call).toBe('locks');
    expect(ledger[1].verdict).toBe('locked');
    expect(ledger[1].feat).toBe('Honest lock');
    expect(ledger[1].routeLabel).toBe('Split the checks');
    expect(ledger[1].secondsReclaimedOnRouteChange).toBeNull();

    const text = fixture.nativeElement.textContent ?? '';
    expect(text).toContain('First read');
    expect(text).toContain('Honest lock');
    expect(text).toContain('Route change reclaimed');
    expect(text).not.toContain('Shift ends on');

    const rows = fixture.nativeElement.querySelectorAll('.ledger-row');
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('Signed on Split the checks');
    expect(rows[1].textContent).toContain('Signed on Split the checks');
  });

  it('never signs off a feat the release it signed contradicts', () => {
    chooseParallelRouteAndReachTicketTwo();
    settle('locked', 'locks'); // ticket 2, nothing traded away, correct — earns "Honest lock"
    expect(component.earnedFeat()).toBe('Honest lock');

    // The player reopens the route in the patch bay, which returns the desk to
    // drafting, then buys speed before calling it again. The second call is
    // still right, but the artifact it signs off is no longer an honest one.
    (component as unknown as { validatePipeline(): boolean }).validatePipeline();
    component.artifactMarks.set([{ code: 'unoptimized', nodeId: component.pipeline.nodes[0].id, secondsSaved: 1.2 }]);
    settle('locked', 'locks');
    expect(component.earnedFeat()).toBeNull();

    component.completeShift();
    fixture.detectChanges();

    const ticketTwo = component.shiftLedger().find((entry) => entry.ticket === 2);
    expect(ticketTwo?.feat).toBeNull();
    // Scoped to the closeout: the desk itself advertises the feat as available
    // ("Optional feat · Honest lock"), which is not a claim that it was earned.
    const closeout = fixture.nativeElement.querySelector('.shift-closeout') as HTMLElement | null;
    expect(closeout).not.toBeNull();
    expect(closeout?.textContent).not.toContain('Honest lock');
    expect(closeout?.querySelector('.ledger-feat')).toBeNull();
  });

  it('carries nothing across the route change when the ticket earned no feat', () => {
    component.ticketAttemptCount.set(2); // the inherited route was misread once first
    settle('locked', 'locks');
    expect(component.earnedFeat()).toBeNull();

    component.selectReleaseRoutePlan('parallel');
    settle('released', 'ships');
    component.takeNextTicket();
    fixture.detectChanges();

    expect(component.shiftLedger()[0].feat).toBeNull();
  });

  it('empties the ledger and hides the closeout on replay', () => {
    chooseParallelRouteAndReachTicketTwo();
    settle('locked', 'locks');
    component.completeShift();
    fixture.detectChanges();
    expect(component.shiftLedger().length).toBe(2);

    component.replayShift();
    fixture.detectChanges();

    expect(component.shiftLedger()).toEqual([]);
    expect(component.shiftComplete()).toBeFalse();
    expect(fixture.nativeElement.querySelector('.shift-closeout')).toBeNull();
  });

  it('prints receipt content immediately at resolution, with a matching gate data-state', () => {
    settle('released', 'ships');

    const receipt = fixture.nativeElement.querySelector('.shift-receipt');
    expect(receipt).not.toBeNull();
    expect(receipt?.textContent).toContain('Shipped @');
    expect(receipt?.querySelector('.receipt-lines')).not.toBeNull();

    const gate = fixture.nativeElement.querySelector('.rail-gate');
    expect(gate?.getAttribute('data-state')).toBe('open');
  });

  it('carries a shut gate data-state and a locked receipt headline together', () => {
    settle('locked', 'locks');

    const gate = fixture.nativeElement.querySelector('.rail-gate');
    expect(gate?.getAttribute('data-state')).toBe('shut');
    const receipt = fixture.nativeElement.querySelector('.shift-receipt');
    expect(receipt?.textContent).toContain('Gate locked');
  });

  it('plays a tactile stamp sound on press and a muted thud when the gate locks', () => {
    const audio = fixture.debugElement.injector.get(AudioService);
    const run = spyOn(component, 'runPipeline').and.callFake(() => {
      (runner as unknown as { _isRunning: boolean })._isRunning = true;
    });

    component.stampAndDispatch('locks');
    expect(audio.play).toHaveBeenCalledWith('stamp');
    expect(run).toHaveBeenCalledTimes(1);

    settle('locked', 'locks');
    expect(audio.play).toHaveBeenCalledWith('gate-lock');
    expect(audio.play).not.toHaveBeenCalledWith('error');
  });

  it('plays a soft two-note clear when a release makes the gate', () => {
    const audio = fixture.debugElement.injector.get(AudioService);

    settle('released', 'ships');
    expect(audio.play).toHaveBeenCalledWith('gate-clear');
  });

  it('coaches a wrong call without granting the earned breakdown', () => {
    settle('locked', 'ships');

    expect(fixture.nativeElement.textContent).toContain('Measured finish');
    expect(fixture.nativeElement.querySelector('.receipt-lines')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Call again');
  });

  it('prints the outcome consequence for a correct release call, driven through the real dispatch flow', () => {
    dispatchAndResolveForReal('ships', 10, true);

    const outcome = component.releaseWindowOutcome();
    expect(outcome?.verdict).toBe('released');
    expect(component.callAccuracy()).toBe('correct');

    const actual = component.formatReleaseSeconds(outcome!.actualSeconds);
    expect(component.receiptConsequence()).toBe(`Out at ${actual}s. Support ships the fix tonight, and you called it.`);
    expect(fixture.nativeElement.querySelector('.receipt-consequence')?.textContent).toContain(
      'Support ships the fix tonight'
    );
  });

  it('prints the outcome consequence for a correct lock call, driven through the real dispatch flow', () => {
    dispatchAndResolveForReal('locks', 14, true);

    const outcome = component.releaseWindowOutcome();
    expect(outcome?.verdict).toBe('locked');
    expect(component.callAccuracy()).toBe('correct');

    const late = component.formatReleaseSeconds(outcome!.requiredReductionSeconds);
    expect(component.receiptConsequence()).toBe(
      `Held at the gate, ${late}s long. You saw it coming, and nothing went out broken.`
    );
  });

  it('prints the outcome consequence for a wrong call on a release', () => {
    settle('released', 'locks');
    const outcome = component.releaseWindowOutcome()!;
    const actual = component.formatReleaseSeconds(outcome.actualSeconds);
    expect(component.receiptConsequence()).toBe(
      `It made it at ${actual}s. You had it held; the window forgave the read this time.`
    );
  });

  it('prints the outcome consequence for a wrong call on a lock', () => {
    settle('locked', 'ships');
    const outcome = component.releaseWindowOutcome()!;
    const late = component.formatReleaseSeconds(outcome.requiredReductionSeconds);
    expect(component.receiptConsequence()).toBe(
      `The gate caught it, ${late}s late. Morning release now; the read was off.`
    );
  });

  it('shows a next-ticket teaser only on the advancing receipt, and hides it once ticket 2 is underway', () => {
    settle('locked', 'locks');
    component.selectReleaseRoutePlan('parallel');
    settle('released', 'ships');
    fixture.detectChanges();

    expect(component.canAdvanceTicket()).toBeTrue();
    const teaser = fixture.nativeElement.querySelector('.next-ticket-teaser');
    expect(teaser).not.toBeNull();
    expect(teaser?.textContent).toContain('Next on the desk');
    expect(teaser?.textContent).toContain('Ticket 02 · same route, one agent');

    // The number and the rule are read off the condition the advance will
    // actually clip on, so a third authored condition cannot leave the teaser
    // promising a ticket the desk will not deal.
    const nextCard = component.offeredConditions()[0];
    expect(component.nextTicketBrief()).toEqual({ number: '02', rule: component.conditionRule(nextCard) });

    component.takeNextTicket();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.next-ticket-teaser')).toBeNull();

    settle('locked', 'locks');
    component.completeShift();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.next-ticket-teaser')).toBeNull();
  });

  it('counts tickets from the level conditions instead of a fixed 02', () => {
    const counter = (): string | undefined =>
      (fixture.nativeElement as HTMLElement).querySelector('.ticket-counter strong')?.textContent?.trim();

    expect(component.ticketCount()).toBe(component.offeredConditions().length + 1);
    expect(component.ticketNumber()).toBe(1);
    expect(counter()).toBe('01 / 02');

    settle('locked', 'locks');
    component.selectReleaseRoutePlan('parallel');
    settle('released', 'ships');
    component.takeNextTicket();
    fixture.detectChanges();

    expect(component.ticketNumber()).toBe(2);
    expect(counter()).toBe('02 / 02');
  });

  it('reads the next ticket by position once a level authors a second condition', () => {
    // Stub a second condition onto the release desk. Its id is cast past the
    // narrow 'agent-pool-1' literal purely so this test can tell the two
    // cards apart by identity; production levels only author the one literal
    // today (see conditionRule()'s exhaustive switch).
    const level = component.currentLevel()!;
    const firstCondition = level.prototypeRules!.conditionCards![0];
    const secondCondition = { id: 'agent-pool-2', agentPoolLimit: 1 } as unknown as PrototypeConditionCard;
    component.currentLevel.set({
      ...level,
      prototypeRules: {
        ...level.prototypeRules!,
        conditionCards: [firstCondition, secondCondition],
      },
    });
    fixture.detectChanges();

    const counter = (): string | undefined =>
      (fixture.nativeElement as HTMLElement).querySelector('.ticket-counter strong')?.textContent?.trim();

    expect(component.ticketCount()).toBe(3);
    expect(counter()).toBe('01 / 03');

    chooseParallelRouteAndReachTicketTwo();
    expect(component.activeConditionId()).toBe(firstCondition.id);

    // From ticket 2, the next card must be the second entry by position, not
    // "any card that isn't active" — which would re-select firstCondition, a
    // ticket already played. conditionRule() on the stub returns undefined
    // (its id isn't in the authored switch), so this only matches if
    // nextTicketBrief() picked the same card, not the real 'one agent' text
    // it would get from wrongly re-selecting firstCondition.
    expect(component.nextTicketBrief()).toEqual({ number: '03', rule: component.conditionRule(secondCondition) });

    settle('locked', 'locks');
    expect(component.canAdvanceTicket()).toBeTrue();
    component.takeNextTicket();
    fixture.detectChanges();

    expect(component.ticketNumber()).toBe(3);
    expect(component.activeConditionId()).toBe(secondCondition.id);
    expect(counter()).toBe('03 / 03');
  });

  it('ignores retired campaign indices', () => {
    const current = component.currentLevel();
    component.loadLevel(7);

    expect(component.levelIndex()).toBe(RELEASE_DESK_LEVEL_INDEX);
    expect(component.currentLevel()).toBe(current);
  });

  it('fails closed when the release desk contract is misidentified', () => {
    const engine = fixture.debugElement.injector.get(GameEngineService);
    const desk = component.currentLevel()!;
    spyOn(engine, 'loadLevels').and.returnValue([{ ...desk, id: 'retired-level' }]);

    expect(() => component.loadLevel(RELEASE_DESK_LEVEL_INDEX)).toThrowError(
      'Pipeline Panic release desk level contract is missing or misconfigured.'
    );
  });

  it('keeps connection reversal undo and redo lossless in the reachable patch bay', () => {
    const connection = component.pipeline.connections[2];
    const before = { sourceId: connection.sourceId, targetId: connection.targetId };
    spyOn(builder, 'canConnect').and.returnValue(true);

    (component as unknown as { reverseConnection(value: Connection): void }).reverseConnection(connection);
    expect(connection.sourceId).toBe(before.targetId);
    expect(connection.targetId).toBe(before.sourceId);

    component.undo();
    expect(connection.sourceId).toBe(before.sourceId);
    expect(connection.targetId).toBe(before.targetId);

    component.redo();
    expect(connection.sourceId).toBe(before.targetId);
    expect(connection.targetId).toBe(before.sourceId);
  });

  it('stops the runner and clears its event work on teardown', () => {
    const destroy = spyOn(runner, 'destroy').and.callThrough();
    fixture.destroy();
    expect(destroy).toHaveBeenCalled();
  });

  it('keeps the authored stage set limited to evidence-producing release work', () => {
    expect(component.availableNodes().map((entry) => entry.type)).toEqual([
      NodeType.Source,
      NodeType.Build,
      NodeType.Test,
      NodeType.SecurityScan,
      NodeType.Deploy,
      NodeType.Parallel,
    ]);
  });

  it('surfaces a visible reason when the patch bay refuses a placement, and clears it on the next success', () => {
    component.togglePrototypeWorkbench();
    fixture.detectChanges();

    const resourceManager = fixture.debugElement.injector.get(ResourceManagerService);
    const addNode = (component as unknown as { addNode(type: NodeType, x: number, y: number): boolean }).addNode.bind(
      component
    );

    const canAddNode = spyOn(resourceManager, 'canAddNode').and.returnValue(false);
    spyOn(resourceManager, 'getForecast').and.returnValue({
      cpuAfter: 999,
      memoryAfter: 50,
      cpuOverBudget: true,
      memoryOverBudget: false,
    });

    const refused = addNode(NodeType.Build, 9000, 9000);
    fixture.detectChanges();

    expect(refused).toBeFalse();
    expect(component.placementRefusedReason()).toContain('No capacity left on this route');
    expect(component.placementRefusedReason()).not.toContain('CPU');
    const message = (fixture.nativeElement as HTMLElement).querySelector('.placement-refused');
    expect(message).not.toBeNull();
    expect(message?.textContent).toContain('No capacity left on this route');
    expect(message?.getAttribute('aria-live')).toBe('polite');

    canAddNode.and.returnValue(true);
    const placed = addNode(NodeType.Build, 9000, 9000);
    fixture.detectChanges();

    expect(placed).toBeTrue();
    expect(component.placementRefusedReason()).toBeNull();
    expect((fixture.nativeElement as HTMLElement).querySelector('.placement-refused')).toBeNull();
  });

  it('drops a refusal when the patch bay closes, so reopening it cannot re-announce a stale one', () => {
    component.togglePrototypeWorkbench();
    fixture.detectChanges();

    const addNode = (component as unknown as { addNode(type: NodeType, x: number, y: number): boolean }).addNode.bind(
      component
    );
    const occupied = component.pipeline.nodes[0];

    expect(addNode(NodeType.Build, occupied.x, occupied.y)).toBeFalse();
    fixture.detectChanges();
    expect(component.placementRefusedReason()).toContain('too close');
    expect((fixture.nativeElement as HTMLElement).querySelector('.placement-refused')).not.toBeNull();

    component.togglePrototypeWorkbench(); // close the bay
    component.togglePrototypeWorkbench(); // and come back to it
    fixture.detectChanges();

    expect(component.placementRefusedReason()).toBeNull();
    expect((fixture.nativeElement as HTMLElement).querySelector('.placement-refused')).toBeNull();
  });

  it('keeps every lever option label and trade fully readable, never CSS-truncated', () => {
    chooseParallelRouteAndReachTicketTwo();
    fixture.detectChanges();

    const allOptions = component.releaseLevers.flatMap((lever) => lever.options);
    const labelEls: Element[] = Array.from(fixture.nativeElement.querySelectorAll('.lever-label'));
    const tradeEls: Element[] = Array.from(fixture.nativeElement.querySelectorAll('.lever-trade'));

    expect(labelEls.length).toBe(allOptions.length);
    expect(tradeEls.length).toBe(allOptions.length);

    labelEls.forEach((el) => {
      const text = (el.textContent ?? '').trim();
      expect(allOptions.map((option) => option.label)).toContain(text);
      const style = getComputedStyle(el);
      expect(style.textOverflow).not.toBe('ellipsis');
      expect(style.whiteSpace).not.toBe('nowrap');
    });

    tradeEls.forEach((el) => {
      const text = (el.textContent ?? '').trim();
      expect(allOptions.map((option) => option.trade)).toContain(text);
    });
  });

  it('flips the header mute toggle, mirroring state into aria-pressed and AudioService', () => {
    const audio = fixture.debugElement.injector.get(AudioService);
    const button = (): HTMLButtonElement =>
      (fixture.nativeElement as HTMLElement).querySelector('.mute-toggle') as HTMLButtonElement;

    expect(audio.enabled).toBeTrue();
    expect(component.isMuted()).toBeFalse();
    expect(button().getAttribute('aria-pressed')).toBe('false');
    expect(button().getAttribute('aria-label')).toBe('Mute desk audio');

    component.toggleMute();
    fixture.detectChanges();

    expect(audio.enabled).toBeFalse();
    expect(component.isMuted()).toBeTrue();
    expect(button().getAttribute('aria-pressed')).toBe('true');
    expect(button().getAttribute('aria-label')).toBe('Unmute desk audio');

    component.toggleMute();
    fixture.detectChanges();

    expect(audio.enabled).toBeTrue();
    expect(component.isMuted()).toBeFalse();
    expect(button().getAttribute('aria-pressed')).toBe('false');
  });

  /**
   * Pins the isValid/errors invariant runBlockedReason depends on (see the
   * getter's doc comment) at its consumer: PipelineBuilderService.validatePipeline()
   * is the one write site the getter itself doesn't exercise a test against.
   * Removing the Deploy node from the dealt route is a severity:'error' case
   * the base validator raises directly, independent of the two
   * PipelineRunnerService write sites covered in pipeline-runner.service.spec.ts.
   */
  it("surfaces the validator's own suggestion through runBlockedReason, never a generic fallback", () => {
    const deploy = component.pipeline.nodes.find((node) => node.type === NodeType.Deploy)!;
    component.pipeline.nodes = component.pipeline.nodes.filter((node) => node.id !== deploy.id);
    (component as unknown as { validatePipeline(): boolean }).validatePipeline();

    expect(component.pipeline.isValid).toBeFalse();
    expect(component.runBlockedReason).toBe('Add a Deploy node to complete the pipeline');
  });
});

/**
 * ngOnInit -> initializeGame() -> requireReleaseDeskLevel() throws fail-closed
 * when the authored release desk data drifts from its contract. Before this
 * fix that throw came straight out of ngOnInit uncaught, breaking the
 * component instead of showing its own themed error overlay. These specs spy
 * on GameEngineService.loadLevels() to reproduce that drift, the same
 * technique the "fails closed when the release desk contract is misidentified"
 * spec above uses against loadLevel() directly. A couple also make
 * loadLevels() itself throw a plain Error, standing in for any failure inside
 * initializeGame() that is NOT the release desk contract, to pin that the
 * overlay copy only claims a data-contract cause when that is actually why it
 * failed.
 */
describe('PipelinePanicComponent init failure', () => {
  let fixture: ComponentFixture<PipelinePanicComponent>;
  let component: PipelinePanicComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [PipelinePanicComponent] }).compileComponents();
    fixture = TestBed.createComponent(PipelinePanicComponent);
    component = fixture.componentInstance;
    const audio = fixture.debugElement.injector.get(AudioService);
    spyOn(audio, 'initialize');
    spyOn(audio, 'play');
  });

  afterEach(() => fixture.destroy());

  function overlay(): Element | null {
    return (fixture.nativeElement as HTMLElement).querySelector('.game-error-overlay');
  }

  it('routes a broken release desk contract into the themed overlay instead of throwing out of ngOnInit', () => {
    const engine = fixture.debugElement.injector.get(GameEngineService);
    spyOn(engine, 'loadLevels').and.returnValue([]);

    expect(() => fixture.detectChanges()).not.toThrow();

    expect(component.gameError()).toContain('Reload the shift');
    expect(overlay()).not.toBeNull();
    expect(overlay()?.textContent).toContain('Desk fault');
  });

  it('names the data contract specifically when requireReleaseDeskLevel is the cause', () => {
    const engine = fixture.debugElement.injector.get(GameEngineService);
    spyOn(engine, 'loadLevels').and.returnValue([]);

    fixture.detectChanges();

    expect(component.gameError()).toContain('does not match its contract');
  });

  it('gives cause-agnostic guidance for any other initialization failure, not a guessed contract diagnosis', () => {
    const engine = fixture.debugElement.injector.get(GameEngineService);
    spyOn(engine, 'loadLevels').and.throwError('boom: unrelated failure');

    expect(() => fixture.detectChanges()).not.toThrow();

    expect(component.gameError()).toContain('Reload the shift');
    expect(component.gameError()).not.toContain('does not match its contract');
    expect(overlay()).not.toBeNull();
    expect(overlay()?.textContent).toContain('Desk fault');
  });

  it('re-shows the overlay instead of throwing when "Reload the shift" hits the same broken contract', () => {
    const engine = fixture.debugElement.injector.get(GameEngineService);
    spyOn(engine, 'loadLevels').and.returnValue([]);
    fixture.detectChanges();
    expect(component.gameError()).not.toBeNull();

    expect(() => component.resetAndRecover()).not.toThrow();
    fixture.detectChanges();

    expect(component.gameError()).not.toBeNull();
    expect(overlay()).not.toBeNull();
    expect(overlay()?.textContent).toContain('Desk fault');
  });

  it('recovers fully once "Reload the shift" reaches valid data', () => {
    const engine = fixture.debugElement.injector.get(GameEngineService);
    const loadLevels = spyOn(engine, 'loadLevels').and.returnValue([]);
    fixture.detectChanges();
    expect(component.gameError()).not.toBeNull();

    loadLevels.and.callThrough();
    component.resetAndRecover();
    fixture.detectChanges();

    expect(component.gameError()).toBeNull();
    expect(overlay()).toBeNull();
    expect(component.currentLevel()?.id).toBe(RELEASE_DESK_ID);
  });
});

/**
 * The desk quiets its supporting copy with `opacity` rather than a second ink
 * colour, which means legibility depends on the theme underneath it. Day paper
 * (#fbf6e9) and slate ink (#2f4f4f) leave far less headroom than white on the
 * night board, so a single opacity that reads fine at night can silently drop
 * these 11px labels under WCAG AA in day mode.
 *
 * The opacity comes off the rendered element, so these specs fail on the real
 * stylesheet rather than on a number restated in the test. The ink and paper
 * are the site's own theme tokens, named below, because Karma does not load the
 * global stylesheet that publishes them.
 */
describe('PipelinePanicComponent desk ink legibility', () => {
  let fixture: ComponentFixture<PipelinePanicComponent>;
  let component: PipelinePanicComponent;

  type Rgb = readonly [number, number, number];

  /** WCAG 2.1 relative luminance. */
  function luminance(rgb: Rgb): number {
    const linear = (channel: number): number => {
      const c = channel / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);
  }

  function contrastRatio(a: Rgb, b: Rgb): number {
    const la = luminance(a);
    const lb = luminance(b);
    const [lighter, darker] = la > lb ? [la, lb] : [lb, la];
    return (lighter + 0.05) / (darker + 0.05);
  }

  function channels(color: string): Rgb {
    const parts = color.match(/[\d.]+/g);
    if (!parts || parts.length < 3) throw new Error(`Cannot read channels from "${color}"`);
    return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
  }

  /**
   * The desk's two themes, as src/assets/_variables.scss defines them: day is
   * `$day-color` ink on `$day-background` paper, night is `$night-color` on
   * `lighten($night-background, 5%)`. The theme class goes on `document.body`
   * because `:host-context(.night-mode)` reads it off an ancestor of the host.
   */
  const THEMES = [
    { name: 'day paper', mode: 'day-mode', ink: '47, 79, 79', paper: '251, 246, 233' },
    { name: 'the night board', mode: 'night-mode', ink: '255, 255, 255', paper: '34, 36, 37' },
  ] as const;

  type Theme = (typeof THEMES)[number];

  function applyTheme(theme: Theme): void {
    document.body.classList.add(theme.mode);
    fixture.detectChanges();
  }

  /** Composite the element's own rendered opacity over the theme's paper. */
  function measuredContrast(selector: string, theme: Theme): number {
    const el = (fixture.nativeElement as HTMLElement).querySelector(selector);
    if (!el) throw new Error(`${selector} is not rendered`);
    const alpha = Number(getComputedStyle(el).opacity);
    if (!Number.isFinite(alpha)) throw new Error(`${selector} has no readable opacity`);
    const ink = channels(theme.ink);
    const paper = channels(theme.paper);
    const composite: Rgb = [
      ink[0] * alpha + paper[0] * (1 - alpha),
      ink[1] * alpha + paper[1] * (1 - alpha),
      ink[2] * alpha + paper[2] * (1 - alpha),
    ];
    return contrastRatio(composite, paper);
  }

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [PipelinePanicComponent] }).compileComponents();
    fixture = TestBed.createComponent(PipelinePanicComponent);
    component = fixture.componentInstance;
    const audio = fixture.debugElement.injector.get(AudioService);
    spyOn(audio, 'initialize');
    spyOn(audio, 'play');
    fixture.detectChanges();
    // The manifest and the shelf blurb only exist once the bay is open.
    component.togglePrototypeWorkbench();
    fixture.detectChanges();
  });

  afterEach(() => {
    document.body.classList.remove('day-mode', 'night-mode');
    fixture.destroy();
  });

  // 11px uppercase is small text by every WCAG measure, so 4.5:1 is the bar.
  const AA_NORMAL_TEXT = 4.5;
  const quietedCopy = ['.brief-kicker', '.patch-bay-manifest', '.patch-palette-copy'];

  THEMES.forEach((theme) => {
    quietedCopy.forEach((selector) => {
      it(`keeps ${selector} above WCAG AA on ${theme.name}`, () => {
        applyTheme(theme);

        expect(measuredContrast(selector, theme)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
      });
    });
  });

  it('quiets day paper less than the night board, because slate on cream has less headroom', () => {
    applyTheme(THEMES[0]);
    const dayOpacity = Number(getComputedStyle(kicker()).opacity);

    document.body.classList.remove('day-mode');
    applyTheme(THEMES[1]);
    const nightOpacity = Number(getComputedStyle(kicker()).opacity);

    // One shared opacity across both themes is the failure this token prevents.
    expect(dayOpacity).toBeGreaterThan(nightOpacity);
  });

  function kicker(): Element {
    const el = (fixture.nativeElement as HTMLElement).querySelector('.brief-kicker');
    if (!el) throw new Error('.brief-kicker is not rendered');
    return el;
  }
});
