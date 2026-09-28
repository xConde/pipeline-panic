import {
  AfterViewChecked,
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  HostListener,
  inject,
  OnDestroy,
  OnInit,
  Renderer2,
  signal,
  ViewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { GameEngineService } from './services/game-engine.service';
import { PipelineBuilderService } from './services/pipeline-builder.service';
import { ResourceManagerService } from './services/resource-manager.service';
import { ParticleSystemService } from './services/particle-system.service';
import { AudioService } from './services/audio.service';
import { PipelineExecutionService } from './services/pipeline-execution.service';
import { CanvasRendererService, RenderContext } from './services/canvas-renderer.service';
import { DataFlowContext, GameLoopService } from './services/game-loop.service';
import { GAME_CONSTANTS, PIPELINE_SCHEDULER_TICK_SECONDS } from './game-constants';
import {
  CriticalPathEstimate,
  PipelineRunnerService,
  ReleaseArtifactMark,
  RunnerEvent,
} from './services/pipeline-runner.service';
import { GamePhase, GamePhaseService } from './services/game-phase.service';
import { UndoRedoService } from './services/undo-redo.service';
import { PipelineCommand } from './models/command.model';
import { ThemeService } from '@services/theme.service';
import {
  Connection,
  DeployStrategy,
  NodeConfig,
  NodeStatus,
  NodeType,
  Pipeline,
  PipelineNode,
} from './models/pipeline.model';
import { GameState, isControlledPrototype, Level, PrototypeConditionCard } from './models/game-state.model';
import { getIconSvg } from './utils/icons';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { PipelineToolbarComponent } from './components/pipeline-toolbar/pipeline-toolbar.component';
import { ConfigChangeEvent, NodePaletteComponent } from './components/node-palette/node-palette.component';
import { NodeDragControllerService } from './services/node-drag-controller.service';
import {
  assembleReleaseWindowRoute,
  matchesReleaseWindowRoutePlan,
  RELEASE_ROUTE_PLANS,
  ReleaseRoutePlan,
  ReleaseRoutePlanId,
} from './data/release-window-routes';
import { RELEASE_DESK_ID } from './data/release-desk.data';

/** The release desk is the complete player-facing catalogue and front door. */
export const RELEASE_DESK_LEVEL_INDEX = 0;

/**
 * Marks requireReleaseDeskLevel()'s fail-closed throw specifically, so
 * tryInitializeGame() can show contract-specific guidance only when that is
 * actually what happened, instead of claiming a data-contract cause for any
 * exception initializeGame() might raise.
 */
class ReleaseDeskContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReleaseDeskContractError';
  }
}

type ReleaseWindowVerdict = 'incomplete' | 'open' | 'locked';

interface ReleaseWindowForecast {
  readonly verdict: ReleaseWindowVerdict;
  readonly windowSeconds: number;
  readonly durationSeconds: number | null;
  readonly criticalPath: readonly string[];
  readonly criticalPathLabel: string;
  readonly marginSeconds: number;
  readonly requiredReductionSeconds: number;
}

interface ReleaseWindowOutcome {
  readonly verdict: 'released' | 'locked';
  readonly predictedSeconds: number;
  readonly actualSeconds: number;
  readonly predictionDeltaSeconds: number;
  readonly criticalPathLabel: string;
  readonly marginSeconds: number;
  readonly requiredReductionSeconds: number;
}

interface ReleaseRouteOption {
  readonly plan: ReleaseRoutePlan;
  readonly durationSeconds: number | null;
  readonly secondsReclaimed: number | null;
}

/** The call the player stamps on the release before it is dispatched. */
type ReleaseCall = 'ships' | 'locks';

/**
 * One completed-ticket record for the shift ledger.
 *
 * Written once per ticket, at the moment that ticket is genuinely finished
 * (ticket 1 on advancing, ticket 2 on sign-off) — never live-recomputed
 * afterward, so a feat the player actually saw is not lost when a later
 * attempt on the same ticket no longer qualifies for it.
 */
export interface ShiftLedgerEntry {
  readonly ticket: 1 | 2;
  readonly call: ReleaseCall;
  readonly verdict: 'released' | 'locked';
  readonly actualSeconds: number;
  readonly feat: string | null;
  readonly routeLabel: string;
  /** Seconds the ticket-1 route change reclaimed, or null (no change taken, or ticket 2). */
  readonly secondsReclaimedOnRouteChange: number | null;
}

/**
 * Where the release is in tonight's dispatch.
 *
 * drafting  - wiring the route; the system has not told the player anything it
 *             could have worked out from the durations on the rail
 * committed - a call is stamped and the release is moving
 * resolved  - the gate has answered
 */
type DispatchState = 'drafting' | 'committed' | 'resolved';

/**
 * A lever the operator can pull to buy time on the release.
 *
 * These are the same node settings the inspector has always exposed, lifted onto
 * the desk because a lever nobody finds is not a decision. Each option says what
 * it trades, and none of them state the resulting finish time: reading the rail
 * and working out whether the total clears the gate stays the player's job.
 */
interface ReleaseLeverOption {
  readonly value: string | number;
  readonly label: string;
  readonly trade: string;
  readonly mark: string | null;
}

interface ReleaseLever {
  readonly id: 'build' | 'evidence' | 'dispatch';
  readonly nodeType: NodeType;
  readonly field: keyof NodeConfig;
  readonly title: string;
  /**
   * What the scheduler assumes when the node leaves this field unset. The strip
   * has to report the setting the rail is actually drawing, not the raw config,
   * or an untouched route would show no lever engaged at all.
   */
  readonly fallback: string | number;
  readonly options: readonly ReleaseLeverOption[];
}

/** One stage drawn on the maintenance rail, in percentage geometry. */
interface RailStage {
  readonly nodeId: string;
  readonly name: string;
  readonly color: string;
  readonly leftPercent: number;
  readonly widthPercent: number;
  readonly seconds: number;
  readonly onCriticalPath: boolean;
  /** True when this stage is still running after the window has shut. */
  readonly pastLock: boolean;
}

@Component({
  selector: 'app-pipeline-panic',
  templateUrl: './pipeline-panic.component.html',
  styleUrls: ['./pipeline-panic.component.scss'],
  standalone: true,
  imports: [PipelineToolbarComponent, NodePaletteComponent],
  providers: [
    GameEngineService,
    PipelineBuilderService,
    ResourceManagerService,
    ParticleSystemService,
    AudioService,
    PipelineExecutionService,
    CanvasRendererService,
    GameLoopService,
    PipelineRunnerService,
    GamePhaseService,
    UndoRedoService,
    NodeDragControllerService,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PipelinePanicComponent implements OnInit, OnDestroy, AfterViewInit, AfterViewChecked {
  @ViewChild('gameCanvas', { static: false }) gameCanvas!: ElementRef<HTMLCanvasElement>;
  @ViewChild('pipelineCanvas', { static: false }) pipelineCanvas!: ElementRef<HTMLCanvasElement>;
  @ViewChild('particleCanvas', { static: false }) particleCanvas!: ElementRef<HTMLCanvasElement>;
  private readonly destroyRef = inject(DestroyRef);
  private readonly themeService = inject(ThemeService);
  private readonly renderer = inject(Renderer2);
  private ctx: CanvasRenderingContext2D | null = null;
  private pipelineCtx: CanvasRenderingContext2D | null = null;

  // Expose NodeType enum to template
  readonly NodeType = NodeType;
  readonly Math = Math;

  // Game State
  gameState!: GameState;
  readonly currentLevel = signal<Level | null>(null);
  pipeline!: Pipeline;
  // Game State
  get gamePhase(): GamePhase {
    return this.gamePhaseService.phase;
  }
  get isRunning(): boolean {
    return this.runner.isRunning;
  }
  /**
   * Why the Run button is disabled, for an inline message above the toolbar. The
   * validation errors carry .suggestion text, but it was only logged inside runPipeline(),
   * which a disabled button never reaches, so the player was stuck with a grey button and
   * no reason. Returns null when there is nothing to run or the pipeline is already valid.
   *
   * No string fallback below .message: every site that writes pipeline.isValid
   * keeps it in lockstep with pipeline.errors, so isValid false always leaves
   * a severity:'error' entry behind with both message and suggestion set.
   * Three write sites share that invariant:
   *   - PipelineBuilderService.validatePipeline() derives isValid from the
   *     errors it just pushed (isValid = no severity:'error' entries remain).
   *   - PipelineRunnerService.startPipeline()'s dependency-gate check
   *     (pipeline-runner.service.ts ~394) pushes its own error and sets
   *     isValid = false by hand.
   *   - The same method's schedule-computation check (~407) does the same
   *     when simulatePipelineSchedule() can't produce a route.
   * Reaching this line with isValid false guarantees firstError exists no
   * matter which of the three set it.
   */
  get runBlockedReason(): string | null {
    if (this.isRunning || this.pipeline.nodes.length === 0 || this.pipeline.isValid) {
      return null;
    }
    const firstError = this.pipeline.errors.find((e) => e.severity === 'error');
    return firstError?.suggestion ?? firstError?.message ?? null;
  }
  get isPaused(): boolean {
    return this.runner.isPaused;
  }
  get gameSpeed(): number {
    return this.runner.gameSpeed;
  }
  /**
   * Mirrors AudioService.enabled for the header mute toggle. Kept as its own
   * signal (rather than reading the service directly from the template) so
   * OnPush change detection re-renders the icon on click. In-memory only,
   * same as the rest of this desk's session state — AudioService has no
   * persistence to opt into, and a page reload starting with sound on is the
   * expected default.
   */
  readonly isMuted = signal(false);
  // Error state
  readonly gameError = signal<string | null>(null); // Non-null when game is in error state
  readonly degradedFeatures = signal<string[]>([]); // List of features that have been disabled
  private renderErrorCount = 0;

  /**
   * Why the last patch-bay placement attempt was refused, for a visible inline
   * message next to the node shelf. The resources panel that used to show this
   * was deleted, but the CPU/memory/slot/spacing gates in addNode() still refuse
   * placements — silently, without this signal. Null once nothing is refused:
   * initial state, after a successful placement, or after the route changes.
   */
  readonly placementRefusedReason = signal<string | null>(null);

  // Release-desk causal loop: scheduler-derived prediction before dispatch and a measured
  // comparison afterwards. Signals keep these async runner updates fresh under OnPush.
  readonly releaseWindowForecast = signal<ReleaseWindowForecast | null>(null);
  readonly releaseWindowOutcome = signal<ReleaseWindowOutcome | null>(null);
  private activeReleaseWindowForecast: ReleaseWindowForecast | null = null;

  /**
   * Which authored operating condition is clipped to tonight's ticket.
   *
   * The level declares its conditions as inert data; this signal is what promotes
   * one into a live scheduler rule. Night one runs with no condition so the player
   * can learn concurrency, and taking the next ticket clips the condition on so the
   * same graph has to be solved a second way.
   *
   * Deliberately in-memory only. A page reload puts the next participant back on
   * night one, which is what a fresh study session needs.
   */
  readonly activeConditionId = signal<PrototypeConditionCard['id'] | null>(null);

  /** Conditions this level could clip on, in authored order. */
  readonly offeredConditions = computed<readonly PrototypeConditionCard[]>(
    () => this.currentLevel()?.prototypeRules?.conditionCards ?? []
  );

  /** The live condition, or null on night one. */
  readonly activeCondition = computed<PrototypeConditionCard | null>(() => {
    const id = this.activeConditionId();
    if (!id) return null;
    return this.offeredConditions().find((card) => card.id === id) ?? null;
  });

  /** Night one, plus one ticket for every condition the level offers to clip on. */
  readonly ticketCount = computed(() => this.offeredConditions().length + 1);

  /** The ticket currently on the desk. Night one is ticket 1; each condition is the next ticket in authored order. */
  readonly ticketNumber = computed(() => {
    const active = this.activeCondition();
    if (!active) return 1;
    const index = this.offeredConditions().findIndex((card) => card.id === active.id);
    return index < 0 ? 1 : index + 2;
  });

  /**
   * The card the next ticket would clip on, read by position rather than by
   * "any card that isn't the active one". Ticket 1 has no condition, ticket 2
   * is `offeredConditions()[0]`, ticket N is `offeredConditions()[N - 2]` — so
   * the next card sits at `offeredConditions()[ticketNumber() - 1]`. Null once
   * the level has no card left to offer.
   *
   * `hasNextTicket()`, `nextTicketBrief()` and `takeNextTicket()` all read this
   * one signal so they cannot disagree about which card is next: the previous
   * per-callsite `card.id !== activeConditionId()` picked the first card that
   * merely wasn't the active one, which is the already-played card once a
   * level authors more than one condition and the active one isn't the first.
   */
  readonly nextTicketCondition = computed<PrototypeConditionCard | null>(
    () => this.offeredConditions()[this.ticketNumber() - 1] ?? null
  );

  /** True when a card exists at the next ticket position. */
  readonly hasNextTicket = computed(() => this.nextTicketCondition() !== null);

  /**
   * The ticket `takeNextTicket()` would deal, described from the condition data itself.
   *
   * The teaser used to print a hardcoded "Ticket 02 · one agent". A third
   * authored condition would have made that copy lie about what comes next, so
   * the number and the rule are both read off the same card the advance uses.
   */
  readonly nextTicketBrief = computed<{ readonly number: string; readonly rule: string } | null>(() => {
    const next = this.nextTicketCondition();
    if (!next) return null;
    return { number: this.formatTicketNumber(this.ticketNumber() + 1), rule: this.conditionRule(next) };
  });

  // ── Dispatch: the player's call, and what the rail is allowed to reveal ──────

  readonly dispatchState = signal<DispatchState>('drafting');
  readonly playerCall = signal<ReleaseCall | null>(null);

  /**
   * The controlled prototype begins in a focused ticket view. The full pipeline
   * editor remains available as the patch bay, but it is a deliberate secondary
   * action instead of six simultaneous systems competing with the first call.
   */
  readonly prototypeWorkbenchOpen = signal(false);

  /** The complete authored route currently dealt onto the release desk. */
  readonly activeReleaseRoutePlanId = signal<ReleaseRoutePlanId | null>(null);
  private readonly dealtReleaseRoutePlanId = signal<ReleaseRoutePlanId>('serial');

  readonly releaseRoutePlans = RELEASE_ROUTE_PLANS;

  readonly activeReleaseRoutePlan = computed<ReleaseRoutePlan | null>(() => {
    const id = this.activeReleaseRoutePlanId();
    return this.releaseRoutePlans.find((plan) => plan.id === id) ?? null;
  });

  /**
   * Causal route previews from the same scheduler that runs the release. The
   * receipt may name seconds saved without duplicating timing constants in copy.
   */
  readonly releaseRouteOptions = computed<readonly ReleaseRouteOption[]>(() => {
    const level = this.currentLevel();
    if (!level) return [];

    const previews = this.releaseRoutePlans.map((plan) => {
      const route = assembleReleaseWindowRoute(plan.id, { width: 1000, height: 360 }, (type) =>
        this.getDefaultNodeConfig(type)
      );
      const durationSeconds = this.runner.estimateCriticalPath(route, level)?.durationSeconds ?? null;
      return { plan, durationSeconds };
    });
    const inheritedSeconds = previews.find(({ plan }) => plan.id === 'serial')?.durationSeconds ?? null;

    return previews
      .filter(({ plan }) => plan.id !== this.activeReleaseRoutePlanId())
      .map(({ plan, durationSeconds }) => ({
        plan,
        durationSeconds,
        secondsReclaimed:
          inheritedSeconds === null || durationSeconds === null
            ? null
            : Math.max(0, this.roundReleaseSeconds(inheritedSeconds - durationSeconds)),
      }));
  });

  /** The player has acted on the first receipt instead of being asked cold. */
  readonly routeDecisionMade = signal(false);

  /** Attempts on the live ticket, used only for named feats—not a hidden score. */
  readonly ticketAttemptCount = signal(0);

  /** Final state of the two-ticket release shift. */
  readonly shiftComplete = signal(false);

  /** One completed-ticket record per ticket, printed as the closeout's shift ledger. */
  readonly shiftLedger = signal<readonly ShiftLedgerEntry[]>([]);

  /**
   * The feat ticket 1 had already earned when the player took the route change.
   *
   * The earned route change is the one attempt boundary the player does not ask
   * for: taking it always forces a second stamp, and that second attempt's own
   * `earnedFeat()` no longer qualifies for "First read". Carrying the feat
   * across that single boundary keeps what the player actually saw.
   *
   * Every other new attempt — revising the call, editing the route in the patch
   * bay, taking the next ticket — deliberately drops it, so the ledger can never
   * print a feat the release it signed off contradicts.
   */
  private routeChangeCarriedFeat: string | null = null;

  /** The releaseRouteOptions().secondsReclaimed value at the moment ticket 1's route change was chosen. */
  private pendingRouteChangeSecondsReclaimed: number | null = null;

  /** Identity of the last outcome this component has already sounded. */
  private lastAnnouncedOutcome: ReleaseWindowOutcome | null = null;

  /** The route choice is earned by reading the inherited route correctly. */
  readonly routeChoiceAvailable = computed(
    () =>
      this.activeCondition() === null &&
      this.dispatchState() === 'resolved' &&
      this.callAccuracy() === 'correct' &&
      !this.routeDecisionMade()
  );

  /**
   * The next ticket is offered only after an informed route choice and a
   * correct call. Gated on `hasNextTicket()` alone (not also "no condition is
   * active yet") so this stays true past ticket 2 once a level authors more
   * than one condition — the same positional card `hasNextTicket()` finds is
   * the one `takeNextTicket()` clips on.
   */
  readonly canAdvanceTicket = computed(
    () => this.routeDecisionMade() && this.callAccuracy() === 'correct' && this.hasNextTicket()
  );

  /** A correct read of the changed operating rule signs off the shift. */
  readonly canCompleteShift = computed(
    () => this.activeCondition() !== null && this.callAccuracy() === 'correct' && !this.shiftComplete()
  );

  /**
   * The computed finish time stays hidden until the player has committed a call
   * on this ticket at least once. Showing it earlier hands over the answer to a
   * deterministic puzzle, then leaves the player waiting to watch a number they
   * were already given. After the first result it becomes coaching.
   */
  readonly forecastRevealed = signal(false);

  /** Stage geometry for the rail, measured against the maintenance window. */
  readonly railStages = signal<readonly RailStage[]>([]);

  /** What the last run's speed-saving choices stamped onto the release. */
  readonly artifactMarks = signal<readonly ReleaseArtifactMark[]>([]);

  /**
   * The levers this desk offers, slowest first so pulling right always means
   * trading something away for speed.
   */
  readonly releaseLevers: readonly ReleaseLever[] = [
    {
      id: 'build',
      nodeType: NodeType.Build,
      field: 'optimizationLevel',
      title: 'Build',
      fallback: 'balanced',
      options: [
        { value: 'thorough', label: 'Thorough', trade: 'Full optimizer pass', mark: null },
        { value: 'balanced', label: 'Balanced', trade: 'The usual build', mark: null },
        { value: 'fast', label: 'Fast', trade: 'Skips the optimizer', mark: 'Unoptimized' },
      ],
    },
    {
      id: 'evidence',
      nodeType: NodeType.Test,
      field: 'coverageThreshold',
      title: 'Evidence',
      fallback: 75,
      options: [
        { value: 90, label: 'Deep', trade: 'Covers the edges', mark: null },
        { value: 75, label: 'Standard', trade: 'The usual bar', mark: null },
        { value: 50, label: 'Shallow', trade: 'Happy paths only', mark: 'Low evidence' },
      ],
    },
    {
      id: 'dispatch',
      nodeType: NodeType.Deploy,
      field: 'strategy',
      title: 'Dispatch',
      fallback: 'rolling',
      options: [
        { value: 'canary', label: 'Canary', trade: 'Smallest blast radius', mark: null },
        { value: 'rolling', label: 'Rolling', trade: 'Incremental batches', mark: null },
        { value: 'blue-green', label: 'Blue/green', trade: 'Flips traffic at once', mark: 'Partial rollout' },
      ],
    },
  ];

  /** Where the lock sits, and therefore how wide one second is on the rail. */
  readonly railWindowSeconds = computed(() => this.currentLevel()?.parTime ?? 0);

  /**
   * How much of the rail lies beyond the lock.
   *
   * A route that overruns has to be drawable past the gate, or a miss reads as a
   * bar that ran out of room rather than a deadline that was blown. Every rail
   * reserves a minimum strip; longer valid schedules expand the domain instead
   * of clipping their evidence.
   */
  private readonly RAIL_OVERRUN_FRACTION = 0.25;

  /** Total seconds the rail spans, including every supported scheduled stage. */
  readonly railSpanSeconds = computed(() => {
    const minimumSpan = this.railWindowSeconds() * (1 + this.RAIL_OVERRUN_FRACTION);
    const scheduledFinish = this.releaseWindowForecast()?.durationSeconds ?? 0;
    const measuredFinish = this.releaseWindowOutcome()?.actualSeconds ?? 0;
    return Math.max(minimumSpan, scheduledFinish, measuredFinish, this.gameState?.elapsedTime ?? 0);
  });

  /** Where the gate sits as a percentage of the drawn rail. */
  readonly railLockPercent = computed(() => this.railPercent(this.railWindowSeconds()));

  /**
   * The forecast the rail may draw. Null while the player still owes a call, so
   * the interface asks the question instead of answering it.
   */
  readonly visibleForecast = computed<ReleaseWindowForecast | null>(() => {
    const forecast = this.releaseWindowForecast();
    if (!forecast) return null;
    if (this.dispatchState() === 'drafting' && !this.forecastRevealed()) return null;
    return forecast;
  });

  /** Did the player's call match what the gate did? Null until it is settled. */
  readonly callAccuracy = computed<'correct' | 'wrong' | null>(() => {
    const outcome = this.releaseWindowOutcome();
    const call = this.playerCall();
    if (!outcome || !call) return null;
    const shipped = outcome.verdict === 'released';
    return (call === 'ships') === shipped ? 'correct' : 'wrong';
  });

  /** A small, declared achievement printed on the same receipt as the verdict. */
  readonly earnedFeat = computed<string | null>(() => {
    if (this.callAccuracy() !== 'correct') return null;
    if (this.activeCondition() === null && this.ticketAttemptCount() === 1) return 'First read';
    if (this.activeCondition() !== null && this.playerCall() === 'locks' && this.artifactMarks().length === 0) {
      return 'Honest lock';
    }
    return null;
  });

  /**
   * One authored line printed under the receipt headline, keyed on what
   * happened and whether the call read it right. The headline already states
   * the mechanism's result (shipped or locked, at what time); this states
   * what that meant — who was waiting on it, whether the prediction held.
   * Every branch runs its own numbers through formatReleaseSeconds so it
   * never re-derives or restates the outcome's own rounding.
   */
  readonly receiptConsequence = computed<string | null>(() => {
    const outcome = this.releaseWindowOutcome();
    const accuracy = this.callAccuracy();
    if (!outcome || !accuracy) return null;

    const actual = this.formatReleaseSeconds(outcome.actualSeconds);
    const late = this.formatReleaseSeconds(outcome.requiredReductionSeconds);

    if (outcome.verdict === 'released') {
      return accuracy === 'correct'
        ? `Out at ${actual}s. Support ships the fix tonight, and you called it.`
        : `It made it at ${actual}s. You had it held; the window forgave the read this time.`;
    }
    return accuracy === 'correct'
      ? `Held at the gate, ${late}s long. You saw it coming, and nothing went out broken.`
      : `The gate caught it, ${late}s late. Morning release now; the read was off.`;
  });

  // Screen reader announcement (bound to aria-live region in template)
  readonly srAnnouncement = signal('');
  private srAnnouncementTimer: ReturnType<typeof setTimeout> | null = null;

  // Reduced motion preference — disables particles for a11y
  private readonly prefersReducedMotion =
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Mirrors the CSS $breakpoint-mobile (56rem). SINGLE source of truth for which
  // interaction the on-screen copy describes: the dock layout, the Connect button,
  // and these hints are ALL width-gated, so the copy is gated on layout WIDTH — not
  // pointer type, which can disagree on coarse-pointer wide tablets and lie about
  // where the palette is. Live getter so it tracks resize on the next change detection.
  private readonly mobileLayoutMql = typeof window !== 'undefined' ? window.matchMedia('(max-width: 56rem)') : null;

  get isMobileLayout(): boolean {
    return this.mobileLayoutMql?.matches ?? false;
  }

  /**
   * Counter signal that's incremented at every mutation cluster boundary
   * (handleRunnerEvent end, updateGame end, loadLevel end). The template
   * reads `stateTick()` once via `@let` at the root of the dialog, which
   * forces a change-detection cycle whenever the counter increments.
   *
   * Why this exists: `gameState` and `pipeline` are mutated in-place from
   * many service paths (resourceManager.update, runner events, game tick).
   * Under `OnPush`, those in-place mutations don't trigger CD on the
   * parent. Rather than refactor 21+ mutation sites to immutable updates
   * + 50+ template bindings to `gameState()?.x`, we centralize the
   * "state changed" notification on this counter and bump it at the
   * three callbacks Angular's zone integration would otherwise miss.
   *
   * DOM event handlers (button clicks, etc.) auto-trigger CD under OnPush
   * via Angular's zone integration, so they don't need explicit bumps.
   */
  readonly stateTick = signal(0);
  private bumpState(): void {
    this.stateTick.update((v) => v + 1);
  }

  // Node drag state — owned by NodeDragControllerService.
  // Template uses `isDraggingNode()` directly via the service signal.
  private readonly dragController = inject(NodeDragControllerService);
  readonly isDraggingNode = this.dragController.isDragging;

  // UI State
  selectedNode: PipelineNode | null = null;
  hoveredNode: PipelineNode | null = null;
  readonly justClosedModal = signal(false); // Prevents immediate re-selection of nodes after modal close
  connectionStart: PipelineNode | null = null;
  // Node Palette
  readonly availableNodes = signal<Partial<PipelineNode>[]>([]);

  // ── Touch interaction signals ──────────────────────────────────────────────
  /**
   * NodeType queued for tap-to-place on the next empty-canvas tap.
   * Set by tapping a palette item; cleared after placement or deselection.
   */
  readonly pendingPlacement = signal<NodeType | null>(null);
  /**
   * When true, canvas taps route through handleShiftClick() instead of
   * normal select/place logic. Toggled by the toolbar Connect button.
   */
  readonly connectMode = signal<boolean>(false);

  // Canvas Interaction
  mouseX = 0;
  mouseY = 0;
  isDragging = false;
  isConnecting = false;
  // Set when a shift+drag completes a connection, to swallow the trailing canvas 'click'
  // event so it doesn't re-arm a new connection from the target node. Cleared by that click.
  private suppressShiftClickAfterDrag = false;
  canvasScale = 1; // Scale factor for responsive canvas rendering
  // Drag state (offset, origin, draggedNode, isDraggingNode) lives in
  // NodeDragControllerService — see this.dragController above.
  gridSize = 20;

  // Level progression
  readonly levelIndex = signal(RELEASE_DESK_LEVEL_INDEX);
  readonly levels = signal<Level[]>([]);

  // Event listener cleanup functions
  private resizeListener?: () => void;
  private visibilityListener?: () => void;
  private touchStartListener: (() => void) | null = null;
  private touchMoveListener: (() => void) | null = null;
  private touchEndListener: (() => void) | null = null;
  private orientationChangeListener: (() => void) | null = null;
  private canvasResizeObserver: ResizeObserver | null = null;

  // Input debouncing
  private lastInteractionTime = 0;

  // Tracked timeouts for cleanup
  private closeNodeDetailTimer: ReturnType<typeof setTimeout> | null = null;
  private initResizeRafHandle: number | null = null;
  private prototypeLayoutRafHandle: number | null = null;
  private prototypeRouteNeedsCanvasFit = false;

  constructor(
    private gameEngine: GameEngineService,
    private pipelineBuilder: PipelineBuilderService,
    public resourceManager: ResourceManagerService,
    private particleSystem: ParticleSystemService,
    private audioService: AudioService,
    private canvasRenderer: CanvasRendererService,
    private gameLoopService: GameLoopService,
    private runner: PipelineRunnerService,
    private sanitizer: DomSanitizer,
    private gamePhaseService: GamePhaseService,
    public undoRedoService: UndoRedoService
  ) {
    // Presentation only. Reacts to releaseWindowOutcome() by identity rather
    // than being inlined into recordReleaseWindowOutcome() so the resolve
    // moment sounds the same regardless of which code path resolved it. No
    // ledger state is written here: the ledger is captured synchronously at
    // sign-off, and must not depend on when this effect happens to flush.
    effect(() => {
      const outcome = this.releaseWindowOutcome();
      if (!outcome || outcome === this.lastAnnouncedOutcome) return;
      this.lastAnnouncedOutcome = outcome;

      // The gate reads instantly: a locked gate gets two muted thuds to match
      // the teeth clamping shut, and a released gate gets a soft two-note
      // clear. Neither node-success nor any other path in this file sounds
      // the overall release verdict, so this is the only place either plays.
      if (outcome.verdict === 'locked') {
        this.audioService.play('gate-lock');
      } else {
        this.audioService.play('gate-clear');
      }
    });
  }

  /** Flips the desk's sound on or off from the header mute control. */
  toggleMute(): void {
    const enabled = this.audioService.toggle();
    this.isMuted.set(!enabled);
  }

  ngOnInit(): void {
    if (!this.tryInitializeGame()) {
      return;
    }
    this.loadLevel(this.levelIndex());
    this.dragController.setGridSize(this.gridSize);
    this.runner.events$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((event) => {
      this.handleRunnerEvent(event);
    });
  }

  /**
   * Runs initializeGame() behind a try/catch so any failure routes into the
   * themed error overlay instead of throwing raw out of ngOnInit and leaving
   * the component half-built. The fail-closed intent is preserved: this does
   * not patch over bad data, it only makes the terminal state the desk fault
   * overlay instead of a broken component tree.
   *
   * The rendered copy is honest about the cause: a ReleaseDeskContractError
   * (requireReleaseDeskLevel's fail-closed throw) gets the specific
   * data-contract explanation, and any other exception gets cause-agnostic
   * desk-fault copy rather than a guessed diagnosis. The real error is always
   * logged either way.
   */
  private tryInitializeGame(): boolean {
    try {
      this.initializeGame();
      return true;
    } catch (error) {
      window.debugLogBridge?.log('Pipeline Panic: desk failed to open - ' + String(error), 'error');
      this.gameError.set(
        error instanceof ReleaseDeskContractError
          ? "Tonight's ticket will not open. The release desk data on file does not match its contract. Reload the shift to try again."
          : "Tonight's ticket will not open. Reload the shift to try again."
      );
      return false;
    }
  }

  ngAfterViewInit(): void {
    // Ensure canvases are available before initializing
    if (!this.gameCanvas || !this.pipelineCanvas || !this.particleCanvas) {
      window.debugLogBridge?.log('Pipeline Panic: Canvas elements not found', 'error');
      return;
    }

    this.initializeCanvas();
    this.observeCanvasSize();
    this.particleSystem.initialize(this.particleCanvas.nativeElement);
    this.audioService.initialize();

    // Set up manual event listeners with cleanup
    this.setupEventListeners();

    // Re-sync canvas dimensions on the next frame, after the browser has
    // committed initial layout. Using rAF (instead of setTimeout 50ms)
    // eliminates the race window where the animation loop could render
    // against stale dimensions before the resize fires.
    this.initResizeRafHandle = requestAnimationFrame(() => {
      this.initResizeRafHandle = null;
      this.handleCanvasResize();
      this.fitInitialPrototypeRouteToCanvas();
      this.render();
      // Start the animation loop after dimensions are confirmed.
      this.startAnimationLoop();
    });
  }

  /**
   * Angular can replace canvas nodes when a large control-flow block changes
   * shape (for example when the receipt and route hand appear). A 2D context is
   * permanently bound to the old element, so detect that rare identity change
   * and attach the renderer to the live canvases before the next frame.
   */
  ngAfterViewChecked(): void {
    const gameCanvas = this.gameCanvas?.nativeElement;
    const pipelineCanvas = this.pipelineCanvas?.nativeElement;
    if (!gameCanvas || !pipelineCanvas) return;
    if (this.ctx?.canvas === gameCanvas && this.pipelineCtx?.canvas === pipelineCanvas) return;

    this.initializeCanvas();
    this.observeCanvasSize();
    this.particleSystem.initialize(this.particleCanvas.nativeElement);
    this.handleCanvasResize();
    this.render();
  }

  private setupEventListeners(): void {
    // Window resize listener with debounce
    this.resizeListener = this.renderer.listen('window', 'resize', () => {
      this.onWindowResize();
    });

    // Document visibility change listener
    this.visibilityListener = this.renderer.listen('document', 'visibilitychange', () => {
      this.onVisibilityChange();
    });

    // Touch event listeners for mobile canvas interaction
    // Use native addEventListener with { passive: false } so preventDefault() works.
    // Angular Renderer2.listen() does not support passive options, causing
    // preventDefault() to be ignored in modern browsers for touch events.
    const pipelineEl = this.pipelineCanvas?.nativeElement;
    if (pipelineEl) {
      const touchStartHandler = (e: TouchEvent): void => this.handleTouchStart(e);
      const touchMoveHandler = (e: TouchEvent): void => this.handleTouchMove(e);
      const touchEndHandler = (e: TouchEvent): void => this.handleTouchEnd(e);
      pipelineEl.addEventListener('touchstart', touchStartHandler, { passive: false });
      pipelineEl.addEventListener('touchmove', touchMoveHandler, { passive: false });
      pipelineEl.addEventListener('touchend', touchEndHandler, { passive: false });
      this.touchStartListener = () => pipelineEl.removeEventListener('touchstart', touchStartHandler);
      this.touchMoveListener = () => pipelineEl.removeEventListener('touchmove', touchMoveHandler);
      this.touchEndListener = () => pipelineEl.removeEventListener('touchend', touchEndHandler);
    }

    // Orientation change listener for mobile — resize canvas after rotation
    this.setupOrientationChangeListener();
  }

  /**
   * Listen for device orientation changes (landscape ↔ portrait).
   * Uses the modern screen.orientation API with a fallback to the deprecated
   * window.orientationchange event for older browsers.
   * Canvas resize is delayed 150ms to let the rotation animation finish.
   */
  private orientationResizeTimer: ReturnType<typeof setTimeout> | null = null;

  private setupOrientationChangeListener(): void {
    const scheduleResize = (): void => {
      // Clear any pending orientation resize to avoid stacking
      if (this.orientationResizeTimer) {
        clearTimeout(this.orientationResizeTimer);
      }
      // Delay resize to let orientation animation complete
      this.orientationResizeTimer = setTimeout(() => {
        this.orientationResizeTimer = null;
        this.handleCanvasResize();
      }, 150);
    };

    if (window.screen.orientation && typeof window.screen.orientation.addEventListener === 'function') {
      window.screen.orientation.addEventListener('change', scheduleResize);
      this.orientationChangeListener = () => window.screen.orientation.removeEventListener('change', scheduleResize);
    } else {
      window.addEventListener('orientationchange', scheduleResize);
      this.orientationChangeListener = () => window.removeEventListener('orientationchange', scheduleResize);
    }
  }

  ngOnDestroy(): void {
    this.gameLoopService.destroy();

    // Clear resize timeout if pending
    if (this.resizeTimeout) {
      clearTimeout(this.resizeTimeout);
      this.resizeTimeout = null;
    }

    // Clear all active execution intervals
    this.runner.destroy();

    // Remove event listeners
    if (this.resizeListener) {
      this.resizeListener();
      this.resizeListener = undefined;
    }
    if (this.visibilityListener) {
      this.visibilityListener();
      this.visibilityListener = undefined;
    }
    if (this.touchStartListener) {
      this.touchStartListener();
      this.touchStartListener = null;
    }
    if (this.touchMoveListener) {
      this.touchMoveListener();
      this.touchMoveListener = null;
    }
    if (this.touchEndListener) {
      this.touchEndListener();
      this.touchEndListener = null;
    }
    if (this.orientationChangeListener) {
      this.orientationChangeListener();
      this.orientationChangeListener = null;
    }
    this.canvasResizeObserver?.disconnect();
    this.canvasResizeObserver = null;
    if (this.orientationResizeTimer) {
      clearTimeout(this.orientationResizeTimer);
      this.orientationResizeTimer = null;
    }

    // Clear canvas context references to prevent memory leaks
    if (this.ctx) {
      this.ctx.clearRect(0, 0, this.ctx.canvas.width, this.ctx.canvas.height);
      this.ctx = null;
    }
    if (this.pipelineCtx) {
      this.pipelineCtx.clearRect(0, 0, this.pipelineCtx.canvas.width, this.pipelineCtx.canvas.height);
      this.pipelineCtx = null;
    }

    // Clear SR announcement timer
    if (this.srAnnouncementTimer) {
      clearTimeout(this.srAnnouncementTimer);
      this.srAnnouncementTimer = null;
    }

    if (this.closeNodeDetailTimer) {
      clearTimeout(this.closeNodeDetailTimer);
      this.closeNodeDetailTimer = null;
    }
    if (this.initResizeRafHandle !== null) {
      cancelAnimationFrame(this.initResizeRafHandle);
      this.initResizeRafHandle = null;
    }
    if (this.prototypeLayoutRafHandle !== null) {
      cancelAnimationFrame(this.prototypeLayoutRafHandle);
      this.prototypeLayoutRafHandle = null;
    }
    this.particleSystem.clear();
  }

  private handleRunnerEvent(event: RunnerEvent): void {
    switch (event.type) {
      case 'started':
        this.gameState.elapsedTime = 0;
        this.audioService.play('start');
        this.gamePhaseService.transition('executing');
        this.announce('Release dispatched');
        break;

      case 'logical-time':
        this.gameState.elapsedTime = event.elapsedSeconds;
        break;

      case 'node-success': {
        this.audioService.play('success');
        this.announce(`${event.node.name} cleared`);
        this.safeParticleBurst(event.node.x, event.node.y, event.node.color);
        break;
      }

      case 'node-failure': {
        this.audioService.play('error');
        this.announce(`${event.node.name} failed`);
        this.safeParticleBurst(event.node.x, event.node.y, '#ff5d67');
        break;
      }

      case 'pipeline-complete': {
        this.artifactMarks.set(event.result.artifactMarks);
        this.recordReleaseWindowOutcome(event.result.success);
        this.gamePhaseService.reset();
        this.announce(
          event.result.success ? 'Release result recorded. Receipt ready.' : 'Release interrupted. Receipt ready.'
        );
        break;
      }

      case 'stopped':
        this.audioService.play('stop');
        this.gamePhaseService.reset();
        this.prepareReleaseAttempt();
        this.announce('Dispatch stopped. The route is ready for another call.');
        break;

      default:
        break;
    }

    this.bumpState();
  }

  private initializeGame(): void {
    // Assigned first, and ahead of anything below that can throw (loadLevels(),
    // requireReleaseDeskLevel()): the template reads this.pipeline unconditionally
    // on every render, contract failure or not, so it must never be left unset
    // partway through a failed initialization.
    this.pipeline = this.pipelineBuilder.createEmptyPipeline();
    this.levels.set(this.gameEngine.loadLevels());
    this.releaseWindowOutcome.set(null);
    this.activeReleaseWindowForecast = null;
    const releaseDesk = this.requireReleaseDeskLevel();
    this.gameState = this.createNewGameState();
    this.gameState.level = RELEASE_DESK_LEVEL_INDEX + 1;
    this.gameState.currentLevel = releaseDesk;
    this.levelIndex.set(RELEASE_DESK_LEVEL_INDEX);
    this.currentLevel.set(releaseDesk);
    if (this.prefersReducedMotion) {
      this.gameState.particlesEnabled = false;
    }
    this.setupNodePalette();
  }

  private createNewGameState(): GameState {
    const releaseDesk = this.requireReleaseDeskLevel();
    return {
      level: RELEASE_DESK_LEVEL_INDEX + 1,
      currentLevel: releaseDesk,
      currentPipeline: this.pipeline,
      elapsedTime: 0,
      cpu: { total: 100, used: 0, available: 100, cost: 1 },
      memory: { total: 1000, used: 0, available: 1000, cost: 0.5 },
      buildAgents: { total: 5, used: 0, available: 5, cost: 10 },
      particlesEnabled: true,
    };
  }

  /** Fail closed if authored level data no longer matches the front-door contract. */
  private requireReleaseDeskLevel(): Level {
    const releaseDesk = this.levels()[RELEASE_DESK_LEVEL_INDEX];
    if (!releaseDesk || releaseDesk.id !== RELEASE_DESK_ID || !isControlledPrototype(releaseDesk)) {
      throw new ReleaseDeskContractError('Pipeline Panic release desk level contract is missing or misconfigured.');
    }
    return releaseDesk;
  }

  private initializeCanvas(): void {
    const canvas = this.gameCanvas.nativeElement;
    const pipelineCanvas = this.pipelineCanvas.nativeElement;
    const particleCanvas = this.particleCanvas.nativeElement;

    // Set canvas dimensions with device pixel ratio support
    const parentElement = canvas.parentElement;
    if (!parentElement) return;
    const rect = parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const canvasWidth = Math.floor(rect.width * dpr);
    const canvasHeight = Math.floor(rect.height * dpr);

    // Set actual canvas size accounting for device pixel ratio
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    pipelineCanvas.width = canvasWidth;
    pipelineCanvas.height = canvasHeight;
    particleCanvas.width = canvasWidth;
    particleCanvas.height = canvasHeight;

    // Scale canvas back down using CSS
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    pipelineCanvas.style.width = rect.width + 'px';
    pipelineCanvas.style.height = rect.height + 'px';
    particleCanvas.style.width = rect.width + 'px';
    particleCanvas.style.height = rect.height + 'px';

    const ctx = canvas.getContext('2d');
    const pipelineCtx = pipelineCanvas.getContext('2d');
    const particleCtx = particleCanvas.getContext('2d');

    if (ctx && pipelineCtx) {
      this.ctx = ctx;
      this.pipelineCtx = pipelineCtx;

      // Apply DPR scaling to contexts
      ctx.scale(dpr, dpr);
      pipelineCtx.scale(dpr, dpr);
      if (particleCtx) {
        particleCtx.scale(dpr, dpr);
      }

      // Setup canvas style
      ctx.imageSmoothingEnabled = true;
      pipelineCtx.imageSmoothingEnabled = true;

      // Force initial render to show grid
      if (this.canvasRenderer) {
        const width = rect.width;
        const height = rect.height;
        const context = this.createRenderContext();
        this.canvasRenderer.render(ctx, pipelineCtx, width, height, context);
      }
    }
  }

  private setupNodePalette(): void {
    const nodes: Partial<PipelineNode>[] = [
      {
        type: NodeType.Source,
        name: 'Git Source',
        icon: 'SRC',
        color: '#60a5fa',
      },
      {
        type: NodeType.Build,
        name: 'Build',
        icon: 'BLD',
        color: '#34d399',
      },
      {
        type: NodeType.Test,
        name: 'Test',
        icon: 'TST',
        color: '#fbbf24',
      },
      {
        type: NodeType.SecurityScan,
        name: 'Security Scan',
        icon: 'SEC',
        color: '#f87171',
      },
      {
        type: NodeType.Deploy,
        name: 'Deploy',
        icon: 'DPY',
        color: '#a78bfa',
      },
      {
        type: NodeType.Parallel,
        name: 'Parallel',
        icon: 'PAR',
        color: '#f97316',
      },
    ];
    this.availableNodes.set(nodes);
  }

  loadLevel(index: number): void {
    if (index !== RELEASE_DESK_LEVEL_INDEX) return;
    this.levels.set(this.gameEngine.loadLevels());
    const lvl = this.requireReleaseDeskLevel();
    this.levelIndex.set(RELEASE_DESK_LEVEL_INDEX);
    this.currentLevel.set(lvl);
    this.applyActiveCondition(lvl);
    this.resetDispatch(true);
    this.gameState.currentLevel = lvl;
    this.gameState.level = RELEASE_DESK_LEVEL_INDEX + 1;
    this.gameState.elapsedTime = 0;
    this.pipeline = this.pipelineBuilder.createEmptyPipeline();
    this.activeReleaseRoutePlanId.set(null);
    this.prototypeWorkbenchOpen.set(false);
    this.routeDecisionMade.set(false);
    this.ticketAttemptCount.set(0);
    this.shiftComplete.set(false);
    this.shiftLedger.set([]);
    this.routeChangeCarriedFeat = null;
    this.pendingRouteChangeSecondsReclaimed = null;

    this.selectedNode = null;
    this.hoveredNode = null;
    this.connectionStart = null;
    this.isConnecting = false;
    this.dragController.cancel();
    this.runner.reset();
    this.runner.setGameSpeed(1);
    this.gamePhaseService.reset();
    this.undoRedoService.clear();
    this.resourceManager.resetResources(lvl);
    this.resourceManager.reconcile(this.pipeline.nodes);
    this.gameState.cpu = this.resourceManager.getCpu();
    this.gameState.memory = this.resourceManager.getMemory();
    this.gameState.buildAgents = this.resourceManager.getBuildAgents();
    this.setupNodePalette();
    this.installReleaseRoutePlan('serial');
    this.forceRenderCanvas();
    this.updateReleaseWindowForecast();
    this.bumpState();
  }

  /**
   * Force render the canvas to show current state.
   * Used after level transitions to clear old nodes from display.
   */
  private forceRenderCanvas(): void {
    if (!this.ctx || !this.pipelineCtx) return;

    const canvas = this.gameCanvas?.nativeElement;
    const parentElement = canvas?.parentElement;
    if (!canvas || !parentElement) return;

    const rect = parentElement.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    if (width === 0 || height === 0) return;

    const context = this.createRenderContext();
    this.canvasRenderer.render(this.ctx, this.pipelineCtx, width, height, context);
  }

  // DRAG AND DROP
  onNodeDragStart(event: DragEvent, node: Partial<PipelineNode>): void {
    if (!this.gamePhaseService.isBuilding) return;
    // Reaching for a node from the palette is a clean task switch away from connecting:
    // drop any pending connection so a half-made wire doesn't linger behind the new node.
    this.cancelPendingConnection();
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData('nodeType', node.type ?? '');
    }
    // Note: Resource check happens in addNode() when actually placing the node
  }

  onCanvasDrop(event: DragEvent): void {
    event.preventDefault();
    if (!this.gamePhaseService.isBuilding) return;
    if (this.isDebounced()) return;

    const nodeType = event.dataTransfer?.getData('nodeType') as NodeType;
    if (!nodeType) return;

    const rect = this.gameCanvas.nativeElement.getBoundingClientRect();
    const nodeRadius = 30;

    // Calculate position with grid snapping
    let x = Math.round((event.clientX - rect.left) / this.gridSize) * this.gridSize;
    let y = Math.round((event.clientY - rect.top) / this.gridSize) * this.gridSize;

    // Ensure node stays within canvas bounds
    x = Math.max(nodeRadius, Math.min(rect.width - nodeRadius, x));
    y = Math.max(nodeRadius, Math.min(rect.height - nodeRadius, y));

    // Validate coordinates are finite
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return;
    }

    this.addNode(nodeType, x, y);
  }

  onCanvasDragOver(event: DragEvent): void {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
  }

  onCanvasClick(event: MouseEvent): void {
    // Swallow the trailing click that a shift+drag connection emits, so completing a
    // connection by dragging doesn't immediately start a new one from the target node.
    // MUST run before the debounce gate: if this trailing click lands inside the debounce
    // window, an early return there would leave the flag stuck and eat the next real click.
    if (this.suppressShiftClickAfterDrag) {
      this.suppressShiftClickAfterDrag = false;
      return;
    }

    if (this.isDebounced()) return;

    const rect = this.pipelineCanvas.nativeElement.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const clickY = event.clientY - rect.top;

    // Validate coordinates are finite
    if (!Number.isFinite(clickX) || !Number.isFinite(clickY)) return;

    // Completed-level inspection is deliberately read-only. Keep node
    // selection available so the player can inspect the artifact, but do not
    // let canvas gestures mutate it.
    if (!this.gamePhaseService.isBuilding) {
      const clickedNode = this.getNodeAtPosition(clickX, clickY);
      this.selectedNode = clickedNode && !this.justClosedModal() ? clickedNode : null;
      return;
    }

    // Check if Shift is held - if so, handle connection mode
    if (event.shiftKey) {
      const clickedNode = this.getNodeAtPosition(clickX, clickY);
      if (clickedNode) {
        this.handleShiftClick(clickedNode);
        return;
      } else {
        // Shift+clicked on empty space - cancel any pending connection
        this.isConnecting = false;
        this.connectionStart = null;
        return;
      }
    }

    // A queued palette node takes precedence over connection selection. Pointer,
    // touch, and keyboard placement all clear the queue only after addNode succeeds.
    const pending = this.pendingPlacement();
    if (pending !== null) {
      const clickedNode = this.getNodeAtPosition(clickX, clickY);
      if (clickedNode) {
        this.pendingPlacement.set(null);
        this.selectNode(clickedNode);
      } else {
        const point = this.getBoundedGridPoint(clickX, clickY, rect);
        if (point) {
          this.placePendingNodeAt(point.x, point.y);
        }
      }
      return;
    }

    // Check if Alt is held and clicking on a connection - reverse it
    const connection = this.getConnectionAtPosition(clickX, clickY);
    if (connection) {
      if (event.altKey) {
        this.reverseConnection(connection);
        return;
      } else {
        this.removeConnection(connection);
        return;
      }
    }

    // Select node if clicked - but not if we just closed a modal
    const clickedNode = this.getNodeAtPosition(clickX, clickY);
    if (clickedNode && !this.justClosedModal()) {
      this.selectedNode = clickedNode;
    } else if (!clickedNode) {
      this.selectedNode = null;
      this.isConnecting = false;
      this.connectionStart = null;
      // Clear any pending tap-to-place selection when clicking empty canvas on desktop
      this.pendingPlacement.set(null);
    }
  }

  private addNode(type: NodeType, x: number, y: number): boolean {
    const nodeTemplate = this.availableNodes().find((n) => n.type === type);
    if (!nodeTemplate || !nodeTemplate.name || !nodeTemplate.color || !nodeTemplate.icon) {
      this.placementRefusedReason.set('Cannot place that stage: it is not recognized on this desk.');
      return false;
    }

    const lvl = this.currentLevel();
    // Check max nodes limit
    const maxNodes = lvl?.maxNodes ?? GAME_CONSTANTS.MAX_NODES_PER_PIPELINE;
    if (this.pipeline.nodes.length >= maxNodes) {
      this.placementRefusedReason.set(
        `Cannot add ${nodeTemplate.name}: the route already has the maximum ${maxNodes} stages. Remove one first.`
      );
      this.audioService.play('error');
      return false;
    }

    // Check for forbidden node types
    if (lvl?.forbiddenNodes?.includes(type)) {
      this.placementRefusedReason.set(`Cannot add ${nodeTemplate.name}: this ticket forbids that stage type.`);
      this.audioService.play('error');
      return false;
    }

    // Validate coordinates
    if (!PipelineBuilderService.isValidCoordinate(x, y)) {
      window.debugLogBridge?.log(`Invalid node coordinates: (${x}, ${y})`, 'error');
      this.placementRefusedReason.set(`Cannot place ${nodeTemplate.name}: that position is out of bounds.`);
      return false;
    }

    // Check for overlapping nodes
    const tooClose = this.pipelineBuilder.isNodeTooClose(x, y, this.pipeline.nodes);
    if (tooClose) {
      this.placementRefusedReason.set(
        `Cannot add ${nodeTemplate.name}: too close to an existing stage. Choose another spot.`
      );
      this.audioService.play('error');
      return false;
    }

    const newNode: PipelineNode = {
      id: `node-${Date.now()}`,
      type,
      name: nodeTemplate.name,
      x,
      y,
      // Stamp the placement time once so the node "pops" in. Created once and replayed by
      // the undo/redo command, so on redo this timestamp is already stale and the pop is
      // skipped (intended) — do not move this into the command's execute().
      placedAt: Date.now(),
      status: NodeStatus.Idle,
      config: this.getDefaultNodeConfig(type),
      processingTime: 0,
      cpuUsage: 10,
      memoryUsage: 100,
      inputs: [],
      outputs: [],
      color: nodeTemplate.color,
      icon: nodeTemplate.icon,
      particles: [],
      // Execution history for retry-aware logging
      executionCount: 0,
      lastStatus: null,
      lastFailureReason: undefined,
    };

    // Check if we can afford this node BEFORE adding it
    const canAfford = this.resourceManager.canAddNode(newNode);
    if (!canAfford) {
      const reason = `No capacity left on this route for ${newNode.name}. Clear a stage to make room.`;
      this.placementRefusedReason.set(reason);
      this.announce(reason);
      this.audioService.play('error');
      return false;
    }

    // Every gate cleared — drop any refusal message left from a previous attempt.
    this.placementRefusedReason.set(null);

    // Execute via undo/redo command
    const command: PipelineCommand = {
      type: 'place-node',
      execute: () => {
        this.pipeline.nodes.push(newNode);
        this.resourceManager.allocateNodeResources(newNode);
        this.gameState.cpu = this.resourceManager.getCpu();
        this.gameState.memory = this.resourceManager.getMemory();
        this.validatePipeline();
      },
      undo: () => {
        this.pipeline.connections = this.pipeline.connections.filter(
          (c) => c.sourceId !== newNode.id && c.targetId !== newNode.id
        );
        this.pipeline.nodes.forEach((n) => {
          n.inputs = n.inputs.filter((id) => id !== newNode.id);
          n.outputs = n.outputs.filter((id) => id !== newNode.id);
        });
        this.pipeline.nodes = this.pipeline.nodes.filter((n) => n.id !== newNode.id);
        this.resourceManager.freeNodeResources(newNode);
        this.gameState.cpu = this.resourceManager.getCpu();
        this.gameState.memory = this.resourceManager.getMemory();
        if (this.selectedNode?.id === newNode.id) {
          this.selectedNode = null;
        }
        this.resourceManager.reconcile(this.pipeline.nodes);
        this.validatePipeline();
      },
    };
    this.undoRedoService.execute(command);

    // Play sound
    this.audioService.play('place');

    // Log
    this.announce(`${newNode.name} node placed on canvas`);

    // Trigger particle effect
    this.safeParticleBurst(x, y, newNode.color);

    return true;
  }

  getDefaultNodeConfig(type: NodeType): NodeConfig {
    // TIMING: Reduced timeEstimates ~35% to hit ~10s pipeline execution
    // Previous times created 15s pipelines, now targeting 10s
    const configs: Record<NodeType, NodeConfig> = {
      [NodeType.Source]: {
        cpuRequired: 5,
        memoryRequired: 50,
        timeEstimate: 1, // Reduced from 2 - quick git fetch
        failureRate: 0.01,
        flakiness: 0,
      },
      [NodeType.Build]: {
        language: 'javascript',
        buildCommand: 'npm run build',
        cpuRequired: 20,
        memoryRequired: 200,
        timeEstimate: 3, // Fast build for snappy gameplay
        failureRate: 0.05,
        flakiness: 0.02,
      },
      [NodeType.Test]: {
        testType: 'unit',
        coverage: 80,
        threshold: 70,
        cpuRequired: 15,
        memoryRequired: 150,
        timeEstimate: 3, // Fast tests for snappy gameplay
        failureRate: 0.1,
        flakiness: 0.05,
      },
      [NodeType.Deploy]: {
        environment: 'dev',
        strategy: 'rolling',
        rollbackEnabled: true,
        cpuRequired: 10,
        memoryRequired: 100,
        timeEstimate: 3, // Reduced from 5 - faster deploy
        failureRate: 0.02,
        flakiness: 0.01,
      },
      [NodeType.SecurityScan]: {
        scanType: 'sast' as const,
        cpuRequired: 15,
        memoryRequired: 150,
        timeEstimate: 4, // Fast scan for snappy gameplay
        // SecurityScan's failure mechanism is the P4 severity gate (checkSeverityGate),
        // NOT the generic config failure roll — getConfigFailureRate ignores non-Build
        // nodes. Keep these at 0 so the config doesn't advertise a rate that never fires.
        failureRate: 0,
        flakiness: 0,
      },
      [NodeType.QualityGate]: {
        threshold: 1.0, // 100% upstream tests must pass
        cpuRequired: 10,
        memoryRequired: 100,
        timeEstimate: 1.0, // Fast gate check
        failureRate: 0,
        flakiness: 0,
      },
      [NodeType.Rollback]: {
        environment: 'production',
        rollbackEnabled: true,
        cpuRequired: 15,
        memoryRequired: 150,
        timeEstimate: 5, // Reduced from 8
        failureRate: 0.01,
        flakiness: 0,
      },
      [NodeType.Notification]: {
        cpuRequired: 2,
        memoryRequired: 20,
        timeEstimate: 1, // Keep fast
        failureRate: 0.01,
        flakiness: 0,
      },
      [NodeType.Approval]: {
        cpuRequired: 1,
        memoryRequired: 10,
        timeEstimate: 5, // Simulates manual review delay — the time cost IS the mechanic
        failureRate: 0,
        flakiness: 0,
      },
      [NodeType.Parallel]: {
        cpuRequired: 30,
        memoryRequired: 300,
        // Parallel is a control flow node - near-instant execution
        // It just starts downstream branches simultaneously
        timeEstimate: 0.2,
        failureRate: 0.02,
        flakiness: 0.01,
      },
      [NodeType.Conditional]: {
        cpuRequired: 5,
        memoryRequired: 50,
        // Conditional is a control flow node - near-instant
        timeEstimate: 0.2,
        failureRate: 0.01,
        flakiness: 0,
      },
      [NodeType.Cache]: {
        cpuRequired: 5,
        memoryRequired: 100,
        timeEstimate: 0.5, // Fast on miss; instant on hit (handled by runner)
        failureRate: 0,
        flakiness: 0,
      },
      [NodeType.Artifact]: {
        cpuRequired: 8,
        memoryRequired: 80,
        timeEstimate: 2, // Reduced from 3
        failureRate: 0.02,
        flakiness: 0.01,
      },
    };

    return configs[type] || configs[NodeType.Source];
  }

  // CONNECTION HANDLING & NODE DRAGGING
  @HostListener('mousedown', ['$event'])
  onMouseDown(event: Event): void {
    if (!(event instanceof MouseEvent)) return;
    if (event.target !== this.pipelineCanvas?.nativeElement) return;

    const rect = this.pipelineCanvas.nativeElement.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    // Check if clicking on a node
    const clickedNode = this.getNodeAtPosition(x, y);

    if (!this.gamePhaseService.isBuilding) {
      this.selectedNode = clickedNode;
      return;
    }

    if (clickedNode) {
      if (event.shiftKey) {
        // Start connection
        this.startConnection(clickedNode);
      } else {
        // Select node and start dragging — controller captures origin/offset
        this.selectNode(clickedNode);
        this.dragController.startDrag(clickedNode, x, y);
      }
    } else {
      // Deselect
      this.selectedNode = null;
    }
  }

  @HostListener('mousemove', ['$event'])
  onMouseMove(event: Event): void {
    if (!this.pipelineCanvas) return;
    if (!(event instanceof MouseEvent)) return;

    const rect = this.pipelineCanvas.nativeElement.getBoundingClientRect();

    // Direct mouse coordinates (no additional scaling needed)
    this.mouseX = event.clientX - rect.left;
    this.mouseY = event.clientY - rect.top;

    // Handle node dragging via the controller (snap-to-grid + clamp)
    if (this.dragController.isDragging()) {
      const canvasParent = this.pipelineCanvas.nativeElement.parentElement;
      if (!canvasParent) return;
      const parentRect = canvasParent.getBoundingClientRect();
      this.dragController.dragTo(this.mouseX, this.mouseY, parentRect.width, parentRect.height);
      return; // Skip hover detection while dragging
    }

    // Update hovered node
    this.hoveredNode = this.getNodeAtPosition(this.mouseX, this.mouseY);
  }

  @HostListener('mouseup', ['$event'])
  onMouseUp(_event: Event): void {
    if (!this.gamePhaseService.isBuilding) {
      this.dragController.cancel();
      this.connectionStart = null;
      this.isConnecting = false;
      return;
    }

    // Finalize any in-progress drag. Controller returns a record only
    // when the node actually moved; we use it to record undo.
    const dragRecord = this.dragController.endDrag();
    if (dragRecord) {
      const { node, fromX, fromY, toX, toY } = dragRecord;
      // execute() is a no-op here because the drag already moved the node to toX/toY.
      // On redo, execute() restores the final position.
      this.undoRedoService.execute({
        type: 'move-node',
        execute: () => {
          node.x = toX;
          node.y = toY;
        },
        undo: () => {
          node.x = fromX;
          node.y = fromY;
        },
      });
    }

    // Complete connection
    if (this.isConnecting && this.connectionStart) {
      const endNode = this.getNodeAtPosition(this.mouseX, this.mouseY);
      if (endNode && endNode !== this.connectionStart) {
        this.createConnection(this.connectionStart, endNode);
        // A shift+drag fires a trailing 'click' on the canvas at the release point.
        // Swallow it so it doesn't immediately re-arm a new connection from the target
        // node (which would leave a phantom line trailing the cursor after every connect).
        this.suppressShiftClickAfterDrag = true;
      }
      this.connectionStart = null;
      this.isConnecting = false;
    }
  }

  private resizeTimeout: ReturnType<typeof setTimeout> | null = null;

  // Window resize handler with built-in debouncing
  private onWindowResize(): void {
    // Debounce resize events to avoid excessive redraws
    if (this.resizeTimeout) {
      clearTimeout(this.resizeTimeout);
    }
    this.resizeTimeout = setTimeout(() => {
      this.handleCanvasResize();
    }, 100);
  }

  /**
   * The receipt, route hand, and lever bank all change the canvas row without a
   * browser resize event. Follow the actual wrapper so its backing buffers and
   * node geometry stay in sync through every ticket state.
   */
  private observeCanvasSize(): void {
    const parent = this.gameCanvas?.nativeElement.parentElement;
    if (!parent || typeof ResizeObserver === 'undefined') return;

    this.canvasResizeObserver?.disconnect();
    this.canvasResizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry || entry.contentRect.width < 1 || entry.contentRect.height < 1) return;
      this.handleCanvasResize();
      this.render();
    });
    this.canvasResizeObserver.observe(parent);
  }

  private handleCanvasResize(): void {
    if (!this.gameCanvas || !this.pipelineCanvas || !this.particleCanvas) {
      return;
    }

    const canvas = this.gameCanvas.nativeElement;
    const pipelineCanvas = this.pipelineCanvas.nativeElement;
    const particleCanvas = this.particleCanvas.nativeElement;

    const parentElement = canvas.parentElement;
    if (!parentElement) return;

    const rect = parentElement.getBoundingClientRect();

    // Set canvas dimensions with device pixel ratio for crisp rendering
    const dpr = window.devicePixelRatio || 1;
    const width = rect.width;
    const height = rect.height;
    const previousWidth = Number.parseFloat(canvas.style.width);
    const previousHeight = Number.parseFloat(canvas.style.height);

    // Opening/closing the patch bay changes the center column without a window
    // resize. Keep the dealt route inside the new desk instead of clipping its
    // right-hand stages.
    if (
      Number.isFinite(previousWidth) &&
      Number.isFinite(previousHeight) &&
      previousWidth >= 320 &&
      previousHeight >= 220 &&
      width >= 320 &&
      height >= 220 &&
      (Math.abs(previousWidth - width) > 1 || Math.abs(previousHeight - height) > 1)
    ) {
      const scaleX = width / previousWidth;
      const scaleY = height / previousHeight;
      this.pipeline.nodes.forEach((node) => {
        node.x = Math.min(width - GAME_CONSTANTS.NODE_RADIUS, Math.max(GAME_CONSTANTS.NODE_RADIUS, node.x * scaleX));
        node.y = Math.min(height - GAME_CONSTANTS.NODE_RADIUS, Math.max(GAME_CONSTANTS.NODE_RADIUS, node.y * scaleY));
      });
    }

    // Set actual canvas size accounting for device pixel ratio
    // Use floor to avoid sub-pixel rendering issues
    const canvasWidth = Math.floor(width * dpr);
    const canvasHeight = Math.floor(height * dpr);

    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    pipelineCanvas.width = canvasWidth;
    pipelineCanvas.height = canvasHeight;
    particleCanvas.width = canvasWidth;
    particleCanvas.height = canvasHeight;

    // Scale canvas back down using CSS
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    pipelineCanvas.style.width = width + 'px';
    pipelineCanvas.style.height = height + 'px';
    particleCanvas.style.width = width + 'px';
    particleCanvas.style.height = height + 'px';

    // Reset and apply scale transform to contexts for proper rendering
    const gameCtx = this.gameCanvas.nativeElement.getContext('2d');
    const pipelineCtx = this.pipelineCanvas.nativeElement.getContext('2d');
    const particleCtx = this.particleCanvas.nativeElement.getContext('2d');

    if (gameCtx && pipelineCtx) {
      // Update our references
      this.ctx = gameCtx;
      this.pipelineCtx = pipelineCtx;

      // Reset transforms before applying new ones
      gameCtx.setTransform(1, 0, 0, 1, 0, 0);
      pipelineCtx.setTransform(1, 0, 0, 1, 0, 0);

      // Apply DPR scale for crisp rendering
      gameCtx.scale(dpr, dpr);
      pipelineCtx.scale(dpr, dpr);

      // Also scale particle canvas for consistent DPR rendering
      if (particleCtx) {
        particleCtx.setTransform(1, 0, 0, 1, 0, 0);
        particleCtx.scale(dpr, dpr);
      }

      // Store scale factor as 1 (no additional scaling needed)
      this.canvasScale = 1;

      // Force render to show grid immediately
      this.render();
    }
  }

  private startConnection(node: PipelineNode): void {
    this.connectionStart = node;
    this.isConnecting = true;
    this.audioService.play('click');
  }

  private createConnection(source: PipelineNode, target: PipelineNode): void {
    // Check max connections limit
    const maxConns = this.currentLevel()?.maxConnections ?? GAME_CONSTANTS.MAX_CONNECTIONS_PER_PIPELINE;
    if (this.pipeline.connections.length >= maxConns) {
      this.audioService.play('error');
      return;
    }

    // Validate connection
    if (!this.pipelineBuilder.canConnect(source, target)) {
      this.audioService.play('error');
      return;
    }

    // Create connection
    const connection: Connection = {
      id: `conn-${Date.now()}`,
      sourceId: source.id,
      targetId: target.id,
      status: 'inactive',
      dataFlow: [],
    };

    const command: PipelineCommand = {
      type: 'create-connection',
      execute: () => {
        source.outputs.push(target.id);
        target.inputs.push(source.id);
        this.pipeline.connections.push(connection);
        this.validatePipeline();
      },
      undo: () => {
        source.outputs = source.outputs.filter((id) => id !== target.id);
        target.inputs = target.inputs.filter((id) => id !== source.id);
        this.pipeline.connections = this.pipeline.connections.filter((c) => c.id !== connection.id);
        this.validatePipeline();
      },
    };
    this.undoRedoService.execute(command);

    this.audioService.play('connect');
    this.announce(`Connected ${source.name} to ${target.name}`);
  }

  /**
   * Handle a connect-gesture click/tap on a node. Returns true only when a connection
   * was actually completed (so the touch caller knows when to leave connect mode; a
   * cancel or a fresh start must NOT exit the mode).
   */
  private handleShiftClick(node: PipelineNode): boolean {
    if (!this.isConnecting) {
      this.startConnection(node);
      return false;
    }
    if (this.connectionStart && this.connectionStart.id === node.id) {
      // Clicking/tapping the source node again cancels the pending connection.
      this.cancelPendingConnection();
      return false;
    }
    if (this.connectionStart && this.connectionStart.id !== node.id) {
      this.createConnection(this.connectionStart, node);
      this.isConnecting = false;
      this.connectionStart = null;
      return true;
    }
    return false;
  }

  // Cancel a pending connection (clears the armed source). Called on Esc, clicking empty
  // canvas, clicking the source node again, or starting to place a node from the palette.
  private cancelPendingConnection(): void {
    if (this.isConnecting && this.connectionStart) {
      this.connectionStart = null;
      this.isConnecting = false;
    }
  }

  // ── Touch-specific interaction handlers ────────────────────────────────────

  /**
   * Called when a palette item is tapped (touch or click on the palette).
   * Sets pendingPlacement so the next empty-canvas tap places the node.
   * Tapping the same item while it's already pending deselects it.
   * Entering placement mode exits connect mode.
   */
  onNodeTap(type: NodeType): void {
    if (this.isRunning || !this.gamePhaseService.isBuilding) return;
    if (this.pendingPlacement() === type) {
      // Second tap on the same item: deselect
      this.pendingPlacement.set(null);
    } else {
      this.pendingPlacement.set(type);
      // Placement mode takes precedence — exit connect mode
      this.connectMode.set(false);
      this.isConnecting = false;
      this.connectionStart = null;
    }
  }

  /** Place the queued palette node at the first open canvas position. */
  onCanvasPlacementKey(event: KeyboardEvent): void {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const pending = this.pendingPlacement();
    if (pending === null || this.isRunning || !this.gamePhaseService.isBuilding) return;

    event.preventDefault();
    const point = this.findKeyboardPlacementPoint(this.pipelineCanvas.nativeElement.getBoundingClientRect());
    if (!point) {
      this.announce('No open canvas position is available');
      return;
    }

    this.placePendingNodeAt(point.x, point.y);
  }

  private placePendingNodeAt(x: number, y: number): boolean {
    const pending = this.pendingPlacement();
    if (pending === null || !this.addNode(pending, x, y)) return false;
    this.pendingPlacement.set(null);
    return true;
  }

  private getBoundedGridPoint(x: number, y: number, rect: DOMRect): { x: number; y: number } | null {
    const nodeRadius = GAME_CONSTANTS.NODE_RADIUS;
    const maxX = rect.width - nodeRadius;
    const maxY = rect.height - nodeRadius;
    if (maxX < nodeRadius || maxY < nodeRadius || !Number.isFinite(x) || !Number.isFinite(y)) return null;

    const gridX = Math.round(x / this.gridSize) * this.gridSize;
    const gridY = Math.round(y / this.gridSize) * this.gridSize;
    return {
      x: Math.max(nodeRadius, Math.min(maxX, gridX)),
      y: Math.max(nodeRadius, Math.min(maxY, gridY)),
    };
  }

  private findKeyboardPlacementPoint(rect: DOMRect): { x: number; y: number } | null {
    const nodeRadius = GAME_CONSTANTS.NODE_RADIUS;
    const min = Math.ceil(nodeRadius / this.gridSize) * this.gridSize;
    const maxX = Math.floor((rect.width - nodeRadius) / this.gridSize) * this.gridSize;
    const maxY = Math.floor((rect.height - nodeRadius) / this.gridSize) * this.gridSize;
    if (maxX < min || maxY < min) return null;

    const centerX = Math.round(rect.width / 2 / this.gridSize) * this.gridSize;
    const centerY = Math.round(rect.height / 2 / this.gridSize) * this.gridSize;
    if (!this.pipelineBuilder.isNodeTooClose(centerX, centerY, this.pipeline.nodes)) {
      return { x: centerX, y: centerY };
    }

    const step = Math.ceil(GAME_CONSTANTS.MIN_NODE_SPACING / this.gridSize) * this.gridSize;
    for (let y = min; y <= maxY; y += step) {
      for (let x = min; x <= maxX; x += step) {
        if (!this.pipelineBuilder.isNodeTooClose(x, y, this.pipeline.nodes)) {
          return { x, y };
        }
      }
    }
    return null;
  }

  /**
   * Toggles touch connect-mode on/off (bound to the Connect toolbar button).
   * Entering connect mode clears any pending placement.
   */
  onConnectModeToggle(): void {
    if (this.isRunning || !this.gamePhaseService.isBuilding) return;
    if (this.connectMode()) {
      // Turn off
      this.connectMode.set(false);
      this.isConnecting = false;
      this.connectionStart = null;
    } else {
      // Turn on — clear pending placement so modes don't conflict
      this.connectMode.set(true);
      this.pendingPlacement.set(null);
    }
  }

  private getConnectionAtPosition(x: number, y: number): Connection | null {
    return this.canvasRenderer.getConnectionAtPosition(this.pipeline.connections, this.pipeline.nodes, x, y);
  }

  private removeConnection(connection: Connection): void {
    const source = this.pipeline.nodes.find((n) => n.id === connection.sourceId);
    const target = this.pipeline.nodes.find((n) => n.id === connection.targetId);

    if (source && target) {
      const command: PipelineCommand = {
        type: 'remove-connection',
        execute: () => {
          source.outputs = source.outputs.filter((id) => id !== target.id);
          target.inputs = target.inputs.filter((id) => id !== source.id);
          this.pipeline.connections = this.pipeline.connections.filter((c) => c.id !== connection.id);
          this.validatePipeline();
        },
        undo: () => {
          source.outputs.push(target.id);
          target.inputs.push(source.id);
          this.pipeline.connections.push(connection);
          this.validatePipeline();
        },
      };
      this.undoRedoService.execute(command);

      this.audioService.play('delete');
    }
  }

  private reverseConnection(connection: Connection): void {
    const source = this.pipeline.nodes.find((n) => n.id === connection.sourceId);
    const target = this.pipeline.nodes.find((n) => n.id === connection.targetId);

    if (!source || !target) return;

    // Check if the reverse connection is valid
    if (!this.pipelineBuilder.canConnect(target, source)) {
      this.audioService.play('error');
      return;
    }

    const sourceInputsBefore = [...source.inputs];
    const sourceOutputsBefore = [...source.outputs];
    const targetInputsBefore = [...target.inputs];
    const targetOutputsBefore = [...target.outputs];
    const connectionSourceBefore = connection.sourceId;
    const connectionTargetBefore = connection.targetId;

    const sourceInputsAfter = sourceInputsBefore.includes(target.id)
      ? sourceInputsBefore
      : [...sourceInputsBefore, target.id];
    const sourceOutputsAfter = sourceOutputsBefore.filter((id) => id !== target.id);
    const targetInputsAfter = targetInputsBefore.filter((id) => id !== source.id);
    const targetOutputsAfter = targetOutputsBefore.includes(source.id)
      ? targetOutputsBefore
      : [...targetOutputsBefore, source.id];

    const command: PipelineCommand = {
      type: 'reverse-connection',
      execute: () => {
        source.inputs = [...sourceInputsAfter];
        source.outputs = [...sourceOutputsAfter];
        target.inputs = [...targetInputsAfter];
        target.outputs = [...targetOutputsAfter];
        connection.sourceId = target.id;
        connection.targetId = source.id;
        this.validatePipeline();
      },
      undo: () => {
        source.inputs = [...sourceInputsBefore];
        source.outputs = [...sourceOutputsBefore];
        target.inputs = [...targetInputsBefore];
        target.outputs = [...targetOutputsBefore];
        connection.sourceId = connectionSourceBefore;
        connection.targetId = connectionTargetBefore;
        this.validatePipeline();
      },
    };
    this.undoRedoService.execute(command);

    this.audioService.play('connect');
  }

  private isDebounced(): boolean {
    const now = Date.now();
    if (now - this.lastInteractionTime < GAME_CONSTANTS.INPUT_DEBOUNCE_MS) {
      return true;
    }
    this.lastInteractionTime = now;
    return false;
  }

  private getNodeAtPosition(x: number, y: number): PipelineNode | null {
    return this.canvasRenderer.getNodeAtPosition(this.pipeline.nodes, x, y);
  }

  private selectNode(node: PipelineNode): void {
    this.selectedNode = node;
    this.audioService.play('click');
  }

  // Close node detail panel - preserves viewport on mobile
  closeNodeDetail(): void {
    this.selectedNode = null;
    this.justClosedModal.set(true);

    // Clear the flag after a short delay to allow next selection
    if (this.closeNodeDetailTimer) {
      clearTimeout(this.closeNodeDetailTimer);
    }
    this.closeNodeDetailTimer = setTimeout(() => {
      this.closeNodeDetailTimer = null;
      this.justClosedModal.set(false);
    }, 200);

    // Prevent any scroll jump on mobile by focusing canvas
    if (window.innerWidth <= 768) {
      this.gameCanvas?.nativeElement?.focus();
    }
  }

  deleteSelectedNode(): void {
    if (!this.selectedNode) return;

    if (this.isRunning) {
      this.audioService.play('error');
      return;
    }

    const nodeToDelete = this.selectedNode;
    const nodeId = nodeToDelete.id;

    // Snapshot connections and neighbor linkage for undo restoration
    const savedConnections = this.pipeline.connections
      .filter((c) => c.sourceId === nodeId || c.targetId === nodeId)
      .map((c) => ({ ...c, dataFlow: [...c.dataFlow] }));

    // Snapshot which nodes had this node in their inputs/outputs
    const neighborLinks: { nodeId: string; hadInput: boolean; hadOutput: boolean }[] = [];
    for (const n of this.pipeline.nodes) {
      if (n.id === nodeId) continue;
      const hadInput = n.inputs.includes(nodeId);
      const hadOutput = n.outputs.includes(nodeId);
      if (hadInput || hadOutput) {
        neighborLinks.push({ nodeId: n.id, hadInput, hadOutput });
      }
    }

    // Cancel any pending connection involving this node
    if (this.connectionStart?.id === nodeId) {
      this.connectionStart = null;
      this.isConnecting = false;
    }

    const command: PipelineCommand = {
      type: 'remove-node',
      execute: () => {
        this.pipeline.connections = this.pipeline.connections.filter(
          (conn) => conn.sourceId !== nodeId && conn.targetId !== nodeId
        );
        this.pipeline.nodes.forEach((n) => {
          n.inputs = n.inputs.filter((id) => id !== nodeId);
          n.outputs = n.outputs.filter((id) => id !== nodeId);
        });
        this.resourceManager.freeNodeResources(nodeToDelete);
        this.gameState.cpu = this.resourceManager.getCpu();
        this.gameState.memory = this.resourceManager.getMemory();
        this.pipeline.nodes = this.pipeline.nodes.filter((n) => n.id !== nodeId);
        if (this.selectedNode?.id === nodeId) {
          this.selectedNode = null;
        }
        this.resourceManager.reconcile(this.pipeline.nodes);
        this.validatePipeline();
      },
      undo: () => {
        this.pipeline.nodes.push(nodeToDelete);
        this.resourceManager.allocateNodeResources(nodeToDelete);
        this.gameState.cpu = this.resourceManager.getCpu();
        this.gameState.memory = this.resourceManager.getMemory();
        // Restore connections
        for (const conn of savedConnections) {
          this.pipeline.connections.push(conn);
        }
        // Restore neighbor linkage
        for (const link of neighborLinks) {
          const neighbor = this.pipeline.nodes.find((n) => n.id === link.nodeId);
          if (!neighbor) continue;
          if (link.hadInput && !neighbor.inputs.includes(nodeId)) {
            neighbor.inputs.push(nodeId);
          }
          if (link.hadOutput && !neighbor.outputs.includes(nodeId)) {
            neighbor.outputs.push(nodeId);
          }
        }
        // Restore the node's own inputs/outputs from saved connections
        nodeToDelete.inputs = savedConnections.filter((c) => c.targetId === nodeId).map((c) => c.sourceId);
        nodeToDelete.outputs = savedConnections.filter((c) => c.sourceId === nodeId).map((c) => c.targetId);
        this.resourceManager.reconcile(this.pipeline.nodes);
        this.validatePipeline();
      },
    };
    this.undoRedoService.execute(command);

    this.selectedNode = null;
    this.audioService.play('delete');
  }

  // ─── Keyboard Navigation Helpers ────────────────────────────────────────────

  private moveSelectedNode(direction: string): void {
    if (!this.selectedNode) return;
    const step = GAME_CONSTANTS.NODE_MOVE_STEP;
    const nodeRadius = GAME_CONSTANTS.NODE_RADIUS;

    switch (direction) {
      case 'ArrowUp':
        this.selectedNode.y -= step;
        break;
      case 'ArrowDown':
        this.selectedNode.y += step;
        break;
      case 'ArrowLeft':
        this.selectedNode.x -= step;
        break;
      case 'ArrowRight':
        this.selectedNode.x += step;
        break;
    }

    // Constrain to canvas bounds
    const canvasParent = this.pipelineCanvas?.nativeElement?.parentElement;
    if (canvasParent) {
      const rect = canvasParent.getBoundingClientRect();
      this.selectedNode.x = Math.max(nodeRadius, Math.min(rect.width - nodeRadius, this.selectedNode.x));
      this.selectedNode.y = Math.max(nodeRadius, Math.min(rect.height - nodeRadius, this.selectedNode.y));
    }
  }

  private cycleNodeSelection(reverse: boolean): void {
    const nodes = this.pipeline.nodes;
    if (nodes.length === 0) return;

    if (!this.selectedNode) {
      this.selectNode(nodes[0]);
      return;
    }

    const currentIndex = nodes.indexOf(this.selectedNode);
    const nextIndex = reverse ? (currentIndex - 1 + nodes.length) % nodes.length : (currentIndex + 1) % nodes.length;
    this.selectNode(nodes[nextIndex]);
  }

  // ─── Touch Event Handlers ──────────────────────────────────────────────────

  private handleTouchStart(event: TouchEvent): void {
    if (event.touches.length !== 1) return; // Ignore multi-touch
    event.preventDefault(); // Prevent scrolling while interacting

    const touch = event.touches[0];
    const rect = this.pipelineCanvas.nativeElement.getBoundingClientRect();
    const x = touch.clientX - rect.left;
    const y = touch.clientY - rect.top;

    const clickedNode = this.getNodeAtPosition(x, y);

    // ── Connect mode (touch) ──────────────────────────────────────────────
    // Connect mode takes precedence over tap-to-place.
    if (this.connectMode()) {
      if (clickedNode) {
        // Delegate to the shift-click handler: 1st tap starts, 2nd tap on a different
        // node completes, 2nd tap on the SAME node cancels. Only exit connect mode when
        // a connection actually completed (a cancel keeps the player in connect mode so
        // they can pick a different source).
        const completed = this.handleShiftClick(clickedNode);
        if (completed) {
          this.connectMode.set(false);
        }
      }
      // Tapping empty space in connect mode: cancel pending start, stay in mode
      // (lets user pick a different source node without leaving connect mode)
      return;
    }

    // ── Tap-to-place (touch) ──────────────────────────────────────────────
    const pending = this.pendingPlacement();
    if (pending !== null) {
      if (!clickedNode) {
        // Tapped empty canvas with a pending type — place the node here
        const point = this.getBoundedGridPoint(x, y, rect);
        if (point) {
          this.placePendingNodeAt(point.x, point.y);
        }
      } else {
        // Tapped an existing node while a placement is pending — deselect pending
        this.pendingPlacement.set(null);
        this.selectNode(clickedNode);
        this.dragController.startDrag(clickedNode, x, y);
      }
      return;
    }

    // ── Default: drag existing node or deselect ───────────────────────────
    if (clickedNode) {
      this.selectNode(clickedNode);
      this.dragController.startDrag(clickedNode, x, y);
    } else {
      this.selectedNode = null;
    }
  }

  private handleTouchMove(event: TouchEvent): void {
    if (event.touches.length !== 1) return;
    event.preventDefault();

    if (!this.dragController.isDragging()) return;

    const touch = event.touches[0];
    const rect = this.pipelineCanvas.nativeElement.getBoundingClientRect();
    const touchX = touch.clientX - rect.left;
    const touchY = touch.clientY - rect.top;

    const canvasParent = this.pipelineCanvas.nativeElement.parentElement;
    if (!canvasParent) return;
    const parentRect = canvasParent.getBoundingClientRect();
    this.dragController.dragTo(touchX, touchY, parentRect.width, parentRect.height);
  }

  private handleTouchEnd(event: TouchEvent): void {
    event.preventDefault();
    const dragRecord = this.dragController.endDrag();
    if (dragRecord) {
      const { node, fromX, fromY, toX, toY } = dragRecord;
      this.undoRedoService.execute({
        type: 'move-node',
        execute: () => {
          node.x = toX;
          node.y = toY;
        },
        undo: () => {
          node.x = fromX;
          node.y = fromY;
        },
      });
    }
  }

  /**
   * Get safe HTML for icon
   */
  getIcon(
    iconName:
      | 'warning'
      | 'arrowsClockwise'
      | 'stop'
      | 'play'
      | 'trash'
      | 'info'
      | 'checkCircle'
      | 'xCircle'
      | 'circle'
      | 'export'
      | 'gear'
      | 'clock'
      | 'lightbulb'
      | 'trophy'
      | 'chart',
    size = 16
  ): SafeHtml {
    return this.sanitizer.bypassSecurityTrustHtml(getIconSvg(iconName, size, size));
  }

  /**
   * Announce a message to screen readers via the aria-live region.
   * Clears then sets the message to ensure re-announcement of identical messages.
   */
  private announce(message: string): void {
    if (this.srAnnouncementTimer) {
      clearTimeout(this.srAnnouncementTimer);
    }
    this.srAnnouncement.set('');
    this.srAnnouncementTimer = setTimeout(() => {
      this.srAnnouncementTimer = null;
      this.srAnnouncement.set(message);
    }, 50);
  }

  /**
   * Generic config change handler for node configuration fields.
   * Records undo/redo commands for each change.
   */
  updateNodeConfig(event: ConfigChangeEvent): void {
    if (!this.gamePhaseService.isBuilding) return;
    if (!this.selectedNode) return;

    const node = this.selectedNode;
    const field = event.field as keyof NodeConfig;
    const newValue = event.value;
    const previousValue = node.config[field];

    // Skip if value unchanged
    if (previousValue === newValue) return;

    this.undoRedoService.execute({
      type: 'config-change',
      execute: () => {
        this.applyConfigChange(node, field, newValue);
      },
      undo: () => {
        this.applyConfigChange(node, field, previousValue);
      },
    });
  }

  /**
   * Record a config change on the undo stack and apply it.
   *
   * Shared by the node inspector and the release levers so both edit the route
   * the same way. A path that mutated config directly would let Undo revert a
   * different change while the surface that made it kept showing its own value.
   */
  private applyConfigChangeCommand(
    node: PipelineNode,
    field: keyof NodeConfig,
    value: string | number | boolean | undefined
  ): void {
    const previousValue = node.config[field];
    if (previousValue === value) return;

    this.undoRedoService.execute({
      type: 'config-change',
      execute: () => {
        this.applyConfigChange(node, field, value);
        this.validatePipeline();
        this.bumpState();
      },
      undo: () => {
        this.applyConfigChange(node, field, previousValue);
        this.validatePipeline();
        this.bumpState();
      },
    });
  }

  private applyConfigChange(
    node: PipelineNode,
    field: keyof NodeConfig,
    value: string | number | boolean | undefined
  ): void {
    switch (field) {
      case 'environment':
        node.config.environment = value as NodeConfig['environment'];
        break;
      case 'rollbackEnabled':
        node.config.rollbackEnabled = value as boolean;
        break;
      case 'coverageThreshold':
        node.config.coverageThreshold = value as NodeConfig['coverageThreshold'];
        break;
      case 'optimizationLevel':
        node.config.optimizationLevel = value as NodeConfig['optimizationLevel'];
        break;
      case 'retryCount':
        node.config.retryCount = value as number;
        break;
      case 'scanType':
        node.config.scanType = value as NodeConfig['scanType'];
        break;
      case 'strategy':
        node.config.strategy = value as DeployStrategy;
        break;
    }

    this.updateReleaseWindowForecast();
  }

  // PIPELINE EXECUTION
  runPipeline(): void {
    const lvl = this.currentLevel();
    if (!lvl) return;
    const executionSpeed = 1;
    if (this.runner.gameSpeed !== executionSpeed) this.runner.setGameSpeed(executionSpeed);
    this.updateReleaseWindowForecast();
    const forecastAtStart = this.releaseWindowForecast();
    const started = this.runner.startPipeline(this.pipeline, lvl, RELEASE_DESK_LEVEL_INDEX, executionSpeed);
    if (!started) {
      this.audioService.play('error');
    } else {
      this.activeReleaseWindowForecast = forecastAtStart;
      this.releaseWindowOutcome.set(null);
    }
  }

  stopPipeline(): void {
    this.runner.stopPipeline();
  }

  undo(): void {
    if (!this.gamePhaseService.isBuilding) return;
    if (!this.undoRedoService.canUndo) return;
    this.undoRedoService.undo();
    this.audioService.play('click');
  }

  redo(): void {
    if (!this.gamePhaseService.isBuilding) return;
    if (!this.undoRedoService.canRedo) return;
    this.undoRedoService.redo();
    this.audioService.play('click');
  }

  private validatePipeline(): boolean {
    const isValid = this.pipelineBuilder.validatePipeline(this.pipeline);
    const activePlanId = this.activeReleaseRoutePlanId();
    if (activePlanId && (!isValid || !matchesReleaseWindowRoutePlan(this.pipeline, activePlanId))) {
      this.activeReleaseRoutePlanId.set(null);
    }
    this.updateReleaseWindowForecast();
    // Changing the route after a result is the start of another attempt, so the
    // stamp comes back and the new route's answer is hidden until the next call.
    if (!this.isRunning && this.dispatchState() === 'resolved') {
      this.dispatchState.set('drafting');
      this.playerCall.set(null);
      this.releaseWindowOutcome.set(null);
      this.forecastRevealed.set(false);
    }
    // Validation is deliberately silent while the operator is editing. The
    // patch shelf presents the first actionable error only when it blocks a call.
    return isValid;
  }

  /** Deal a complete authored route onto the desk without replaying UI commands. */
  private installReleaseRoutePlan(planId: ReleaseRoutePlanId): void {
    const viewport = this.releaseRouteViewport();
    this.pipeline = assembleReleaseWindowRoute(planId, viewport, (type) => this.getDefaultNodeConfig(type));
    this.activeReleaseRoutePlanId.set(planId);
    this.dealtReleaseRoutePlanId.set(planId);
    this.selectedNode = null;
    this.hoveredNode = null;
    this.pendingPlacement.set(null);
    this.connectionStart = null;
    this.isConnecting = false;
    this.placementRefusedReason.set(null);
    this.undoRedoService.clear();
    this.resourceManager.reconcile(this.pipeline.nodes);
    this.gameState.cpu = this.resourceManager.getCpu();
    this.gameState.memory = this.resourceManager.getMemory();
    this.gameState.buildAgents = this.resourceManager.getBuildAgents();
    this.validatePipeline();
    this.forceRenderCanvas();
  }

  /** Use actual layout when available, and a deterministic desktop fallback before ViewChild exists. */
  private releaseRouteViewport(): { readonly width: number; readonly height: number } {
    const parent = this.pipelineCanvas?.nativeElement.parentElement;
    const rect = parent?.getBoundingClientRect();
    if (rect && rect.width >= 320 && rect.height >= 220) {
      this.prototypeRouteNeedsCanvasFit = false;
      return { width: rect.width, height: rect.height };
    }
    this.prototypeRouteNeedsCanvasFit = true;
    return { width: 1000, height: 360 };
  }

  /** Replace the pre-view fallback coordinates once initial layout has settled. */
  private fitInitialPrototypeRouteToCanvas(): void {
    if (!this.prototypeRouteNeedsCanvasFit) return;
    const planId = this.activeReleaseRoutePlanId();
    if (!planId) return;
    this.installReleaseRoutePlan(planId);
  }

  /** Open or close the expert graph editor without changing the route. */
  togglePrototypeWorkbench(): void {
    if (this.isRunning) return;
    this.prototypeWorkbenchOpen.update((open) => !open);
    // A refusal belongs to the placement attempt that caused it. Closing the bay
    // ends that attempt, so the message must not be waiting — and re-announced by
    // its live region — the next time the bay opens.
    if (!this.prototypeWorkbenchOpen()) this.placementRefusedReason.set(null);
    this.bumpState();
    if (this.prototypeLayoutRafHandle !== null) cancelAnimationFrame(this.prototypeLayoutRafHandle);
    this.prototypeLayoutRafHandle = requestAnimationFrame(() => {
      this.prototypeLayoutRafHandle = null;
      this.handleCanvasResize();
      // The focused phone layout hides the canvas, so its initial route is
      // assembled against the deterministic desktop fallback. Once the patch
      // bay gives the canvas real dimensions, deal that same route into the
      // live viewport before drawing it.
      this.fitInitialPrototypeRouteToCanvas();
      this.render();
    });
  }

  /** Restore the last authored route after patch-bay edits. */
  restoreDealtRoute(): void {
    if (this.isRunning) return;
    this.runner.reset();
    this.prepareReleaseAttempt();
    this.installReleaseRoutePlan(this.dealtReleaseRoutePlanId());
    this.announce('Authored route restored. Read the rail and stamp the verdict.');
    this.audioService.play('click');
    this.bumpState();
  }

  /**
   * Choose one operational route after the first gate result. The result is put
   * away and the new timing is hidden, so the next stamp remains a real call.
   */
  selectReleaseRoutePlan(planId: ReleaseRoutePlanId): void {
    if (!this.routeChoiceAvailable() || this.isRunning) return;
    if (planId === this.activeReleaseRoutePlanId()) {
      this.announce('That route is already measured. Choose an approach that changes the release.');
      return;
    }
    const option = this.releaseRouteOptions().find(({ plan }) => plan.id === planId);
    if (!option || option.durationSeconds === null || option.secondsReclaimed === null) {
      this.announce('That release approach is unavailable. Its schedule could not be proven.');
      return;
    }
    this.pendingRouteChangeSecondsReclaimed = option.secondsReclaimed;
    // Taking the change is the one boundary the desk forces: it always costs a
    // second stamp, so the feat this ticket already earned is carried across it
    // rather than being lost to the re-read.
    this.routeChangeCarriedFeat = this.earnedFeat();
    this.runner.reset();
    this.prepareReleaseAttempt();
    this.installReleaseRoutePlan(planId);
    this.routeDecisionMade.set(true);
    this.announce(`${this.activeReleaseRoutePlan()?.label ?? 'Custom route'} loaded. Make a new release call.`);
    this.audioService.play('click');
    this.bumpState();
  }

  /** Keep the current graph and reopen its controls for another call. */
  reviseRelease(): void {
    if (this.isRunning || this.dispatchState() === 'committed') return;
    this.runner.reset();
    this.prepareReleaseAttempt();
    this.pipeline.nodes.forEach((node) => {
      node.status = NodeStatus.Idle;
      node.processingTime = 0;
      node.lastStatus = null;
      node.lastFailureReason = undefined;
      node.retriesRemaining = undefined;
      node.particles = [];
    });
    this.pipeline.connections.forEach((connection) => {
      connection.status = 'inactive';
      connection.dataFlow = [];
    });
    this.validatePipeline();
    this.forceRenderCanvas();
    this.announce('Release reset. Read the current route and make a new call.');
    this.bumpState();
  }

  private prepareReleaseAttempt(): void {
    this.dispatchState.set('drafting');
    this.playerCall.set(null);
    this.releaseWindowOutcome.set(null);
    this.activeReleaseWindowForecast = null;
    this.artifactMarks.set([]);
    this.forecastRevealed.set(false);
    this.gameState.elapsedTime = 0;
    this.gamePhaseService.reset();
  }

  /** Exact reason the prototype's stamp is blocked, placed beside the stamp. */
  releaseReadinessMessage(): string | null {
    if (this.releaseWindowForecast()?.verdict !== 'incomplete') return null;
    const lvl = this.currentLevel();
    if (!lvl) return 'No release ticket is loaded.';

    const dependencyGate = lvl.prototypeRules?.dependencyGate;
    if (dependencyGate && !this.pipeline.nodes.some((node) => node.type === dependencyGate.targetType)) {
      return `Add ${this.nodeTypeDeskLabel(dependencyGate.targetType)} to receive the release.`;
    }
    if (!this.pipeline.isValid) {
      return this.runBlockedReason ?? 'Connect every stage into one valid release route.';
    }
    if (dependencyGate) {
      const missing = this.pipelineBuilder.getMissingRequiredUpstreamNodeTypes(
        this.pipeline,
        dependencyGate.targetType,
        dependencyGate.requiredUpstreamTypes
      );
      if (missing.length > 0) {
        return `${this.nodeTypeDeskLabel(dependencyGate.targetType)} is not downstream of ${missing
          .map((type) => this.nodeTypeDeskLabel(type))
          .join(', ')}.`;
      }
    }
    return 'Check that every stage has a supported timing configuration.';
  }

  private nodeTypeDeskLabel(type: NodeType): string {
    switch (type) {
      case NodeType.SecurityScan:
        return 'Security Scan';
      case NodeType.Parallel:
        return 'Parallel';
      default:
        return type.charAt(0).toUpperCase() + type.slice(1);
    }
  }

  private updateReleaseWindowForecast(): void {
    const lvl = this.currentLevel();
    if (!isControlledPrototype(lvl)) {
      this.releaseWindowForecast.set(null);
      return;
    }

    const estimate = this.runner.estimateCriticalPath(this.pipeline, lvl);
    const dependencyGate = lvl.prototypeRules.dependencyGate;
    const releaseRouteReady = dependencyGate
      ? this.pipelineBuilder.hasRequiredUpstreamNodes(
          this.pipeline,
          dependencyGate.targetType,
          dependencyGate.requiredUpstreamTypes
        )
      : true;
    const routeReady = this.pipeline.isValid && releaseRouteReady && !!estimate;
    const durationSeconds = estimate?.durationSeconds ?? null;
    const verdict: ReleaseWindowVerdict =
      !routeReady || durationSeconds === null ? 'incomplete' : durationSeconds < lvl.parTime ? 'open' : 'locked';
    const marginSeconds =
      durationSeconds === null || verdict !== 'open' ? 0 : this.roundReleaseSeconds(lvl.parTime - durationSeconds);
    const requiredReductionSeconds =
      durationSeconds === null || verdict !== 'locked'
        ? 0
        : this.roundReleaseSeconds(durationSeconds - lvl.parTime + PIPELINE_SCHEDULER_TICK_SECONDS);

    this.releaseWindowForecast.set({
      verdict,
      windowSeconds: lvl.parTime,
      durationSeconds,
      criticalPath: estimate?.nodeNames ?? [],
      criticalPathLabel: this.formatCriticalPath(estimate),
      marginSeconds,
      requiredReductionSeconds,
    });

    this.updateRailStages(lvl, routeReady);
  }

  /**
   * Lay the schedule out as percentages of the maintenance window.
   *
   * The rail is scaled so the lock always sits at 100%. Work that overruns the
   * window keeps going past it, which is the point: the player should see the
   * release arrive at a gate that has already shut.
   */
  private updateRailStages(lvl: Level, routeReady: boolean): void {
    const windowSeconds = lvl.parTime;
    if (windowSeconds <= 0 || !routeReady) {
      this.railStages.set([]);
      return;
    }

    const schedule = this.runner.buildDisplaySchedule(this.pipeline, lvl);
    const scale = 100 / this.railSpanSeconds();

    this.railStages.set(
      schedule.map((stage) => ({
        nodeId: stage.nodeId,
        name: stage.name,
        color: stage.color,
        leftPercent: stage.startSeconds * scale,
        widthPercent: (stage.endSeconds - stage.startSeconds) * scale,
        seconds: this.roundReleaseSeconds(stage.endSeconds - stage.startSeconds),
        onCriticalPath: stage.onCriticalPath,
        pastLock: stage.endSeconds > windowSeconds,
      }))
    );
  }

  /** True once a valid route exists and the player may stamp a call on it. */
  get canStamp(): boolean {
    return (
      this.dispatchState() === 'drafting' && !this.isRunning && this.releaseWindowForecast()?.verdict !== 'incomplete'
    );
  }

  /**
   * Stamp a call on the release and dispatch it.
   *
   * The stamp is the run trigger on purpose. Predicting the outcome is the
   * decision this ticket is asking for, so there is no way to start the release
   * without answering first.
   */
  stampAndDispatch(call: ReleaseCall): void {
    if (!this.canStamp) return;

    this.audioService.play('stamp');
    this.ticketAttemptCount.update((attempts) => attempts + 1);
    this.playerCall.set(call);
    this.dispatchState.set('committed');
    this.runPipeline();

    // A route the runner refused leaves nothing to watch, so hand the stamp back.
    if (!this.isRunning) {
      this.ticketAttemptCount.update((attempts) => Math.max(0, attempts - 1));
      this.dispatchState.set('drafting');
      this.playerCall.set(null);
    }
  }

  /**
   * What each mark costs the release, in the operator's words.
   *
   * These name the trade rather than scoring it. The release still shipped; the
   * receipt is where the player sees what they spent to make the window.
   */
  artifactMarkLabel(mark: ReleaseArtifactMark): string {
    switch (mark.code) {
      case 'unoptimized':
        return 'Unoptimized build';
      case 'low-evidence':
        return 'Low evidence';
      case 'partial-rollout':
        return 'Partial rollout';
    }
  }

  /**
   * The node a lever acts on, or null when the route does not offer exactly one.
   *
   * A strip that silently drove the first of several same-type nodes would report
   * a setting that does not describe what the rail draws, so it stands down
   * instead and leaves the player to the node inspector.
   */
  private leverNode(lever: ReleaseLever): PipelineNode | null {
    const matches = this.pipeline?.nodes.filter((node) => node.type === lever.nodeType) ?? [];
    return matches.length === 1 ? matches[0] : null;
  }

  /** True once the route offers exactly one node this lever can drive. */
  leverAvailable(lever: ReleaseLever): boolean {
    return (
      this.gamePhaseService.isBuilding &&
      this.activeCondition() !== null &&
      this.dispatchState() === 'drafting' &&
      !this.isRunning &&
      this.leverNode(lever) !== null
    );
  }

  /**
   * Which option is currently set, read back from the node rather than stored
   * separately, so hand-editing through the inspector keeps the strip truthful.
   */
  leverSetting(lever: ReleaseLever): string | number | null {
    const node = this.leverNode(lever);
    if (!node) return null;
    const value = node.config[lever.field];
    if (typeof value === 'string' || typeof value === 'number') return value;
    return lever.fallback;
  }

  /** Pull a lever. The rail redraws because the route genuinely changed. */
  pullLever(lever: ReleaseLever, option: ReleaseLeverOption): void {
    if (!this.leverAvailable(lever)) return;
    const node = this.leverNode(lever);
    if (!node || this.leverSetting(lever) === option.value) return;

    // Route the change through the same recorded command the inspector uses.
    // A lever that mutated config outside the undo stack would let Undo revert
    // some other edit while the strip kept showing the value it just set.
    this.applyConfigChangeCommand(node, lever.field, option.value);
    this.audioService.play('click');
  }

  /** Authored name for an operating condition, shown clipped to the ticket. */
  conditionLabel(condition: PrototypeConditionCard): string {
    switch (condition.id) {
      case 'agent-pool-1':
        return 'Agent pool: 1';
    }
  }

  /**
   * The same condition in sentence form, for copy that reads as a desk note.
   *
   * Exhaustive on purpose: a new condition id fails to compile here rather than
   * shipping a teaser that describes the wrong rule.
   */
  conditionRule(condition: PrototypeConditionCard): string {
    switch (condition.id) {
      case 'agent-pool-1':
        return 'one agent';
    }
  }

  /** Ticket numbers are printed as desk paperwork: 01, 02, 03. */
  formatTicketNumber(ticket: number): string {
    return ticket.toString().padStart(2, '0');
  }

  /**
   * One mark per second across the whole drawn rail, labelled every other second.
   *
   * The player is asked to work out the finish time themselves, which is only a
   * fair question if they can measure the blocks. The ruler is not the answer.
   */
  readonly railTicks = computed<readonly { seconds: number; percent: number; major: boolean }[]>(() => {
    const spanSeconds = Math.floor(this.railSpanSeconds());
    if (spanSeconds <= 0) return [];

    const ticks: { seconds: number; percent: number; major: boolean }[] = [];
    for (let second = 1; second < spanSeconds; second++) {
      ticks.push({
        seconds: second,
        percent: (second / this.railSpanSeconds()) * 100,
        major: second % 2 === 0,
      });
    }
    return ticks;
  });

  /** Position a moment in the window as a percentage of the way to the lock. */
  railPercent(seconds: number): number {
    const span = this.railSpanSeconds();
    if (span <= 0) return 0;
    return Math.min(100, (seconds / span) * 100);
  }

  /** Where the release has actually reached, measured not predicted. */
  playheadPercent(): number {
    const outcome = this.releaseWindowOutcome();
    const seconds = outcome ? outcome.actualSeconds : this.gameState.elapsedTime;
    return this.railPercent(seconds);
  }

  /** Whether the maintenance gate is still open, and if not, why. */
  gateState(): 'open' | 'shut' {
    const outcome = this.releaseWindowOutcome();
    if (this.dispatchState() !== 'resolved' || !outcome) return 'open';
    return outcome.verdict === 'released' ? 'open' : 'shut';
  }

  /**
   * One line under the rail. It never states the finish time before the player
   * has committed a call, and after the result it names the chain to attack.
   */
  railReadout(): string {
    const windowLabel = this.formatReleaseSeconds(this.railWindowSeconds());
    const outcome = this.releaseWindowOutcome();

    if (this.dispatchState() === 'resolved' && outcome) {
      if (this.callAccuracy() !== 'correct') {
        return `Measured ${this.formatReleaseSeconds(outcome.actualSeconds)}s. The gate ${outcome.verdict === 'released' ? 'opened' : 'locked'}. Call it again.`;
      }
      return outcome.verdict === 'released'
        ? `Shipped with ${this.formatReleaseSeconds(outcome.marginSeconds)}s to spare. Longest chain: ${outcome.criticalPathLabel}.`
        : `Locked by ${this.formatReleaseSeconds(outcome.requiredReductionSeconds)}s. Shorten ${outcome.criticalPathLabel}.`;
    }

    if (this.dispatchState() === 'committed') {
      return 'Release dispatched. Watching the window.';
    }

    const forecast = this.releaseWindowForecast();
    if (!forecast || forecast.verdict === 'incomplete') {
      return this.releaseReadinessMessage() ?? `Prepare a complete route before the ${windowLabel}s gate shuts.`;
    }

    const revealed = this.visibleForecast();
    if (revealed?.durationSeconds !== null && revealed !== null) {
      return `Forecast ${this.formatReleaseSeconds(revealed.durationSeconds)}s against a ${windowLabel}s lock. Longest chain: ${revealed.criticalPathLabel}.`;
    }

    return `Read the widths and call it. Does this route clear the gate at ${windowLabel}s?`;
  }

  /**
   * Every route this ticket has already measured, keyed by its shape.
   *
   * Determinism is not believed because the game claims it. It is believed when
   * the player rebuilds a route they already ran and the desk says the same
   * number back before they even dispatch.
   */
  private readonly measuredRoutes = new Map<string, number>();

  /** A stable fingerprint of the route: what runs, in what order, for how long. */
  private routeFingerprint(): string {
    return this.railStages()
      .map((stage) => `${stage.name}@${stage.leftPercent.toFixed(2)}+${stage.seconds}`)
      .join('|');
  }

  /** The time this exact route took last time it ran, if it ever has. */
  seenRouteSeconds(): number | null {
    if (this.dispatchState() !== 'drafting' || this.railStages().length === 0) return null;
    return this.measuredRoutes.get(this.routeFingerprint()) ?? null;
  }

  /** Clear the player's call and re-hide the verdict for a fresh ticket. */
  private resetDispatch(clearReveal: boolean): void {
    this.dispatchState.set('drafting');
    this.playerCall.set(null);
    this.artifactMarks.set([]);
    this.releaseWindowOutcome.set(null);
    this.activeReleaseWindowForecast = null;
    if (clearReveal) {
      this.forecastRevealed.set(false);
      this.measuredRoutes.clear();
    }
  }

  private recordReleaseWindowOutcome(pipelineSucceeded: boolean): void {
    const lvl = this.currentLevel();
    if (!isControlledPrototype(lvl)) return;

    const forecast = this.activeReleaseWindowForecast ?? this.releaseWindowForecast();
    if (!forecast || forecast.durationSeconds === null) return;

    const actualSeconds = this.roundReleaseSeconds(this.gameState.elapsedTime);
    const released = pipelineSucceeded && actualSeconds < forecast.windowSeconds;
    const predictionDeltaSeconds = this.roundReleaseSeconds(actualSeconds - forecast.durationSeconds);
    const marginSeconds = released ? this.roundReleaseSeconds(forecast.windowSeconds - actualSeconds) : 0;
    const requiredReductionSeconds = released
      ? 0
      : this.roundReleaseSeconds(
          Math.max(
            PIPELINE_SCHEDULER_TICK_SECONDS,
            actualSeconds - forecast.windowSeconds + PIPELINE_SCHEDULER_TICK_SECONDS
          )
        );

    this.releaseWindowOutcome.set({
      verdict: released ? 'released' : 'locked',
      predictedSeconds: forecast.durationSeconds,
      actualSeconds,
      predictionDeltaSeconds,
      criticalPathLabel: forecast.criticalPathLabel,
      marginSeconds,
      requiredReductionSeconds,
    });
    this.activeReleaseWindowForecast = null;

    this.dispatchState.set('resolved');
    const callWasCorrect = (this.playerCall() === 'ships') === released;
    // A correct judgment earns the causal breakdown. A miss still gets the
    // measured finish—the useful evidence needed to improve the next call.
    this.forecastRevealed.set(callWasCorrect);
    this.measuredRoutes.set(this.routeFingerprint(), actualSeconds);
  }

  formatReleaseSeconds(seconds: number): string {
    return seconds.toFixed(1);
  }

  formatReleaseDelta(seconds: number): string {
    const rounded = this.roundReleaseSeconds(seconds);
    return `${rounded >= 0 ? '+' : ''}${rounded.toFixed(1)}`;
  }

  private formatCriticalPath(estimate: CriticalPathEstimate | null): string {
    return estimate?.nodeNames.join(' → ') ?? 'Waiting for a complete release route';
  }

  private roundReleaseSeconds(seconds: number): number {
    return Math.round(seconds * 10) / 10;
  }

  /**
   * Promote the active authored condition into the level's live scheduler rules.
   *
   * Only the fields a condition is allowed to touch are written here. Everything
   * else about the controlled-prototype contract stays where the level author put it.
   */
  private applyActiveCondition(lvl: Level): void {
    const rules = lvl.prototypeRules;
    if (!rules) return;

    const card = (rules.conditionCards ?? []).find((candidate) => candidate.id === this.activeConditionId());
    rules.agentPoolLimit = card?.agentPoolLimit;
  }

  /**
   * Clip the next authored condition onto the route the player just learned.
   *
   * The graph is deliberately preserved. Night two is interesting because one
   * changed rule invalidates a familiar solution; rebuilding the graph from a
   * blank canvas would hide that causal relationship behind setup work.
   */
  takeNextTicket(): void {
    if (!this.canAdvanceTicket()) return;
    const next = this.nextTicketCondition();
    if (!next) return;
    const lvl = this.currentLevel();
    if (!lvl) return;

    // Ticket 1 is genuinely finished right here — capture its ledger entry
    // before any of its state (attempt count, feat, route pick) gets reset.
    this.recordShiftLedgerEntry(1);

    const preservedPipeline = this.clonePipelineForNextTicket();
    const preservedPlanId = this.activeReleaseRoutePlanId();
    this.activeConditionId.set(next.id);
    this.runner.reset();
    this.gamePhaseService.reset();
    this.applyActiveCondition(lvl);
    this.prepareReleaseAttempt();
    this.pipeline = preservedPipeline;
    this.activeReleaseRoutePlanId.set(preservedPlanId);
    this.routeDecisionMade.set(true);
    this.ticketAttemptCount.set(0);
    this.routeChangeCarriedFeat = null;
    this.pendingRouteChangeSecondsReclaimed = null;
    this.prototypeRouteNeedsCanvasFit = false;
    this.prototypeWorkbenchOpen.set(false);
    this.resourceManager.reconcile(this.pipeline.nodes);
    this.gameState.cpu = this.resourceManager.getCpu();
    this.gameState.memory = this.resourceManager.getMemory();
    this.gameState.buildAgents = this.resourceManager.getBuildAgents();
    this.validatePipeline();
    this.forceRenderCanvas();
    this.announce('Release ticket 2 loaded. The same route now has one build agent.');
    this.bumpState();
  }

  /** Sign off the authored shift without inventing an unvalidated next ticket. */
  completeShift(): void {
    if (!this.canCompleteShift()) return;
    // Ticket 2 is genuinely finished right here — capture its ledger entry
    // before shiftComplete flips the closeout on.
    this.recordShiftLedgerEntry(2);
    this.shiftComplete.set(true);
    this.announce('Shift complete. Two release judgments recorded.');
    this.audioService.play('success');
    this.bumpState();
  }

  /**
   * Append the finished ticket's record to the shift ledger.
   *
   * The feat is read live, so the record describes the attempt actually being
   * signed off. `routeChangeCarriedFeat` only fills in behind it, for the one
   * boundary the player is compelled across; see that field's doc comment.
   */
  private recordShiftLedgerEntry(ticket: 1 | 2): void {
    const outcome = this.releaseWindowOutcome();
    const call = this.playerCall();
    if (!outcome || !call) return;

    this.shiftLedger.update((entries) => [
      ...entries,
      {
        ticket,
        call,
        verdict: outcome.verdict,
        actualSeconds: outcome.actualSeconds,
        feat: this.earnedFeat() ?? this.routeChangeCarriedFeat,
        routeLabel: this.activeReleaseRoutePlan()?.label ?? 'Custom patch',
        secondsReclaimedOnRouteChange: ticket === 1 ? this.pendingRouteChangeSecondsReclaimed : null,
      },
    ]);
  }

  /** Start the same deterministic two-ticket study again from a clean inherited route. */
  replayShift(): void {
    if (this.isRunning) return;
    this.activeConditionId.set(null);
    this.routeDecisionMade.set(false);
    this.shiftComplete.set(false);
    this.ticketAttemptCount.set(0);
    this.shiftLedger.set([]);
    this.routeChangeCarriedFeat = null;
    this.pendingRouteChangeSecondsReclaimed = null;
    this.loadLevel(RELEASE_DESK_LEVEL_INDEX);
    this.announce('New shift loaded. Read the inherited route and make the call.');
  }

  /** Reopen the current route; the patch bay is optional, never a destructive reset. */
  tryAnotherRoute(): void {
    this.reviseRelease();
  }

  private clonePipelineForNextTicket(): Pipeline {
    return {
      ...this.pipeline,
      nodes: this.pipeline.nodes.map((node) => ({
        ...node,
        status: NodeStatus.Idle,
        config: { ...node.config },
        processingTime: 0,
        inputs: [...node.inputs],
        outputs: [...node.outputs],
        particles: [],
        executionCount: 0,
        lastStatus: null,
        lastFailureReason: undefined,
        retriesRemaining: undefined,
        placedAt: undefined,
      })),
      connections: this.pipeline.connections.map((connection) => ({
        ...connection,
        status: 'inactive',
        dataFlow: [],
        path: undefined,
      })),
      totalExecutionTime: 0,
      successRate: 0,
      throughput: 0,
      totalCpuUsed: 0,
      totalMemoryUsed: 0,
      parallelExecutions: 0,
      isRunning: false,
      lastRunStatus: 'partial',
      errors: [],
      runAttempt: 0,
      lastFailedNodeType: undefined,
    };
  }

  // RENDERING
  private startAnimationLoop(): void {
    this.gameLoopService.startAnimationLoop(() => this.render());
  }

  private render(): void {
    if (!this.ctx || !this.pipelineCtx) return;

    try {
      // Get logical dimensions (already accounting for DPR in canvas setup)
      const canvas = this.gameCanvas.nativeElement;
      const parentElement = canvas.parentElement;
      if (!parentElement) return;

      // Use the CSS dimensions for rendering (logical pixels)
      const rect = parentElement.getBoundingClientRect();
      const width = rect.width;
      const height = rect.height;
      // Skip frame entirely if layout hasn't produced real dimensions yet —
      // happens on first paint or while the parent is display:none. Prevents
      // rendering against a 0×0 canvas which produces visual flashes.
      if (width === 0 || height === 0) return;
      const context = this.createRenderContext();

      // Skip heavy operations when paused - only render static elements
      if (this.isPaused) {
        this.canvasRenderer.renderStatic(this.ctx, this.pipelineCtx, width, height, context);
        return;
      }

      // Always render the canvas (grid should always be visible)
      this.canvasRenderer.render(this.ctx, this.pipelineCtx, width, height, context);

      if (this.isRunning && this.gameState?.particlesEnabled) {
        this.particleSystem.update();
      }
      if (this.isRunning) {
        this.updateDataFlow();
      }

      // Reset error count on successful render
      if (this.renderErrorCount > 0) {
        this.renderErrorCount = 0;
      }
    } catch (error) {
      this.handleRenderError(error);
    }
  }

  private handleRenderError(error: unknown): void {
    this.renderErrorCount++;
    window.debugLogBridge?.log(`Render error #${this.renderErrorCount}: ${String(error)}`, 'error');

    if (this.renderErrorCount > 3) {
      // Stop animation loop to prevent error spam
      this.pauseAnimationLoop();
      this.gameError.set('The release view stopped drawing. Reload the shift to bring it back.');
    }
  }

  private safeParticleBurst(x: number, y: number, color: string): void {
    if (!this.gameState.particlesEnabled) return;
    try {
      this.particleSystem.burst(x, y, color);
    } catch (error) {
      this.gameState.particlesEnabled = false;
      this.degradedFeatures.update((arr) => [...arr, 'Particles disabled due to error']);
      window.debugLogBridge?.log('Particle system error: ' + String(error), 'error');
    }
  }

  /**
   * Create render context from current component state
   */
  private createRenderContext(): RenderContext {
    return {
      pipeline: this.pipeline,
      selectedNode: this.selectedNode,
      hoveredNode: this.hoveredNode,
      connectionStart: this.connectionStart,
      isConnecting: this.isConnecting,
      mouseX: this.mouseX,
      mouseY: this.mouseY,
      isDarkMode: !this.themeService.isDayMode,
      gridSize: this.gridSize,
      isRunning: this.isRunning,
      isMobileLayout: this.isMobileLayout,
    };
  }

  // Document visibility change handler
  private onVisibilityChange(): void {
    if (document.hidden) {
      this.pauseAnimationLoop();
      this.runner.onTabHidden();
    } else {
      if (!this.isPaused) {
        this.resumeAnimationLoop();
      }
      this.runner.onTabVisible();
    }
  }

  private pauseAnimationLoop(): void {
    this.gameLoopService.pauseAnimationLoop();
  }

  private resumeAnimationLoop(): void {
    this.gameLoopService.resumeAnimationLoop(() => this.render());
  }

  private updateDataFlow(): void {
    const context: DataFlowContext = {
      connections: this.pipeline.connections,
      nodes: this.pipeline.nodes,
      isRunning: this.isRunning,
      gameSpeed: this.gameSpeed,
    };
    this.gameLoopService.updateDataFlow(context);
  }

  // ERROR HANDLING — User-facing recovery methods

  /** Dismiss error overlay and try to resume the animation loop */
  dismissError(): void {
    this.gameError.set(null);
    this.renderErrorCount = 0;
    // Try to restart the animation loop
    this.resumeAnimationLoop();
  }

  /** Reinitialize the deterministic desk from scratch. */
  resetAndRecover(): void {
    this.gameError.set(null);
    this.renderErrorCount = 0;
    this.degradedFeatures.set([]);
    this.activeConditionId.set(null);
    // "Reload the shift" is the error overlay's own recovery action, so it
    // must not be able to throw raw either — if the contract is still broken
    // this re-opens the same themed overlay instead of crashing the retry.
    if (!this.tryInitializeGame()) {
      return;
    }
    this.loadLevel(RELEASE_DESK_LEVEL_INDEX);
  }

  @HostListener('document:keydown', ['$event'])
  handleKeyDown(event: KeyboardEvent): void {
    // Only handle keyboard shortcuts during building phase and outside interactive controls.
    if (!this.gamePhaseService.isBuilding) return;
    if (this.isInteractiveKeyboardTarget(event.target)) return;

    // Undo/Redo shortcuts (Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y)
    if (event.ctrlKey || event.metaKey) {
      if (event.key === 'z' || event.key === 'Z') {
        event.preventDefault();
        if (event.shiftKey) {
          this.redo();
        } else {
          this.undo();
        }
        return;
      }
      if (event.key === 'y') {
        event.preventDefault();
        this.redo();
        return;
      }
    }

    switch (event.key) {
      case 'ArrowUp':
      case 'ArrowDown':
      case 'ArrowLeft':
      case 'ArrowRight':
        if (this.selectedNode) {
          event.preventDefault();
          this.moveSelectedNode(event.key);
        }
        break;

      case 'Delete':
      case 'Backspace':
        if (this.selectedNode) {
          event.preventDefault();
          this.deleteSelectedNode();
        }
        break;

      case 'n':
      case 'N':
        // Cycle canvas nodes without overriding native Tab focus navigation.
        if (this.pipeline.nodes.length > 0) {
          event.preventDefault();
          this.cycleNodeSelection(event.shiftKey);
        }
        break;
    }
  }

  private isInteractiveKeyboardTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return !!target.closest('a[href], button, input, select, textarea, [role="button"], [contenteditable="true"]');
  }

  @HostListener('document:keydown.escape')
  handleEscapeKey(): void {
    if (this.isConnecting || this.connectMode()) {
      this.isConnecting = false;
      this.connectionStart = null;
      this.connectMode.set(false);
      return;
    }
    if (this.selectedNode) this.closeNodeDetail();
  }
}
