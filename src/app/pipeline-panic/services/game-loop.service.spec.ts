import { NgZone } from '@angular/core';
import { discardPeriodicTasks, fakeAsync, TestBed, tick } from '@angular/core/testing';
import { AnimationState, DataFlowContext, GameLoopService } from './game-loop.service';
import { Connection, NodeStatus, NodeType, PipelineNode } from '../models/pipeline.model';
import { createMockConnection, createMockNode } from '../testing/test-utils';

describe('GameLoopService', () => {
  let service: GameLoopService;
  let ngZone: NgZone;
  let mockRequestAnimationFrame: jasmine.Spy;
  let mockCancelAnimationFrame: jasmine.Spy;
  let animationCallbacks: (() => void)[];
  let frameId: number;

  beforeEach(() => {
    // Mock requestAnimationFrame and cancelAnimationFrame
    frameId = 1;
    animationCallbacks = [];
    mockRequestAnimationFrame = spyOn(window, 'requestAnimationFrame').and.callFake(
      (callback: FrameRequestCallback) => {
        animationCallbacks.push(() => callback(Date.now()));
        return frameId++;
      }
    );
    mockCancelAnimationFrame = spyOn(window, 'cancelAnimationFrame').and.callFake(() => {
      animationCallbacks.pop();
    });

    TestBed.configureTestingModule({
      providers: [GameLoopService],
    });

    ngZone = TestBed.inject(NgZone);
    service = TestBed.inject(GameLoopService);
  });

  afterEach(() => {
    service.destroy();
  });

  describe('initial state', () => {
    it('should have stopped state initially', () => {
      expect(service.state).toBe('stopped');
    });

    it('should not be running initially', () => {
      expect(service.isRunning).toBe(false);
    });
  });

  describe('state$ observable', () => {
    it('should emit initial stopped state', () => {
      // Use synchronous check since BehaviorSubject emits immediately
      let emittedState: AnimationState | undefined;
      const subscription = service.state$.subscribe((state) => {
        emittedState = state;
      });
      subscription.unsubscribe();
      expect(emittedState).toBe('stopped');
    });

    it('should emit running state when animation starts', () => {
      const states: AnimationState[] = [];
      const subscription = service.state$.subscribe((state) => {
        states.push(state);
      });

      service.startAnimationLoop(() => {});

      subscription.unsubscribe();
      expect(states).toEqual(['stopped', 'running']);
    });

    it('should emit paused state when animation pauses', () => {
      const states: AnimationState[] = [];
      const subscription = service.state$.subscribe((state) => {
        states.push(state);
      });

      service.startAnimationLoop(() => {});
      service.pauseAnimationLoop();

      subscription.unsubscribe();
      expect(states).toEqual(['stopped', 'running', 'paused']);
    });
  });

  describe('startAnimationLoop', () => {
    it('should request animation frame', () => {
      service.startAnimationLoop(() => {});

      expect(mockRequestAnimationFrame).toHaveBeenCalled();
    });

    it('should call onFrame callback', () => {
      const onFrame = jasmine.createSpy('onFrame');

      service.startAnimationLoop(onFrame);

      // Simulate first animation frame
      if (animationCallbacks.length > 0) {
        animationCallbacks[0]();
      }

      expect(onFrame).toHaveBeenCalled();
    });

    it('should set isRunning to true', () => {
      service.startAnimationLoop(() => {});

      expect(service.isRunning).toBe(true);
    });

    it('should not start if already running', () => {
      service.startAnimationLoop(() => {});
      const initialCallCount = mockRequestAnimationFrame.calls.count();

      service.startAnimationLoop(() => {});

      // Should not have added another callback (already running)
      expect(mockRequestAnimationFrame.calls.count()).toBe(initialCallCount);
    });

    it('should update state to running', () => {
      service.startAnimationLoop(() => {});

      expect(service.state).toBe('running');
    });

    it('should run animation loop outside Angular zone for performance', () => {
      const runOutsideAngularSpy = spyOn(ngZone, 'runOutsideAngular').and.callThrough();

      service.startAnimationLoop(() => {});

      expect(runOutsideAngularSpy).toHaveBeenCalled();
    });
  });

  describe('pauseAnimationLoop', () => {
    it('should cancel animation frame', () => {
      service.startAnimationLoop(() => {});
      service.pauseAnimationLoop();

      expect(mockCancelAnimationFrame).toHaveBeenCalled();
    });

    it('should set isRunning to false', () => {
      service.startAnimationLoop(() => {});
      service.pauseAnimationLoop();

      expect(service.isRunning).toBe(false);
    });

    it('should update state to paused', () => {
      service.startAnimationLoop(() => {});
      service.pauseAnimationLoop();

      expect(service.state).toBe('paused');
    });

    it('should do nothing if not running', () => {
      service.pauseAnimationLoop();

      expect(mockCancelAnimationFrame).not.toHaveBeenCalled();
    });
  });

  describe('resumeAnimationLoop', () => {
    it('should restart animation loop after pause', () => {
      service.startAnimationLoop(() => {});
      service.pauseAnimationLoop();
      const callCountAfterPause = mockRequestAnimationFrame.calls.count();

      service.resumeAnimationLoop(() => {});

      expect(mockRequestAnimationFrame.calls.count()).toBeGreaterThan(callCountAfterPause);
    });

    it('should not resume if state is not paused', () => {
      // State is 'stopped', not 'paused'
      const initialCallCount = mockRequestAnimationFrame.calls.count();

      service.resumeAnimationLoop(() => {});

      expect(mockRequestAnimationFrame.calls.count()).toBe(initialCallCount);
    });

    it('should update state to running after resume', () => {
      service.startAnimationLoop(() => {});
      service.pauseAnimationLoop();
      service.resumeAnimationLoop(() => {});

      expect(service.state).toBe('running');
    });
  });

  describe('stopAnimationLoop', () => {
    it('should cancel animation frame', () => {
      service.startAnimationLoop(() => {});
      service.stopAnimationLoop();

      expect(mockCancelAnimationFrame).toHaveBeenCalled();
    });

    it('should set isRunning to false', () => {
      service.startAnimationLoop(() => {});
      service.stopAnimationLoop();

      expect(service.isRunning).toBe(false);
    });

    it('should update state to stopped', () => {
      service.startAnimationLoop(() => {});
      service.stopAnimationLoop();

      expect(service.state).toBe('stopped');
    });

    it('should do nothing if not running', () => {
      service.stopAnimationLoop();

      expect(mockCancelAnimationFrame).not.toHaveBeenCalled();
      expect(service.state).toBe('stopped');
    });
  });

  describe('startGameTick', () => {
    it('should return a cleanup function', () => {
      const cleanup = service.startGameTick(
        () => {},
        () => ({ isRunning: true, isPaused: false, hasLevel: true })
      );

      expect(typeof cleanup).toBe('function');
      cleanup();
    });

    it('should call onTick when conditions are met', fakeAsync(() => {
      const onTick = jasmine.createSpy('onTick');
      const getContext = (): { isRunning: boolean; isPaused: boolean; hasLevel: boolean } => ({
        isRunning: true,
        isPaused: false,
        hasLevel: true,
      });

      const cleanup = service.startGameTick(onTick, getContext);

      tick(100); // Advance by one tick interval
      expect(onTick).toHaveBeenCalled();

      cleanup();
      discardPeriodicTasks();
    }));

    it('should not call onTick when isPaused is true', fakeAsync(() => {
      const onTick = jasmine.createSpy('onTick');
      const getContext = (): { isRunning: boolean; isPaused: boolean; hasLevel: boolean } => ({
        isRunning: true,
        isPaused: true,
        hasLevel: true,
      });

      const cleanup = service.startGameTick(onTick, getContext);

      tick(100);
      expect(onTick).not.toHaveBeenCalled();

      cleanup();
      discardPeriodicTasks();
    }));

    it('should not call onTick when isRunning is false', fakeAsync(() => {
      const onTick = jasmine.createSpy('onTick');
      const getContext = (): { isRunning: boolean; isPaused: boolean; hasLevel: boolean } => ({
        isRunning: false,
        isPaused: false,
        hasLevel: true,
      });

      const cleanup = service.startGameTick(onTick, getContext);

      tick(100);
      expect(onTick).not.toHaveBeenCalled();

      cleanup();
      discardPeriodicTasks();
    }));

    it('should not call onTick when hasLevel is false', fakeAsync(() => {
      const onTick = jasmine.createSpy('onTick');
      const getContext = (): { isRunning: boolean; isPaused: boolean; hasLevel: boolean } => ({
        isRunning: true,
        isPaused: false,
        hasLevel: false,
      });

      const cleanup = service.startGameTick(onTick, getContext);

      tick(100);
      expect(onTick).not.toHaveBeenCalled();

      cleanup();
      discardPeriodicTasks();
    }));

    it('should call onTick multiple times', fakeAsync(() => {
      const onTick = jasmine.createSpy('onTick');
      const getContext = (): { isRunning: boolean; isPaused: boolean; hasLevel: boolean } => ({
        isRunning: true,
        isPaused: false,
        hasLevel: true,
      });

      const cleanup = service.startGameTick(onTick, getContext);

      tick(300); // 3 tick intervals
      expect(onTick).toHaveBeenCalledTimes(3);

      cleanup();
      discardPeriodicTasks();
    }));

    it('should stop calling onTick after cleanup', fakeAsync(() => {
      const onTick = jasmine.createSpy('onTick');
      const getContext = (): { isRunning: boolean; isPaused: boolean; hasLevel: boolean } => ({
        isRunning: true,
        isPaused: false,
        hasLevel: true,
      });

      const cleanup = service.startGameTick(onTick, getContext);

      tick(100);
      expect(onTick).toHaveBeenCalledTimes(1);

      cleanup();

      tick(200);
      expect(onTick).toHaveBeenCalledTimes(1); // No additional calls
    }));

    it('should run onTick in Angular zone', fakeAsync(() => {
      const runSpy = spyOn(ngZone, 'run').and.callThrough();
      const onTick = jasmine.createSpy('onTick');
      const getContext = (): { isRunning: boolean; isPaused: boolean; hasLevel: boolean } => ({
        isRunning: true,
        isPaused: false,
        hasLevel: true,
      });

      const cleanup = service.startGameTick(onTick, getContext);

      tick(100);
      expect(runSpy).toHaveBeenCalled();
      expect(onTick).toHaveBeenCalled();

      cleanup();
      discardPeriodicTasks();
    }));
  });

  describe('updateDataFlow', () => {
    let nodes: PipelineNode[];
    let connections: Connection[];

    beforeEach(() => {
      nodes = [
        createMockNode('source-1', NodeType.Source, NodeStatus.Running),
        createMockNode('build-1', NodeType.Build, NodeStatus.Idle),
      ];
      connections = [createMockConnection('source-1', 'build-1')];
    });

    it('should do nothing when not running', () => {
      const context: DataFlowContext = {
        connections,
        nodes,
        isRunning: false,
        gameSpeed: 1,
      };

      service.updateDataFlow(context);

      // No packets should be added
      expect(connections[0].dataFlow.length).toBe(0);
    });

    it('should update connection status when source is running', () => {
      const context: DataFlowContext = {
        connections,
        nodes,
        isRunning: true,
        gameSpeed: 1,
      };

      service.updateDataFlow(context);

      expect(connections[0].status).toBe('active');
    });

    it('should update connection status when source is successful', () => {
      nodes[0].status = NodeStatus.Success;
      const context: DataFlowContext = {
        connections,
        nodes,
        isRunning: true,
        gameSpeed: 1,
      };

      service.updateDataFlow(context);

      expect(connections[0].status).toBe('active');
    });

    it('should spawn packets from running source nodes (probabilistic)', () => {
      // Run multiple times to account for randomness
      let packetSpawned = false;
      for (let i = 0; i < 100; i++) {
        connections[0].dataFlow = [];
        const context: DataFlowContext = {
          connections,
          nodes,
          isRunning: true,
          gameSpeed: 1,
        };

        service.updateDataFlow(context);

        if (connections[0].dataFlow.length > 0) {
          packetSpawned = true;
          break;
        }
      }

      expect(packetSpawned).toBe(true);
    });

    it('should spawn success packets when source completed and target idle (probabilistic)', () => {
      nodes[0].status = NodeStatus.Success;
      nodes[1].status = NodeStatus.Idle;

      let packetSpawned = false;
      for (let i = 0; i < 100; i++) {
        connections[0].dataFlow = [];
        const context: DataFlowContext = {
          connections,
          nodes,
          isRunning: true,
          gameSpeed: 1,
        };

        service.updateDataFlow(context);

        if (connections[0].dataFlow.length > 0) {
          packetSpawned = true;
          expect(connections[0].dataFlow[0].color).toBe('#22c55e'); // Green for success
          break;
        }
      }

      expect(packetSpawned).toBe(true);
    });

    it('should update packet progress based on game speed', () => {
      connections[0].dataFlow = [
        { id: 'packet-1', type: 'code', progress: 0, speed: 0.02, size: 5, color: '#60a5fa', glowColor: '#60a5fa40' },
      ];

      const context: DataFlowContext = {
        connections,
        nodes,
        isRunning: true,
        gameSpeed: 1,
      };

      const initialProgress = connections[0].dataFlow[0].progress;
      service.updateDataFlow(context);

      expect(connections[0].dataFlow[0].progress).toBeGreaterThan(initialProgress);
    });

    it('should update packet progress faster with higher game speed', () => {
      connections[0].dataFlow = [
        { id: 'packet-1', type: 'code', progress: 0, speed: 0.02, size: 5, color: '#60a5fa', glowColor: '#60a5fa40' },
      ];

      const context1: DataFlowContext = {
        connections: [{ ...connections[0], dataFlow: [{ ...connections[0].dataFlow[0] }] }],
        nodes,
        isRunning: true,
        gameSpeed: 1,
      };

      const context2: DataFlowContext = {
        connections: [{ ...connections[0], dataFlow: [{ ...connections[0].dataFlow[0] }] }],
        nodes,
        isRunning: true,
        gameSpeed: 2,
      };

      service.updateDataFlow(context1);
      const progress1 = context1.connections[0].dataFlow[0].progress;

      service.updateDataFlow(context2);
      const progress2 = context2.connections[0].dataFlow[0].progress;

      expect(progress2).toBeGreaterThan(progress1);
    });

    it('should remove completed packets (progress >= 1)', () => {
      nodes[0].status = NodeStatus.Idle; // Prevent new packet spawning
      connections[0].dataFlow = [
        {
          id: 'packet-1',
          type: 'code',
          progress: 0.99,
          speed: 0.02,
          size: 5,
          color: '#60a5fa',
          glowColor: '#60a5fa40',
        },
      ];

      const context: DataFlowContext = {
        connections,
        nodes,
        isRunning: true,
        gameSpeed: 1,
      };

      service.updateDataFlow(context);

      expect(connections[0].dataFlow.length).toBe(0);
    });

    it('should keep incomplete packets', () => {
      nodes[0].status = NodeStatus.Idle; // Prevent new packet spawning
      connections[0].dataFlow = [
        { id: 'packet-1', type: 'code', progress: 0.5, speed: 0.02, size: 5, color: '#60a5fa', glowColor: '#60a5fa40' },
      ];

      const context: DataFlowContext = {
        connections,
        nodes,
        isRunning: true,
        gameSpeed: 1,
      };

      service.updateDataFlow(context);

      expect(connections[0].dataFlow.length).toBe(1);
    });

    it('should not modify connections with missing source node', () => {
      const orphanConnection = createMockConnection('nonexistent-1', 'build-1');
      orphanConnection.status = 'inactive';

      const context: DataFlowContext = {
        connections: [orphanConnection],
        nodes,
        isRunning: true,
        gameSpeed: 1,
      };

      service.updateDataFlow(context);

      // Status should not change
      expect(orphanConnection.status).toBe('inactive');
    });

    it('should not modify connections with missing target node', () => {
      const orphanConnection = createMockConnection('source-1', 'nonexistent-1');
      orphanConnection.status = 'inactive';

      const context: DataFlowContext = {
        connections: [orphanConnection],
        nodes,
        isRunning: true,
        gameSpeed: 1,
      };

      service.updateDataFlow(context);

      // Status should not change
      expect(orphanConnection.status).toBe('inactive');
    });

    it('should create packets with correct properties', () => {
      // Force packet creation by using high spawn rate test
      spyOn(Math, 'random').and.returnValue(0.1); // Below 0.25 threshold

      connections[0].dataFlow = [];
      const context: DataFlowContext = {
        connections,
        nodes,
        isRunning: true,
        gameSpeed: 1,
      };

      service.updateDataFlow(context);

      if (connections[0].dataFlow.length > 0) {
        const packet = connections[0].dataFlow[0];
        expect(packet.id).toMatch(/^packet-/);
        expect(packet.type).toBe('code');
        // Progress is updated immediately after spawn, so it will be small but > 0
        expect(packet.progress).toBeGreaterThanOrEqual(0);
        expect(packet.progress).toBeLessThan(0.1);
        expect(packet.speed).toBeGreaterThan(0);
        expect(packet.size).toBeGreaterThan(0);
        expect(packet.color).toBeDefined();
      }
    });

    it('should handle multiple connections independently', () => {
      const multiNodes = [
        createMockNode('source-1', NodeType.Source, NodeStatus.Running),
        createMockNode('build-1', NodeType.Build, NodeStatus.Running),
        createMockNode('test-1', NodeType.Test, NodeStatus.Idle),
      ];
      const multiConnections = [createMockConnection('source-1', 'build-1'), createMockConnection('build-1', 'test-1')];
      // Add existing packets to first connection
      multiConnections[0].dataFlow = [
        { id: 'packet-1', type: 'code', progress: 0.5, speed: 0.02, size: 5, color: '#60a5fa', glowColor: '#60a5fa40' },
      ];

      const context: DataFlowContext = {
        connections: multiConnections,
        nodes: multiNodes,
        isRunning: true,
        gameSpeed: 1,
      };

      service.updateDataFlow(context);

      // First connection should have packet progress updated
      expect(multiConnections[0].dataFlow[0].progress).toBeGreaterThan(0.5);
      // Both connections should be active (source is running)
      expect(multiConnections[0].status).toBe('active');
      expect(multiConnections[1].status).toBe('active');
    });

    it('should not spawn packets when source is idle', () => {
      nodes[0].status = NodeStatus.Idle;
      spyOn(Math, 'random').and.returnValue(0.1); // Would normally spawn

      connections[0].dataFlow = [];
      const context: DataFlowContext = {
        connections,
        nodes,
        isRunning: true,
        gameSpeed: 1,
      };

      service.updateDataFlow(context);

      // No packets should spawn from idle node
      expect(connections[0].dataFlow.length).toBe(0);
    });

    it('should not spawn success packets when target is not idle', () => {
      nodes[0].status = NodeStatus.Success;
      nodes[1].status = NodeStatus.Running; // Target is running, not idle
      spyOn(Math, 'random').and.returnValue(0.1); // Would normally spawn

      connections[0].dataFlow = [];
      const context: DataFlowContext = {
        connections,
        nodes,
        isRunning: true,
        gameSpeed: 1,
      };

      service.updateDataFlow(context);

      // No success packets should spawn when target is not idle
      expect(connections[0].dataFlow.length).toBe(0);
    });
  });

  describe('destroy', () => {
    it('should stop animation loop', () => {
      service.startAnimationLoop(() => {});
      service.destroy();

      expect(service.isRunning).toBe(false);
      expect(service.state).toBe('stopped');
    });

    it('should cancel animation frame', () => {
      service.startAnimationLoop(() => {});
      service.destroy();

      expect(mockCancelAnimationFrame).toHaveBeenCalled();
    });

    it('should be safe to call multiple times', () => {
      service.destroy();
      expect(() => service.destroy()).not.toThrow();
    });
  });

  describe('edge cases', () => {
    it('should handle empty connections array', () => {
      const context: DataFlowContext = {
        connections: [],
        nodes: [],
        isRunning: true,
        gameSpeed: 1,
      };

      expect(() => service.updateDataFlow(context)).not.toThrow();
    });

    it('should handle empty nodes array', () => {
      const context: DataFlowContext = {
        connections: [createMockConnection('source-1', 'build-1')],
        nodes: [],
        isRunning: true,
        gameSpeed: 1,
      };

      expect(() => service.updateDataFlow(context)).not.toThrow();
    });

    it('should handle zero game speed', () => {
      const nodes = [
        createMockNode('source-1', NodeType.Source, NodeStatus.Running),
        createMockNode('build-1', NodeType.Build, NodeStatus.Idle),
      ];
      const connections = [createMockConnection('source-1', 'build-1')];
      connections[0].dataFlow = [
        { id: 'packet-1', type: 'code', progress: 0.5, speed: 0.02, size: 5, color: '#60a5fa', glowColor: '#60a5fa40' },
      ];

      const context: DataFlowContext = {
        connections,
        nodes,
        isRunning: true,
        gameSpeed: 0,
      };

      service.updateDataFlow(context);

      // Progress should not change with zero speed
      expect(connections[0].dataFlow[0].progress).toBe(0.5);
    });

    it('should handle negative game speed gracefully', () => {
      const nodes = [
        createMockNode('source-1', NodeType.Source, NodeStatus.Running),
        createMockNode('build-1', NodeType.Build, NodeStatus.Idle),
      ];
      const connections = [createMockConnection('source-1', 'build-1')];
      connections[0].dataFlow = [
        { id: 'packet-1', type: 'code', progress: 0.5, speed: 0.02, size: 5, color: '#60a5fa', glowColor: '#60a5fa40' },
      ];

      const context: DataFlowContext = {
        connections,
        nodes,
        isRunning: true,
        gameSpeed: -1,
      };

      // Should not throw
      expect(() => service.updateDataFlow(context)).not.toThrow();
    });
  });
});
