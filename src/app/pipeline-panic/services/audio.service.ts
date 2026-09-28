import { Injectable, OnDestroy } from '@angular/core';

/**
 * Sound definition for Web Audio API synthesis
 */
export interface SoundDefinition {
  frequency: number;
  type: OscillatorType;
  duration: number;
}

/**
 * Available sound effects in the game
 */
export type SoundName =
  | 'click'
  | 'place'
  | 'connect'
  | 'success'
  | 'error'
  | 'start'
  | 'stop'
  | 'delete'
  | 'rollback'
  | 'stamp'
  | 'gate-lock'
  | 'gate-clear';

/**
 * One synthesized layer of a multi-node sound: an oscillator or a filtered
 * noise burst, with its own timing and envelope. The release desk's stamp
 * and gate sounds compose several of these against a shared time origin,
 * where the simpler UI sounds in `sounds` only ever need one.
 */
interface ToneLayer {
  readonly frequency: number;
  /** When set, the oscillator pitch-bends from `frequency` to this value by the end of the layer. */
  readonly endFrequency?: number;
  readonly type: OscillatorType;
  readonly startTime: number;
  readonly duration: number;
  readonly peakGain: number;
  /** When set, routes the tone through a lowpass filter at this cutoff instead of straight to destination. */
  readonly lowpassHz?: number;
}

/** One filtered white-noise burst layer — the felt texture under the stamp. */
interface NoiseLayer {
  readonly startTime: number;
  readonly duration: number;
  readonly peakGain: number;
  readonly lowpassHz: number;
}

/**
 * Extended window interface for webkit audio context support
 */
interface WindowWithWebkit extends Window {
  webkitAudioContext?: typeof AudioContext;
}

/**
 * AudioService - Handles all game audio using Web Audio API
 *
 * Responsibilities:
 * - Initialize and manage AudioContext lifecycle
 * - Synthesize simple sound effects
 * - Handle browser compatibility (webkit prefix)
 * - Gracefully degrade when audio unavailable
 *
 * Usage:
 * ```typescript
 * constructor(private audioService: AudioService) {}
 *
 * onNodePlaced() {
 *   this.audioService.play('place');
 * }
 * ```
 */
@Injectable()
export class AudioService implements OnDestroy {
  private audioContext: AudioContext | null = null;
  private sounds: Map<SoundName, SoundDefinition> = new Map();
  private _enabled = true;
  private initialized = false;
  private initRequested = false;
  /**
   * Set by dispose(), and the single teardown rule play() honors. Clearing
   * the sound library used to silence the service by itself, but the release
   * desk sounds are synthesized ahead of that library and would otherwise
   * build a fresh AudioContext after the owning component was destroyed.
   */
  private disposed = false;

  /**
   * The stamp's white noise, generated once and replayed.
   *
   * Every stamp press used to fill a fresh ~27KB buffer with Math.random(),
   * which is the one allocation the desk makes on a hot path. The samples are
   * noise, so the same buffer is as good the second time. An AudioBuffer belongs
   * to the context that created it, so this is cleared wherever the context is,
   * and the sample count is kept beside it in case a future layer asks for a
   * burst of a different length.
   */
  private noiseBuffer: AudioBuffer | null = null;
  private noiseBufferSampleCount = 0;

  /**
   * Whether sound is enabled
   */
  get enabled(): boolean {
    return this._enabled;
  }

  set enabled(value: boolean) {
    this._enabled = value;
  }

  /**
   * Whether audio system is available
   */
  get isAvailable(): boolean {
    return this.audioContext !== null;
  }

  /**
   * Mark the audio system as ready for lazy initialization.
   * The actual AudioContext is created on the first call to play(),
   * which is guaranteed to follow a user interaction (click/keypress),
   * satisfying the browser autoplay policy.
   */
  initialize(): boolean {
    this.disposed = false;
    this.initRequested = true;
    // Sound library uses no external resources — safe to populate eagerly
    if (this.sounds.size === 0) {
      this.initializeSoundLibrary();
    }
    return true;
  }

  /**
   * Lazily create the AudioContext on first actual use.
   * This avoids the browser console warning
   * "AudioContext was not allowed to start".
   */
  private ensureAudioContext(): boolean {
    if (this.initialized) {
      return this.isAvailable;
    }

    const AudioContextConstructor = this.getAudioContextConstructor();
    if (!AudioContextConstructor) {
      this.handleAudioUnavailable();
      this.initialized = true;
      return false;
    }

    try {
      this.audioContext = new AudioContextConstructor();
      // A buffer belongs to the context that made it, and passing one to a
      // different context throws. Invalidate at the moment of assignment so the
      // cache can only ever hold a buffer from the live context.
      this.noiseBuffer = null;
      this.noiseBufferSampleCount = 0;
      this.initialized = true;
      return true;
    } catch (error) {
      this.handleAudioError(error);
      this.initialized = true;
      return false;
    }
  }

  /**
   * Play a sound effect by name.
   * Lazily creates the AudioContext on first call (requires user gesture).
   *
   * @param name - The sound effect to play
   */
  play(name: SoundName): void {
    if (this.disposed || !this._enabled || !this.initRequested) {
      return;
    }

    // Lazy-create AudioContext on first play (guaranteed to be inside a user gesture)
    if (!this.initialized) {
      this.ensureAudioContext();
    }

    if (!this.audioContext) {
      return;
    }

    // Resume suspended context (e.g. after tab was backgrounded)
    if (this.audioContext.state === 'suspended') {
      void this.audioContext.resume();
    }

    try {
      // The release desk's stamp and gate sounds are multi-layer synthesis
      // (noise bursts, pitch bends, filters) that don't fit the single
      // oscillator + gain envelope the `sounds` library plays back.
      switch (name) {
        case 'stamp':
          this.synthesizeStamp();
          return;
        case 'gate-lock':
          this.synthesizeGateLock();
          return;
        case 'gate-clear':
          this.synthesizeGateClear();
          return;
        default:
          break;
      }

      const sound = this.sounds.get(name);
      if (!sound) {
        return;
      }
      this.synthesizeSound(sound);
    } catch {
      // Silently handle audio errors during playback
    }
  }

  /**
   * Resume audio context if suspended (required after user interaction)
   */
  async resume(): Promise<void> {
    if (this.audioContext?.state === 'suspended') {
      await this.audioContext.resume();
    }
  }

  /**
   * Toggle sound enabled state
   * @returns New enabled state
   */
  toggle(): boolean {
    this._enabled = !this._enabled;
    return this._enabled;
  }

  ngOnDestroy(): void {
    this.dispose();
  }

  /**
   * Clean up audio resources
   */
  dispose(): void {
    this.disposed = true;
    if (this.audioContext && this.audioContext.state !== 'closed') {
      void this.audioContext.close();
      this.audioContext = null;
    }
    this.sounds.clear();
    this.noiseBuffer = null;
    this.noiseBufferSampleCount = 0;
    this.initialized = false;
  }

  /**
   * Get the appropriate AudioContext constructor for the browser
   */
  private getAudioContextConstructor(): typeof AudioContext | undefined {
    if (typeof window === 'undefined') {
      return undefined;
    }

    if (window.AudioContext) {
      return window.AudioContext;
    }

    const windowWithWebkit = window as WindowWithWebkit;
    if (windowWithWebkit.webkitAudioContext) {
      return windowWithWebkit.webkitAudioContext;
    }

    return undefined;
  }

  /**
   * Handle case where AudioContext is not available
   */
  private handleAudioUnavailable(): void {
    window.debugLogBridge?.log('AudioContext not available in this browser', 'warning');
  }

  /**
   * Handle audio initialization errors
   */
  private handleAudioError(error: unknown): void {
    window.debugLogBridge?.log('Failed to initialize AudioContext: ' + String(error), 'error');
  }

  /**
   * Initialize the sound effect library
   */
  private initializeSoundLibrary(): void {
    // UI sounds
    this.sounds.set('click', { frequency: 200, type: 'sine', duration: 0.1 });
    this.sounds.set('place', { frequency: 400, type: 'square', duration: 0.1 });
    this.sounds.set('connect', { frequency: 600, type: 'sine', duration: 0.1 });
    this.sounds.set('delete', { frequency: 250, type: 'square', duration: 0.15 });

    // Game event sounds
    this.sounds.set('success', { frequency: 800, type: 'sine', duration: 0.2 });
    this.sounds.set('error', { frequency: 200, type: 'sawtooth', duration: 0.2 });
    this.sounds.set('start', { frequency: 500, type: 'sine', duration: 0.3 });
    this.sounds.set('stop', { frequency: 300, type: 'sine', duration: 0.2 });
    this.sounds.set('rollback', { frequency: 450, type: 'sine', duration: 0.25 });

    // Release desk sounds ('stamp', 'gate-lock', 'gate-clear') are custom
    // multi-layer synthesis — see synthesizeStamp/GateLock/GateClear below —
    // not single-oscillator entries in this library.
  }

  /**
   * Synthesize and play a sound using Web Audio API
   */
  private synthesizeSound(sound: SoundDefinition): void {
    if (!this.audioContext) {
      return;
    }

    const oscillator = this.audioContext.createOscillator();
    const gainNode = this.audioContext.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(this.audioContext.destination);

    oscillator.frequency.value = sound.frequency;
    oscillator.type = sound.type;

    // Envelope: quick attack, exponential decay
    const now = this.audioContext.currentTime;
    gainNode.gain.setValueAtTime(0, now);
    gainNode.gain.linearRampToValueAtTime(0.1, now + 0.01);
    gainNode.gain.exponentialRampToValueAtTime(0.01, now + sound.duration);

    oscillator.start(now);
    oscillator.stop(now + sound.duration);
  }

  /**
   * Play one oscillator layer with a quick attack and an exponential decay to
   * near-silence — the same envelope shape as `synthesizeSound`, just callable
   * several times against a shared time origin so layers can stack, and with
   * an optional pitch bend and lowpass for the release desk's softer sounds.
   */
  private playToneLayer(layer: ToneLayer): void {
    const ctx = this.audioContext;
    if (!ctx) return;

    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();
    oscillator.type = layer.type;
    oscillator.frequency.setValueAtTime(layer.frequency, layer.startTime);
    if (layer.endFrequency !== undefined) {
      oscillator.frequency.exponentialRampToValueAtTime(layer.endFrequency, layer.startTime + layer.duration);
    }

    oscillator.connect(gainNode);
    if (layer.lowpassHz !== undefined) {
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = layer.lowpassHz;
      gainNode.connect(filter);
      filter.connect(ctx.destination);
    } else {
      gainNode.connect(ctx.destination);
    }

    gainNode.gain.setValueAtTime(0, layer.startTime);
    gainNode.gain.linearRampToValueAtTime(layer.peakGain, layer.startTime + 0.002);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, layer.startTime + layer.duration);

    oscillator.start(layer.startTime);
    oscillator.stop(layer.startTime + layer.duration);
  }

  /** Play one lowpass-filtered white-noise burst layer — the felt texture under the stamp. */
  private playNoiseLayer(layer: NoiseLayer): void {
    const ctx = this.audioContext;
    if (!ctx) return;

    const sampleCount = Math.max(1, Math.round(ctx.sampleRate * layer.duration));
    const buffer = this.noiseBufferFor(ctx, sampleCount);

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = layer.lowpassHz;

    const gainNode = ctx.createGain();
    gainNode.gain.setValueAtTime(0, layer.startTime);
    gainNode.gain.linearRampToValueAtTime(layer.peakGain, layer.startTime + 0.002);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, layer.startTime + layer.duration);

    source.connect(filter);
    filter.connect(gainNode);
    gainNode.connect(ctx.destination);

    source.start(layer.startTime);
    source.stop(layer.startTime + layer.duration);
  }

  /** The cached noise burst, generating it on the first press or on a new length. */
  private noiseBufferFor(ctx: AudioContext, sampleCount: number): AudioBuffer {
    const cached = this.noiseBuffer;
    if (cached && this.noiseBufferSampleCount === sampleCount) {
      return cached;
    }

    const buffer = ctx.createBuffer(1, sampleCount, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < sampleCount; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    this.noiseBuffer = buffer;
    this.noiseBufferSampleCount = sampleCount;
    return buffer;
  }

  /**
   * Release desk stamp: a soft felt thunk, not the old bare 150Hz square. A
   * lowpass-filtered noise burst gives the felt texture; a quiet ~90Hz sine
   * tap underneath gives it weight. Both layers decay to silence well inside
   * 140ms, and both sit noticeably quieter than the game's other UI sounds —
   * this one presses, it doesn't announce.
   */
  private synthesizeStamp(): void {
    const ctx = this.audioContext;
    if (!ctx) return;
    const now = ctx.currentTime;
    this.playNoiseLayer({ startTime: now, duration: 0.14, peakGain: 0.05, lowpassHz: 600 });
    this.playToneLayer({ frequency: 90, type: 'sine', startTime: now, duration: 0.12, peakGain: 0.05 });
  }

  /**
   * Gate lock: two muted low thuds, replacing the old error sawtooth/buzz.
   * Each thud pitch-bends slightly downward, like a tooth settling shut
   * rather than an alarm going off.
   */
  private synthesizeGateLock(): void {
    const ctx = this.audioContext;
    if (!ctx) return;
    const now = ctx.currentTime;
    const thud = { frequency: 70, endFrequency: 54, type: 'sine' as const, duration: 0.09, peakGain: 0.08 };
    this.playToneLayer({ ...thud, startTime: now });
    this.playToneLayer({ ...thud, startTime: now + 0.09 });
  }

  /**
   * Gate clear: a soft two-note confirmation (E4 then A4) for a released
   * verdict, gently lowpassed and quiet so it reads as relief, not a fanfare.
   */
  private synthesizeGateClear(): void {
    const ctx = this.audioContext;
    if (!ctx) return;
    const now = ctx.currentTime;
    this.playToneLayer({
      frequency: 329.63,
      type: 'sine',
      startTime: now,
      duration: 0.06,
      peakGain: 0.06,
      lowpassHz: 1800,
    });
    this.playToneLayer({
      frequency: 440,
      type: 'sine',
      startTime: now + 0.06,
      duration: 0.06,
      peakGain: 0.06,
      lowpassHz: 1800,
    });
  }
}
