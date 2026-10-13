import { PerSpeedValues } from '@coderline/alphatab/platform/javascript/PerSpeedValues';

/**
 * The sync rules' values (spec §6.2) and the spike values the spec doesn't list (gaps G-2 to G-5).
 * @target web
 * @internal
 */
export class MediaSyncConstants {
    /** Act only on two consecutive readings that agree within this (their mean is used). */
    public static readonly AgreementMs: number = 3;
    public static readonly SettleDurationMs: number = 1500;
    /** At 1×: above two of Chrome's 5.3 ms <audio> start steps. F-3 raises it with the base latency. */
    public static readonly SettleResyncThresholdAt1xMs: number = 12;
    /** At other speeds: the time-stretch jitter. */
    public static readonly SettleResyncThresholdMs: number = 15;
    public static readonly LockedResyncThresholdMs: number = 120;
    public static readonly NudgeGainMs: number = 3000;
    /** While settling at 1×: small offsets are closed by a faster nudge, not a re-sync (spike 4). */
    public static readonly SettleNudgeGainAt1xMs: number = 300;
    public static readonly NudgeMaxCorrection: number = 0.02;
    public static readonly NudgeEmaFactor: number = 0.3;
    public static readonly MinCorrectionChange: number = 0.0002;
    public static readonly ResyncLeadInitialMs: number = 10;
    public static readonly ResyncLeadMaxMs: number = 100;
    /** G-2: stamps rendered before a re-sync can still arrive; ignore them for this long. */
    public static readonly IgnoreAfterResyncMs: number = 200;
    /** G-4: the clamps of the learned values. */
    public static readonly StartLeadMinMs: number = -50;
    public static readonly StartLeadMaxMs: number = 150;
    public static readonly MediaStartLatencyMinMs: number = -50;
    public static readonly MediaStartLatencyMaxMs: number = 250;
    /**
     * After the first start at a speed, a learned start value moves only when two starts in a row imply values within
     * this of each other (to their mean): one late media start (a YouTube start that buffers) teaches nothing.
     */
    public static readonly StartAgreementMs: number = 10;
    /** At speeds other than 1× both start this much media time before the target (spikes 4 and 6). */
    public static readonly PreRollMs: number = 60;
    /** F-14 (decision D-3): the count-in's media pre-roll below 1× (spike 6). */
    public static readonly CountInPreRollBelow1xMs: number = 120;
    /** The media starts anyway when the count-in's end hasn't come by its length plus this (§6.2). */
    public static readonly CountInTimeLimitExtraMs: number = 250;
    /** G-5: the hand-off timer fires this early, then waits on the audio clock for at most HandOffSpinMaxMs. */
    public static readonly HandOffEarlyMs: number = 12;
    public static readonly HandOffSpinMaxMs: number = 30;
    /** G-3: the loop-wrap timer fires this much media time before the range end. */
    public static readonly LoopWrapLeadMs: number = 15;
    /** R-2 safety net: after its play() the media must run within this. */
    public static readonly MediaStartCheckMs: number = 500;
}

/**
 * What the controller tells the synthesizer.
 * @target web
 * @internal
 */
export interface IMediaSyncSynth {
    seekToMediaTime(mediaTime: number): void;
    setRateCorrection(factor: number): void;
}

/**
 * The media clock as the controller reads it (spec §6.3).
 * @target web
 * @internal
 */
export interface IMediaSyncClock {
    /**
     * The media time (ms) heard at the given context frame, or NaN while the media gives no reliable time
     * (paused, seeking, stalled).
     */
    mediaTimeAt(frame: number): number;
    /**
     * The media time (ms) heard now, or NaN (as above).
     */
    mediaTimeNow(): number;
}

/**
 * @target web
 * @internal
 */
export interface IMediaSyncTime {
    /**
     * Milliseconds, monotonic.
     */
    now(): number;
}

/**
 * One reading, for the sync lab.
 * @target web
 * @internal
 */
export class MediaSyncDriftEntry {
    public readonly time: number;
    public readonly drift: number;
    public readonly correction: number;
    public readonly action: string;

    public constructor(time: number, drift: number, correction: number, action: string) {
        this.time = time;
        this.drift = drift;
        this.correction = correction;
        this.action = action;
    }
}

/**
 * @target web
 * @internal
 */
export class MediaSyncStats {
    public readonly resyncTimes: number[] = [];
    /**
     * Off (null) unless the sync lab turns it on: it grows with every reading.
     */
    public driftLog: MediaSyncDriftEntry[] | null = null;
    public resyncLeadMs: number = MediaSyncConstants.ResyncLeadInitialMs;
}

/**
 * The start values the controller learns, per speed (spec §6.2). The browser keeps one set per media kind for the
 * page session (in memory only, like MediaLatencyProbe.cache), so a player that alphaTab recreates (a playerMode
 * change, or EnabledAutomatic between a file with a recording and one without) starts with what the page learned.
 * @target web
 * @internal
 */
export class MediaSyncLearnedValues {
    public static readonly backingTrack: MediaSyncLearnedValues = new MediaSyncLearnedValues();
    public static readonly externalMedia: MediaSyncLearnedValues = new MediaSyncLearnedValues();
    public readonly startLeads: PerSpeedValues = new PerSpeedValues();
    public readonly mediaStartLatencies: PerSpeedValues = new PerSpeedValues();
    /** What the last start at each speed implied for them (two starts in a row must agree). */
    public readonly lastStartLeads: PerSpeedValues = new PerSpeedValues();
    public readonly lastMediaStartLatencies: PerSpeedValues = new PerSpeedValues();
}

/**
 * Keeps the synthesizer on the media's clock (spec §6.2): compares the worklet's stamps with the media clock,
 * nudges the synthesizer's rate, re-syncs above a threshold, learns the start values, and plans the handshakes.
 * Pure logic.
 * @target web
 * @internal
 */
export class MediaSyncController {
    public readonly startLeads: PerSpeedValues;
    public readonly mediaStartLatencies: PerSpeedValues;
    public readonly stats: MediaSyncStats = new MediaSyncStats();

    /**
     * The AudioContext's base latency in ms; the settle threshold at 1× grows with it (F-3).
     */
    public baseLatencyMs: number = 0;

    private readonly _synth: IMediaSyncSynth;
    private readonly _clock: IMediaSyncClock;
    private readonly _time: IMediaSyncTime;
    private readonly _learned: MediaSyncLearnedValues;
    private _speed: number = 1;
    private _active: boolean = false;
    private _window: number[] = [];
    private _ema: number = Number.NaN;
    private _correction: number = 1;
    private _resyncLead: number = MediaSyncConstants.ResyncLeadInitialMs;
    private _settleUntil: number = 0;
    private _ignoreUntil: number = 0;
    private _resyncPending: boolean = false;
    private _learnResyncLead: boolean = false;
    private _learnMediaStartLatency: boolean = false;

    /**
     * @param learned Where the learned start values live: the browser passes the page session's set for the media
     * kind, so a recreated player starts with them.
     */
    public constructor(
        synth: IMediaSyncSynth,
        clock: IMediaSyncClock,
        time: IMediaSyncTime,
        learned: MediaSyncLearnedValues = new MediaSyncLearnedValues()
    ) {
        this._synth = synth;
        this._clock = clock;
        this._time = time;
        this._learned = learned;
        this.startLeads = learned.startLeads;
        this.mediaStartLatencies = learned.mediaStartLatencies;
    }

    public get speed(): number {
        return this._speed;
    }

    public get correction(): number {
        return this._correction;
    }

    public get isActive(): boolean {
        return this._active;
    }

    public get isSettling(): boolean {
        return this._time.now() < this._settleUntil;
    }

    /**
     * The re-sync threshold while settling (ms).
     */
    public settleThreshold(speed: number): number {
        if (speed === 1) {
            return Math.max(MediaSyncConstants.SettleResyncThresholdAt1xMs, 2 * this.baseLatencyMs + 1);
        }
        return MediaSyncConstants.SettleResyncThresholdMs;
    }

    /**
     * The media started after a count-in, by itself (external media) or after an external seek: act on the
     * stamps, settling first. With `learnMediaStartLatency` the first agreed reading tunes when the media's
     * play() is issued next time at this speed.
     */
    public startedAfterHandOff(speed: number, learnMediaStartLatency: boolean): void {
        this._begin(speed);
        this._learnMediaStartLatency = learnMediaStartLatency;
    }

    public stopped(): void {
        this._active = false;
        this._clearReadings();
        this._resyncPending = false;
    }

    /**
     * Speed change while playing: re-sync and settle (§6.2).
     */
    public speedChanged(speed: number): void {
        this._speed = speed;
        if (!this._active) {
            return;
        }
        this._settleUntil = this._time.now() + MediaSyncConstants.SettleDurationMs;
        this.resync();
    }

    /**
     * A measured media latency replaced the guess for the current speed while playing (F-9a, decision D-1):
     * settle; the drift rules re-sync only if the agreed drift then exceeds the settle threshold.
     */
    public latencyChanged(): void {
        if (!this._active) {
            return;
        }
        this._settleUntil = this._time.now() + MediaSyncConstants.SettleDurationMs;
        this._clearReadings();
    }

    /**
     * Moves the synthesizer to the media's time now (plus the learned re-sync lead). Waits for the next reading
     * when the media gives no time yet.
     */
    public resync(): void {
        const mediaTime = this._clock.mediaTimeNow();
        if (Number.isNaN(mediaTime)) {
            this._resyncPending = true;
            return;
        }
        this._resyncPending = false;
        this._clearReadings();
        this._synth.seekToMediaTime(mediaTime + this._resyncLead * this._speed);
        const now = this._time.now();
        this._ignoreUntil = now + MediaSyncConstants.IgnoreAfterResyncMs;
        this._learnResyncLead = true;
        this.stats.resyncTimes.push(now);
    }

    /**
     * A worklet stamp: at context frame `frame` the synthesizer outputs media time `synthMediaTime`.
     */
    public onStamp(frame: number, synthMediaTime: number): void {
        if (!this._active) {
            return;
        }
        const now = this._time.now();
        if (now < this._ignoreUntil) {
            return;
        }
        const mediaAtFrame = this._clock.mediaTimeAt(frame);
        if (Number.isNaN(mediaAtFrame)) {
            return;
        }
        if (this._resyncPending) {
            this.resync();
            return;
        }

        const speed = this._speed;
        const drift = synthMediaTime - mediaAtFrame;
        const settling = now < this._settleUntil;
        const window = this._window;
        window.push(drift);
        if (window.length > 3) {
            window.shift();
        }
        const agreed = this._agreed();
        const hasAgreed = !Number.isNaN(agreed);
        let action = '';

        if (this._learnMediaStartLatency && hasAgreed) {
            // the media started agreed/speed ms late (synth ahead): issue its play() that much earlier next time
            this._learnMediaStartLatency = false;
            MediaSyncController._learnFromStart(
                this.mediaStartLatencies,
                this._learned.lastMediaStartLatencies,
                speed,
                this.mediaStartLatencies.get(speed) + agreed / speed,
                MediaSyncConstants.MediaStartLatencyMinMs,
                MediaSyncConstants.MediaStartLatencyMaxMs
            );
        }
        if (this._learnResyncLead && hasAgreed) {
            this._learnResyncLead = false;
            this._resyncLead = MediaSyncController._clamp(
                this._resyncLead - agreed / speed,
                0,
                MediaSyncConstants.ResyncLeadMaxMs
            );
            this.stats.resyncLeadMs = this._resyncLead;
        }

        const threshold = settling ? this.settleThreshold(speed) : MediaSyncConstants.LockedResyncThresholdMs;
        if (hasAgreed && Math.abs(agreed) > threshold) {
            action = 'resync';
            this.resync();
        } else if (!hasAgreed && settling) {
            action = 'wait';
        } else {
            action = this._nudge(drift, settling && speed === 1);
        }
        this.stats.driftLog?.push(new MediaSyncDriftEntry(now, drift, this._correction, action));
    }

    private _begin(speed: number): void {
        this._speed = speed;
        this._active = true;
        this._clearReadings();
        this._resyncPending = false;
        this._learnResyncLead = false;
        this._learnMediaStartLatency = false;
        this._ignoreUntil = 0;
        this._settleUntil = this._time.now() + MediaSyncConstants.SettleDurationMs;
        // followMedia() resets the synthesizer's correction at every start
        this._correction = 1;
    }

    private _clearReadings(): void {
        this._window = [];
        this._ema = Number.NaN;
    }

    private _agreed(): number {
        const window = this._window;
        const n = window.length;
        if (n < 2 || Math.abs(window[n - 1] - window[n - 2]) >= MediaSyncConstants.AgreementMs) {
            return Number.NaN;
        }
        return (window[n - 1] + window[n - 2]) / 2;
    }

    private _nudge(drift: number, fast: boolean): string {
        this._ema = Number.isNaN(this._ema)
            ? drift
            : this._ema + (drift - this._ema) * MediaSyncConstants.NudgeEmaFactor;
        const gain = fast ? MediaSyncConstants.SettleNudgeGainAt1xMs : MediaSyncConstants.NudgeGainMs;
        const max = MediaSyncConstants.NudgeMaxCorrection;
        const correction = 1 - MediaSyncController._clamp(this._ema / gain, -max, max);
        if (Math.abs(correction - this._correction) <= MediaSyncConstants.MinCorrectionChange) {
            return '';
        }
        this._correction = correction;
        this._synth.setRateCorrection(correction);
        return 'nudge';
    }

    /**
     * One start's implied value (the value it used plus its correction) for a learned start value: the first start at
     * a speed sets it; after that it moves only when this start and the one before it agree (§6.2).
     */
    private static _learnFromStart(
        values: PerSpeedValues,
        last: PerSpeedValues,
        speed: number,
        implied: number,
        min: number,
        max: number
    ): void {
        if (!values.has(speed)) {
            values.set(speed, MediaSyncController._clamp(implied, min, max));
        } else if (last.has(speed) && Math.abs(implied - last.get(speed)) <= MediaSyncConstants.StartAgreementMs) {
            values.set(speed, MediaSyncController._clamp((implied + last.get(speed)) / 2, min, max));
        }
        last.set(speed, implied);
    }

    private static _clamp(value: number, min: number, max: number): number {
        return Math.max(min, Math.min(max, value));
    }
}
