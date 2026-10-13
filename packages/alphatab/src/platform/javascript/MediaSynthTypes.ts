import type { IEventEmitterOfT } from '@coderline/alphatab/EventEmitter';
import type { BackingTrackSyncPoint, IAlphaSynth } from '@coderline/alphatab/synth/IAlphaSynth';
import type { IMediaSampleOutput } from '@coderline/alphatab/synth/MediaSampleOutput';

/**
 * "At context frame `frame` the AudioWorklet outputs media time `mediaTime`" (spec §5).
 * @target web
 * @internal
 */
export class MediaTimestampEventArgs {
    public readonly frame: number;
    public readonly mediaTime: number;

    public constructor(frame: number, mediaTime: number) {
        this.frame = frame;
        this.mediaTime = mediaTime;
    }
}

/**
 * The synthesizer's web output while it follows a media clock (implemented by AlphaSynthAudioWorkletOutput).
 * @target web
 * @internal
 */
export interface IMediaFollowingOutput extends IMediaSampleOutput {
    readonly mediaTimestamp: IEventEmitterOfT<MediaTimestampEventArgs>;
    /**
     * The context frame at which the count-in ends: from its first buffered chunk on, refined about every 50 ms.
     */
    readonly countInEnd: IEventEmitterOfT<number>;
    readonly workletFailed: IEventEmitterOfT<Error>;
    readonly workletNode: AudioNode | null;
    /**
     * Keep the worklet between plays: pause holds it silently, play resumes it (spike finding F7).
     */
    keepAlive: boolean;
    /**
     * Where the worklet's output goes; the context's destination when null.
     */
    destinationNode: AudioNode | null;
    /**
     * Creates the worklet now, held silent until the first play.
     */
    warmUp(): void;
}

/**
 * A synthesizer that can follow a media clock (implemented by AlphaSynthWebWorkerApi).
 * @target web
 * @internal
 */
export interface IMediaSynth extends IAlphaSynth {
    followMedia(enabled: boolean, mediaDuration: number, syncPoints: BackingTrackSyncPoint[]): void;
    seekToMediaTime(mediaTime: number): void;
    setRateCorrection(factor: number): void;
    /**
     * Fired when a count-in starts while following, with its length in milliseconds of real time.
     */
    readonly countInStarted: IEventEmitterOfT<number>;
    /**
     * Fired when the synthesizer's worker failed (for example its script could not be loaded).
     */
    readonly workerFailed: IEventEmitterOfT<Error>;
}

/**
 * The audio graph that mixes the media and the synthesizer (implemented by WebAudioMixGraph).
 * @target web
 * @internal
 */
export interface IMediaMixGraph {
    masterGain: number;
    mediaGain: number;
    synthGain: number;
    /**
     * AudioContext.currentTime, in seconds.
     */
    readonly currentTime: number;
    readonly sampleRate: number;
    readonly baseLatencyMs: number;
    readonly isRunning: boolean;
    /**
     * Runs the action once the AudioContext runs (now, if it does).
     */
    whenRunning(action: () => void): void;
    /**
     * For the sync lab's diagnostics only.
     */
    readonly context: AudioContext | null;
    readonly mediaSourceNode: AudioNode | null;
    readonly masterGainNode: GainNode | null;
}

/**
 * Time and timers for the combined player (real: BrowserMediaTimer; tests: a fake).
 * @target web
 * @internal
 */
export interface IMediaTimer {
    /**
     * Milliseconds, monotonic.
     */
    now(): number;
    setTimeout(action: () => void, ms: number): number;
    clearTimeout(id: number): void;
    /**
     * Busy-waits until `done()` or `maxMs` passed (the last few ms of the count-in hand-off, gap G-5).
     */
    spinUntil(done: () => boolean, maxMs: number): void;
}

/**
 * Measures the media's time-stretch latency at a speed (spec §6.4).
 * @target web
 * @internal
 */
export interface IMediaLatencyProbe {
    measure(speed: number): Promise<number>;
}

/**
 * @target web
 * @internal
 */
export class BrowserMediaTimer implements IMediaTimer {
    public now(): number {
        return performance.now();
    }

    public setTimeout(action: () => void, ms: number): number {
        return window.setTimeout(action, ms);
    }

    public clearTimeout(id: number): void {
        window.clearTimeout(id);
    }

    public spinUntil(done: () => boolean, maxMs: number): void {
        const until = performance.now() + maxMs;
        while (!done() && performance.now() < until) {
            // busy-wait on purpose: spike 6 measured the count-in hand-off this way (0.2–4.8 ms late)
        }
    }
}
