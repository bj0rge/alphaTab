import type { IMediaSyncClock } from '@coderline/alphatab/platform/javascript/MediaSyncController';
import type { PerSpeedValues } from '@coderline/alphatab/platform/javascript/PerSpeedValues';

/**
 * A media clock as the combined player uses it (spec §6.3).
 * @target web
 * @internal
 */
export interface IMediaClock extends IMediaSyncClock {
    /**
     * The media's position (ms) as the media reports it: no latency, no offset.
     */
    readonly position: number;
    readonly isSeeking: boolean;
    speed: number;
    /**
     * Runs the action once the media's current seek is done (now when it isn't seeking).
     */
    whenSeeked(action: () => void): void;
}

/**
 * What the backing-track clock reads.
 * @target web
 * @internal
 */
export interface IBackingTrackClockSource {
    /** <audio>.currentTime, s */
    readonly mediaCurrentTime: number;
    readonly mediaPaused: boolean;
    readonly mediaSeeking: boolean;
    /** AudioContext.currentTime, s */
    readonly contextTime: number;
    readonly sampleRate: number;
    onceSeeked(action: () => void): void;
}

/**
 * @target web
 * @internal
 */
export class AudioElementClockSource implements IBackingTrackClockSource {
    private readonly _element: HTMLAudioElement;
    private readonly _context: AudioContext;

    public constructor(element: HTMLAudioElement, context: AudioContext) {
        this._element = element;
        this._context = context;
    }

    public get mediaCurrentTime(): number {
        return this._element.currentTime;
    }
    public get mediaPaused(): boolean {
        return this._element.paused;
    }
    public get mediaSeeking(): boolean {
        return this._element.seeking;
    }
    public get contextTime(): number {
        return this._context.currentTime;
    }
    public get sampleRate(): number {
        return this._context.sampleRate;
    }
    public onceSeeked(action: () => void): void {
        this._element.addEventListener('seeked', () => action(), { once: true });
    }
}

/**
 * The backing track's clock: the routed <audio> and the synthesizer share one AudioContext (spec §6.3).
 * @target web
 * @internal
 */
export class BackingTrackMediaClock implements IMediaClock {
    public speed: number = 1;
    private readonly _source: IBackingTrackClockSource;
    private readonly _latencies: PerSpeedValues;
    private readonly _offsetMs: () => number;

    /**
     * @param latencies The media's time-stretch latency per speed (the probe's values).
     * @param offsetMs mediaSyncOffsetInMilliseconds, read live.
     */
    public constructor(source: IBackingTrackClockSource, latencies: PerSpeedValues, offsetMs: () => number) {
        this._source = source;
        this._latencies = latencies;
        this._offsetMs = offsetMs;
    }

    public get position(): number {
        return this._source.mediaCurrentTime * 1000;
    }

    public get isSeeking(): boolean {
        return this._source.mediaSeeking;
    }

    public whenSeeked(action: () => void): void {
        if (this._source.mediaSeeking) {
            this._source.onceSeeked(action);
        } else {
            action();
        }
    }

    public mediaTimeAt(frame: number): number {
        const source = this._source;
        if (source.mediaPaused || source.mediaSeeking) {
            return Number.NaN;
        }
        const speed = this.speed;
        return (
            source.mediaCurrentTime * 1000 -
            (source.contextTime - frame / source.sampleRate) * 1000 * speed +
            this._latencies.get(speed) * speed -
            // F-11: + = the synthesizer plays later; ms of real time
            this._offsetMs() * speed
        );
    }

    public mediaTimeNow(): number {
        return this.mediaTimeAt(this._source.contextTime * this._source.sampleRate);
    }
}

/**
 * The time axis of the external media clock (implemented by WebAudioMixGraph).
 * @target web
 * @internal
 */
export interface IExternalClockSource {
    /**
     * The AudioContext time (s) of the audio being heard now (getOutputTimestamp; gap G-6).
     */
    heardContextTime(): number;
    readonly sampleRate: number;
}

/**
 * @target web
 * @internal
 */
class ExternalClockSample {
    public readonly time: number;
    public readonly position: number;

    public constructor(time: number, position: number) {
        this.time = time;
        this.position = position;
    }
}

/**
 * The external media's clock (spec §6.3): a robust line through the last ~2 s of updatePosition() calls,
 * stamped with the context time being heard and read at the moment a synthesizer frame is heard. Best-effort.
 * @target web
 * @internal
 */
export class ExternalMediaClock implements IMediaClock {
    public static readonly FitWindowS: number = 2;
    public static readonly MinFitSpanS: number = 0.1;
    /** F-17: the same position this long while playing is a stall. */
    public static readonly StallMs: number = 100;
    /** F-6: an update at most this old that shows the media moved since the pause: the media started itself. */
    public static readonly MovedWithinMs: number = 100;
    public static readonly MovedToleranceMs: number = 5;
    /** The media stops up to one update after the pause: updates this soon after it show where it stopped. */
    public static readonly PauseSettleMs: number = 100;
    /** After a seek, updates further than this from the target still show the old position. */
    public static readonly JumpToleranceMs: number = 500;
    /** A seek the media hasn't shown after this long (one it didn't do) is given up: its updates count again. */
    public static readonly JumpWaitMaxS: number = 1;
    /** The fitted rate must be within this fraction of the speed for the media to count as playing. */
    public static readonly RateTolerance: number = 0.5;

    public speed: number = 1;
    private readonly _source: IExternalClockSource;
    private readonly _offsetMs: () => number;
    private _samples: ExternalClockSample[] = [];
    private _slope: number = 0;
    private _intercept: number = 0;
    private _fitValid: boolean = false;
    private _playing: boolean = false;
    private _lastPosition: number = Number.NaN;
    private _lastChangeAt: number = 0;
    private _lastSampleAt: number = Number.NEGATIVE_INFINITY;
    private _sawMovement: boolean = false;
    private _positionAtPause: number = Number.NaN;
    private _pausedAt: number = Number.NEGATIVE_INFINITY;
    private _jumpTarget: number = Number.NaN;
    private _jumpAt: number = 0;

    public constructor(source: IExternalClockSource, offsetMs: () => number) {
        this._source = source;
        this._offsetMs = offsetMs;
    }

    /**
     * An updatePosition() call: the media's position now (ms).
     */
    public addSample(positionMs: number): void {
        if (this.isFromBeforeJump(positionMs)) {
            return;
        }
        this._jumpTarget = Number.NaN;
        const time = this._source.heardContextTime();
        if (
            !this._playing &&
            (Number.isNaN(this._positionAtPause) || (time - this._pausedAt) * 1000 <= ExternalMediaClock.PauseSettleMs)
        ) {
            // the paused position: the first update, or one right after the pause (where the media stopped)
            this._positionAtPause = positionMs;
        }
        if (positionMs !== this._lastPosition) {
            if (this._playing && !Number.isNaN(this._lastPosition)) {
                this._sawMovement = true;
            }
            this._lastPosition = positionMs;
            this._lastChangeAt = time;
        }
        this._lastSampleAt = time;
        this._samples.push(new ExternalClockSample(time, positionMs));
        while (this._samples.length > 0 && this._samples[0].time < time - ExternalMediaClock.FitWindowS) {
            this._samples.shift();
        }
        this._fit();
    }

    public get position(): number {
        return Number.isNaN(this._lastPosition) ? 0 : this._lastPosition;
    }

    public get isSeeking(): boolean {
        return !Number.isNaN(this._jumpTarget);
    }

    public whenSeeked(action: () => void): void {
        // an external seek can't be awaited here; the clock gives no time until it has a fit again
        action();
    }

    /**
     * Whether the combined player has the media playing.
     */
    public setPlaying(playing: boolean): void {
        if (playing === this._playing) {
            return;
        }
        this._playing = playing;
        this._sawMovement = false;
        if (playing) {
            // fit the playing media only: the updates from while it was paused would bend the line
            this._samples = this._samples.slice(-1);
            this._fit();
        } else {
            this._positionAtPause = this._lastPosition;
            this._pausedAt = this._source.heardContextTime();
        }
    }

    /**
     * alphaTab seeked the paused media: its new position is not a start, and the next start begins there even when
     * the integration reports positions only while the media plays.
     */
    public notePausedPosition(position: number): void {
        this._positionAtPause = position;
        this._lastPosition = position;
        // a jump the media never showed (paused right after a seek) is replaced by this one; the samples from before
        // the seek are from another position
        this._jumpTarget = Number.NaN;
        this.restartFit();
    }

    /**
     * Drops the fitted line (after a stall, a seek or a speed change).
     */
    public restartFit(): void {
        this._samples = [];
        this._fitValid = false;
    }

    /**
     * After a seek to `target`: ignore updates that still show the old position, then fit anew.
     */
    public expectJumpTo(target: number): void {
        this._jumpTarget = target;
        this._jumpAt = this._source.heardContextTime();
        this.restartFit();
    }

    /**
     * Whether an update at `positionMs` still shows the position from before the seek that {@link expectJumpTo}
     * waits for. After {@link JumpWaitMaxS} without the seek showing, the media's own position counts again.
     */
    public isFromBeforeJump(positionMs: number): boolean {
        if (Number.isNaN(this._jumpTarget)) {
            return false;
        }
        if (this._source.heardContextTime() - this._jumpAt > ExternalMediaClock.JumpWaitMaxS) {
            // the media never showed the seek: take its position as it is
            this._jumpTarget = Number.NaN;
            return false;
        }
        return Math.abs(positionMs - this._jumpTarget) > ExternalMediaClock.JumpToleranceMs;
    }

    /**
     * F-17: playing, moved since the start, and the same position for StallMs or longer.
     */
    public get isStalled(): boolean {
        return (
            this._playing &&
            this._sawMovement &&
            (this._lastSampleAt - this._lastChangeAt) * 1000 >= ExternalMediaClock.StallMs
        );
    }

    /**
     * F-6: a recent update shows the media moved since it was last paused (play was pressed inside the media).
     */
    public movedSincePause(): boolean {
        if (Number.isNaN(this._positionAtPause) || Number.isNaN(this._lastPosition)) {
            return false;
        }
        const ageMs = (this._source.heardContextTime() - this._lastSampleAt) * 1000;
        return (
            ageMs <= ExternalMediaClock.MovedWithinMs &&
            Math.abs(this._lastPosition - this._positionAtPause) > ExternalMediaClock.MovedToleranceMs
        );
    }

    public mediaTimeAt(frame: number): number {
        if (!this._playing || !this._fitValid || this.isStalled) {
            return Number.NaN;
        }
        // G-6: frame / sampleRate is the frame's heard context time, the axis the samples are stamped on
        return this._intercept + this._slope * (frame / this._source.sampleRate) - this._offsetMs() * this.speed;
    }

    public mediaTimeNow(): number {
        return this.mediaTimeAt(this._source.heardContextTime() * this._source.sampleRate);
    }

    private _fit(): void {
        const samples = this._samples;
        const n = samples.length;
        this._fitValid = false;
        // (the small margin keeps 3 updates 50 ms apart valid despite float rounding)
        if (n < 3 || samples[n - 1].time - samples[0].time < ExternalMediaClock.MinFitSpanS - 1e-6) {
            return;
        }
        // Theil–Sen: the median of the pairwise slopes; one late update doesn't bend it (spike 9 §4)
        const slopes: number[] = [];
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                const dt = samples[j].time - samples[i].time;
                if (dt > 1e-6) {
                    slopes.push((samples[j].position - samples[i].position) / dt);
                }
            }
        }
        if (slopes.length === 0) {
            return;
        }
        const slope = ExternalMediaClock._median(slopes);
        const expected = 1000 * this.speed;
        if (Math.abs(slope - expected) > expected * ExternalMediaClock.RateTolerance) {
            // not playing (yet), or a stall inside the window
            return;
        }
        this._slope = slope;
        this._intercept = ExternalMediaClock._median(samples.map(s => s.position - slope * s.time));
        this._fitValid = true;
    }

    private static _median(values: number[]): number {
        const sorted = [...values].sort((a, b) => a - b);
        const mid = sorted.length >> 1;
        return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }
}
