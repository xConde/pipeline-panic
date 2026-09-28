import { AudioService } from './audio.service';

/**
 * A recording stand-in for the Web Audio surface AudioService actually touches.
 *
 * The suite needs this because `play()` swallows every exception internally, so
 * `expect(() => play(name)).not.toThrow()` is true for any input at all — it
 * cannot tell a synthesized sound from a name the service does not know. These
 * fakes record the node graph instead, so the release desk sounds are asserted
 * by what they build rather than by not crashing.
 */
class FakeAudioParam {
  value = 0;
  readonly setValueAtTime = jasmine.createSpy<(value: number, startTime: number) => void>('setValueAtTime');
  readonly linearRampToValueAtTime =
    jasmine.createSpy<(value: number, endTime: number) => void>('linearRampToValueAtTime');
  readonly exponentialRampToValueAtTime =
    jasmine.createSpy<(value: number, endTime: number) => void>('exponentialRampToValueAtTime');
}

class FakeOscillator {
  type: OscillatorType = 'sine';
  readonly frequency = new FakeAudioParam();
  readonly connect = jasmine.createSpy<(destination: unknown) => void>('connect');
  readonly start = jasmine.createSpy<(when: number) => void>('start');
  readonly stop = jasmine.createSpy<(when: number) => void>('stop');
}

class FakeBufferSource {
  buffer: AudioBuffer | null = null;
  readonly connect = jasmine.createSpy<(destination: unknown) => void>('connect');
  readonly start = jasmine.createSpy<(when: number) => void>('start');
  readonly stop = jasmine.createSpy<(when: number) => void>('stop');
}

class FakeBiquadFilter {
  type: BiquadFilterType = 'lowpass';
  readonly frequency = new FakeAudioParam();
  readonly connect = jasmine.createSpy<(destination: unknown) => void>('connect');
}

class FakeGain {
  readonly gain = new FakeAudioParam();
  readonly connect = jasmine.createSpy<(destination: unknown) => void>('connect');
}

class FakeAudioContext {
  /** Every context constructed while the fake is installed, newest last. */
  static instances: FakeAudioContext[] = [];

  readonly oscillators: FakeOscillator[] = [];
  readonly bufferSources: FakeBufferSource[] = [];
  readonly filters: FakeBiquadFilter[] = [];
  readonly gains: FakeGain[] = [];
  readonly buffers: { channels: number; length: number; rate: number }[] = [];

  state: AudioContextState = 'running';
  currentTime = 0;
  readonly sampleRate = 48000;
  readonly destination = {};

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  /** Total nodes built so far — the measure that distinguishes sound from silence. */
  get nodeCount(): number {
    return this.oscillators.length + this.bufferSources.length + this.filters.length + this.gains.length;
  }

  createOscillator(): FakeOscillator {
    const oscillator = new FakeOscillator();
    this.oscillators.push(oscillator);
    return oscillator;
  }

  createGain(): FakeGain {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }

  createBiquadFilter(): FakeBiquadFilter {
    const filter = new FakeBiquadFilter();
    this.filters.push(filter);
    return filter;
  }

  createBufferSource(): FakeBufferSource {
    const source = new FakeBufferSource();
    this.bufferSources.push(source);
    return source;
  }

  createBuffer(channels: number, length: number, rate: number): AudioBuffer {
    this.buffers.push({ channels, length, rate });
    const data = new Float32Array(length);
    // Only getChannelData is ever called on this; the cast is the single
    // boundary between the recording fake and the Web Audio type.
    return { getChannelData: () => data } as unknown as AudioBuffer;
  }

  resume(): Promise<void> {
    this.state = 'running';
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.state = 'closed';
    return Promise.resolve();
  }
}

describe('AudioService', () => {
  let service: AudioService;
  let mockAudioContext: jasmine.SpyObj<AudioContext>;
  let mockOscillator: jasmine.SpyObj<OscillatorNode>;
  let mockGainNode: jasmine.SpyObj<GainNode>;

  beforeEach(() => {
    // Create mock AudioContext and nodes
    mockOscillator = jasmine.createSpyObj('OscillatorNode', ['connect', 'start', 'stop'], {
      frequency: { value: 0 },
      type: 'sine',
    });

    mockGainNode = jasmine.createSpyObj('GainNode', ['connect'], {
      gain: {
        setValueAtTime: jasmine.createSpy('setValueAtTime'),
        linearRampToValueAtTime: jasmine.createSpy('linearRampToValueAtTime'),
        exponentialRampToValueAtTime: jasmine.createSpy('exponentialRampToValueAtTime'),
      },
    });

    mockAudioContext = jasmine.createSpyObj('AudioContext', ['createOscillator', 'createGain', 'close', 'resume'], {
      state: 'running',
      currentTime: 0,
      destination: {},
    });

    mockAudioContext.createOscillator.and.returnValue(mockOscillator);
    mockAudioContext.createGain.and.returnValue(mockGainNode);

    service = new AudioService();
  });

  afterEach(() => {
    service.dispose();
  });

  describe('initialization', () => {
    it('should create service instance', () => {
      expect(service).toBeTruthy();
    });

    it('should not be available before initialization', () => {
      expect(service.isAvailable).toBeFalse();
    });

    it('should be enabled by default', () => {
      expect(service.enabled).toBeTrue();
    });

    it('should handle missing AudioContext gracefully', () => {
      // Service should handle environments without AudioContext
      const originalAudioContext = (window as { AudioContext?: typeof AudioContext }).AudioContext;
      delete (window as { AudioContext?: typeof AudioContext }).AudioContext;

      // initialize() is now lazy — it marks audio as requested but defers
      // AudioContext creation to the first play() call
      const result = service.initialize();
      expect(result).toBeTrue(); // Lazy init always succeeds at request time

      // Trigger the actual AudioContext creation via play()
      service.play('click');

      // AudioContext wasn't available, so isAvailable should be false
      expect(service.isAvailable).toBeFalse();

      // Restore
      if (originalAudioContext) {
        (window as { AudioContext?: typeof AudioContext }).AudioContext = originalAudioContext;
      }
    });

    it('should only initialize once', () => {
      // First initialization
      service.initialize();
      const firstAvailable = service.isAvailable;

      // Second initialization should return same state
      service.initialize();
      expect(service.isAvailable).toBe(firstAvailable);
    });
  });

  describe('enabled state', () => {
    it('should allow toggling enabled state', () => {
      expect(service.enabled).toBeTrue();

      service.enabled = false;
      expect(service.enabled).toBeFalse();

      service.enabled = true;
      expect(service.enabled).toBeTrue();
    });

    it('should toggle and return new state', () => {
      expect(service.toggle()).toBeFalse();
      expect(service.enabled).toBeFalse();

      expect(service.toggle()).toBeTrue();
      expect(service.enabled).toBeTrue();
    });
  });

  describe('play', () => {
    it('should not play when disabled', () => {
      service.enabled = false;
      // Should not throw
      expect(() => service.play('click')).not.toThrow();
    });

    it('should not play when not initialized', () => {
      // Service not initialized, should handle gracefully
      expect(() => service.play('success')).not.toThrow();
    });

    it('should handle invalid sound names gracefully', () => {
      service.initialize();
      // Cast to any to test invalid sound name
      expect(() => service.play('invalid_sound' as never)).not.toThrow();
    });
  });

  describe('dispose', () => {
    it('should clean up resources on dispose', () => {
      service.initialize();
      service.dispose();

      expect(service.isAvailable).toBeFalse();
    });

    it('should handle multiple dispose calls', () => {
      service.initialize();
      service.dispose();
      expect(() => service.dispose()).not.toThrow();
    });
  });

  describe('ngOnDestroy', () => {
    it('should call dispose on destroy', () => {
      spyOn(service, 'dispose');
      service.ngOnDestroy();
      expect(service.dispose).toHaveBeenCalled();
    });
  });

  describe('sound library', () => {
    const expectedSounds = [
      'click',
      'place',
      'connect',
      'success',
      'error',
      'start',
      'stop',
      'delete',
      'rollback',
      'stamp',
      'gate-lock',
      'gate-clear',
    ] as const;

    expectedSounds.forEach((soundName) => {
      // Smoke coverage only. play() catches its own exceptions, so this proves
      // the call is survivable, NOT that the sound exists — see the synthesis
      // suite below for the assertions that can actually tell those apart.
      it(`survives a '${soundName}' play request`, () => {
        service.initialize();
        expect(() => service.play(soundName)).not.toThrow();
      });
    });
  });

  describe('release desk synthesis', () => {
    let originalAudioContext: typeof AudioContext | undefined;

    beforeEach(() => {
      FakeAudioContext.instances = [];
      originalAudioContext = window.AudioContext;
      (window as { AudioContext?: typeof AudioContext }).AudioContext =
        FakeAudioContext as unknown as typeof AudioContext;
    });

    afterEach(() => {
      if (originalAudioContext) {
        (window as { AudioContext?: typeof AudioContext }).AudioContext = originalAudioContext;
      }
    });

    /** The one context play() should ever have built. */
    function onlyContext(): FakeAudioContext {
      expect(FakeAudioContext.instances.length).toBe(1);
      return FakeAudioContext.instances[0];
    }

    it('builds the stamp as a filtered noise burst over a low tone', () => {
      service.initialize();
      service.play('stamp');

      const ctx = onlyContext();
      // Felt texture: one noise buffer through one lowpass.
      expect(ctx.bufferSources.length).toBe(1);
      expect(ctx.buffers.length).toBe(1);
      expect(ctx.buffers[0].length).toBe(Math.round(ctx.sampleRate * 0.14));
      expect(ctx.filters.length).toBe(1);
      expect(ctx.filters[0].type).toBe('lowpass');
      expect(ctx.filters[0].frequency.value).toBe(600);
      expect(ctx.bufferSources[0].start).toHaveBeenCalled();
      expect(ctx.bufferSources[0].stop).toHaveBeenCalled();

      // Weight underneath: one quiet low sine, no longer the bare 150Hz square.
      expect(ctx.oscillators.length).toBe(1);
      expect(ctx.oscillators[0].type).toBe('sine');
      expect(ctx.oscillators[0].frequency.setValueAtTime).toHaveBeenCalledWith(90, 0);
    });

    it('generates the stamp noise once and replays it on every press', () => {
      service.initialize();
      service.play('stamp');
      service.play('stamp');
      service.play('stamp');

      const ctx = onlyContext();
      // Each press still needs its own source node; the ~27KB of samples behind
      // them is generated once.
      expect(ctx.bufferSources.length).toBe(3);
      expect(ctx.buffers.length).toBe(1);
      expect(ctx.bufferSources[1].buffer).toBe(ctx.bufferSources[0].buffer);
      expect(ctx.bufferSources[2].buffer).toBe(ctx.bufferSources[0].buffer);
    });

    it('generates a fresh buffer for a context opened after dispose', () => {
      service.initialize();
      service.play('stamp');
      const first = FakeAudioContext.instances[0];

      // initialize() clears the teardown flag, so a re-armed service opens a
      // second context. A buffer belongs to the context that made it, so the
      // cached one from the closed context must not survive the cycle.
      service.dispose();
      service.initialize();
      service.play('stamp');

      expect(FakeAudioContext.instances.length).toBe(2);
      const second = FakeAudioContext.instances[1];
      expect(second.buffers.length).toBe(1);
      expect(second.bufferSources[0].buffer).not.toBe(first.bufferSources[0].buffer);
    });

    it('builds gate-lock as two downward-bending thuds rather than the old error buzz', () => {
      service.initialize();
      service.play('gate-lock');

      const ctx = onlyContext();
      expect(ctx.oscillators.length).toBe(2);
      expect(ctx.bufferSources.length).toBe(0);
      ctx.oscillators.forEach((oscillator) => {
        expect(oscillator.type).toBe('sine');
        expect(oscillator.frequency.setValueAtTime).toHaveBeenCalledWith(70, jasmine.any(Number));
        expect(oscillator.frequency.exponentialRampToValueAtTime).toHaveBeenCalledWith(54, jasmine.any(Number));
      });

      const [first, second] = ctx.oscillators;
      expect(second.start.calls.mostRecent().args[0]).toBeGreaterThan(first.start.calls.mostRecent().args[0]);
    });

    it('builds gate-clear as two rising lowpassed notes', () => {
      service.initialize();
      service.play('gate-clear');

      const ctx = onlyContext();
      expect(ctx.oscillators.length).toBe(2);
      expect(ctx.oscillators[0].frequency.setValueAtTime).toHaveBeenCalledWith(329.63, jasmine.any(Number));
      expect(ctx.oscillators[1].frequency.setValueAtTime).toHaveBeenCalledWith(440, jasmine.any(Number));
      expect(ctx.filters.length).toBe(2);
      ctx.filters.forEach((filter) => expect(filter.frequency.value).toBe(1800));
    });

    it('builds no nodes at all for a name the library does not define', () => {
      service.initialize();
      service.play('invalid_sound' as never);

      // play() still opens a context before the lookup, so emptiness is the
      // assertion that separates a defined sound from an undefined one.
      expect(onlyContext().nodeCount).toBe(0);
    });

    it('builds no nodes for a desk sound while sound is disabled', () => {
      service.initialize();
      service.enabled = false;
      service.play('stamp');
      service.play('gate-lock');
      service.play('gate-clear');

      expect(FakeAudioContext.instances.length).toBe(0);
    });

    it('does not resurrect audio or open a second context after dispose', () => {
      service.initialize();
      service.play('stamp');
      const ctx = onlyContext();
      const nodesBeforeDispose = ctx.nodeCount;
      expect(nodesBeforeDispose).toBeGreaterThan(0);

      service.dispose();
      service.play('stamp');
      service.play('gate-lock');
      service.play('gate-clear');
      service.play('click');

      // The desk sounds are synthesized ahead of the sound library, so clearing
      // that library no longer silences them — only the teardown flag does.
      expect(FakeAudioContext.instances.length).toBe(1);
      expect(ctx.nodeCount).toBe(nodesBeforeDispose);
    });
  });
});
