import { DestroyRef, inject, Injectable, NgZone } from '@angular/core';
import { BehaviorSubject, interval, Observable, Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { Connection, DataPacket, NodeStatus, PipelineNode } from '../models/pipeline.model';
import { GAME_CONSTANTS } from '../game-constants';

/**
 * Data flow update context - contains state needed for packet updates
 */
export interface DataFlowContext {
  connections: Connection[];
  nodes: PipelineNode[];
  isRunning: boolean;
  gameSpeed: number;
}

/**
 * Game tick context - contains state needed for game updates
 */
export interface GameTickContext {
  isRunning: boolean;
  isPaused: boolean;
  hasLevel: boolean;
}

/**
 * Animation loop state
 */
export type AnimationState = 'stopped' | 'running' | 'paused';

/**
 * GameLoopService manages the game's animation frame loop and game tick interval.
 *
 * Responsibilities:
 * - Animation frame management (start, pause, resume, stop)
 * - Data flow packet spawning and movement
 * - Game tick interval (100ms) for time/resource updates
 *
 * The service is stateless regarding game data - all state is passed via contexts
 * or callbacks. This allows the component to own the game state while the service
 * manages timing and animation concerns.
 */
@Injectable()
export class GameLoopService {
  private readonly destroyRef = inject(DestroyRef);
  private animationFrameId: number | null = null;
  private readonly stateSubject = new BehaviorSubject<AnimationState>('stopped');

  /** Observable of animation loop state changes */
  readonly state$: Observable<AnimationState> = this.stateSubject.asObservable();

  /** Current animation state */
  get state(): AnimationState {
    return this.stateSubject.value;
  }

  /** Whether the animation loop is currently running */
  get isRunning(): boolean {
    return this.animationFrameId !== null;
  }

  constructor(private ngZone: NgZone) {
    this.destroyRef.onDestroy(() => this.destroy());
  }

  /**
   * Start the animation loop
   * @param onFrame Callback called on each animation frame
   */
  startAnimationLoop(onFrame: () => void): void {
    if (this.animationFrameId !== null) {
      return; // Already running
    }

    this.stateSubject.next('running');

    // Run outside Angular zone for performance
    this.ngZone.runOutsideAngular(() => {
      const animate = (): void => {
        onFrame();
        this.animationFrameId = window.requestAnimationFrame(animate);
      };
      this.animationFrameId = window.requestAnimationFrame(animate);
    });
  }

  /**
   * Pause the animation loop (preserves state for resume)
   */
  pauseAnimationLoop(): void {
    if (this.animationFrameId !== null) {
      window.cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
      this.stateSubject.next('paused');
    }
  }

  /**
   * Resume the animation loop after pause
   * @param onFrame Callback called on each animation frame
   */
  resumeAnimationLoop(onFrame: () => void): void {
    if (this.animationFrameId === null && this.stateSubject.value === 'paused') {
      this.startAnimationLoop(onFrame);
    }
  }

  /**
   * Stop the animation loop completely
   */
  stopAnimationLoop(): void {
    if (this.animationFrameId !== null) {
      window.cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    this.stateSubject.next('stopped');
  }

  /**
   * Start the game tick interval (100ms)
   * @param onTick Callback called on each tick
   * @param getContext Function to get current game context
   * @returns Cleanup function to stop the interval
   */
  startGameTick(onTick: () => void, getContext: () => GameTickContext): () => void {
    const tickDestroy$ = new Subject<void>();

    interval(GAME_CONSTANTS.GAME_LOOP_INTERVAL)
      .pipe(takeUntil(tickDestroy$))
      .subscribe(() => {
        const context = getContext();
        if (!context.isPaused && context.hasLevel && context.isRunning) {
          // Run in Angular zone to trigger change detection
          this.ngZone.run(() => onTick());
        }
      });

    return () => {
      tickDestroy$.next();
      tickDestroy$.complete();
    };
  }

  /**
   * Update data flow packets along connections
   * This handles packet spawning, movement, and cleanup
   * @param context Current data flow context
   */
  updateDataFlow(context: DataFlowContext): void {
    if (!context.isRunning) return;

    context.connections.forEach((conn) => {
      const source = context.nodes.find((n) => n.id === conn.sourceId);
      const target = context.nodes.find((n) => n.id === conn.targetId);

      if (!source || !target) return;

      // Update connection status based on source state
      if (
        source.status === NodeStatus.Running ||
        source.status === NodeStatus.Success ||
        source.status === NodeStatus.Retrying
      ) {
        conn.status = 'active';
      }

      // Spawn new packets from running source nodes
      this.spawnPackets(conn, source, target);

      // Update packet positions and remove completed ones
      this.updatePacketPositions(conn, context.gameSpeed);
    });
  }

  /**
   * Spawn data packets based on node states
   */
  private spawnPackets(conn: Connection, source: PipelineNode, target: PipelineNode): void {
    // Spawn from running source nodes - increased rate for visibility
    if (source.status === NodeStatus.Running && Math.random() < 0.25) {
      conn.dataFlow.push(this.createPacket(source.color || '#60a5fa'));
    }

    // Spawn when source completed (data transferring to next node)
    if (source.status === NodeStatus.Success && target.status === NodeStatus.Idle && Math.random() < 0.15) {
      conn.dataFlow.push(this.createPacket('#22c55e', true)); // Green for success
    }
  }

  /** Pre-computed glow colors to avoid string concatenation in the hot path */
  private readonly glowColorCache = new Map<string, string>();

  /**
   * Create a new data packet
   */
  private createPacket(color: string, isSuccess: boolean = false): DataPacket {
    let glowColor = this.glowColorCache.get(color);
    if (!glowColor) {
      glowColor = color + '40';
      this.glowColorCache.set(color, glowColor);
    }

    return {
      id: `packet-${Date.now()}-${Math.random()}`,
      type: 'code',
      progress: 0,
      speed: isSuccess ? 0.02 + Math.random() * 0.01 : 0.015 + Math.random() * 0.01,
      size: isSuccess ? 5 + Math.random() * 2 : 4 + Math.random() * 3,
      color,
      glowColor,
    };
  }

  /**
   * Update packet positions and remove completed packets
   */
  private updatePacketPositions(conn: Connection, gameSpeed: number): void {
    conn.dataFlow.forEach((packet) => {
      packet.progress += packet.speed * gameSpeed;
    });

    // Remove completed packets
    conn.dataFlow = conn.dataFlow.filter((p) => p.progress < 1);
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.stopAnimationLoop();
  }
}
