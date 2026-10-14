import {
    EventEmitter,
    EventEmitterOfT,
    type IEventEmitter,
    type IEventEmitterOfT
} from '@coderline/alphatab/EventEmitter';
import { Logger } from '@coderline/alphatab/Logger';
import type { LogLevel } from '@coderline/alphatab/LogLevel';
import type { MidiEventType } from '@coderline/alphatab/midi/MidiEvent';
import type { MidiFile } from '@coderline/alphatab/midi/MidiFile';
import { ModelUtils } from '@coderline/alphatab/model/ModelUtils';
import type { Score } from '@coderline/alphatab/model/Score';
import type { ExternalMediaClock, IMediaClock } from '@coderline/alphatab/platform/javascript/MediaClock';
import { MediaLatencyProbe } from '@coderline/alphatab/platform/javascript/MediaLatencyProbe';
import {
    MediaSyncConstants,
    MediaSyncController,
    MediaSyncLearnedValues,
    type MediaStartPlan,
    type MediaSyncStats
} from '@coderline/alphatab/platform/javascript/MediaSyncController';
import { MediaSynthOutput } from '@coderline/alphatab/platform/javascript/MediaSynthOutput';
import type {
    IMediaFollowingOutput,
    IMediaLatencyProbe,
    IMediaMixGraph,
    IMediaSynth,
    IMediaTimer
} from '@coderline/alphatab/platform/javascript/MediaSynthTypes';
import { PerSpeedValues } from '@coderline/alphatab/platform/javascript/PerSpeedValues';
import type { BackingTrackPlayer, IBackingTrackSynthOutput } from '@coderline/alphatab/synth/BackingTrackPlayer';
import type { BackingTrackSyncPoint, IAlphaSynth } from '@coderline/alphatab/synth/IAlphaSynth';
import type { ISynthOutput } from '@coderline/alphatab/synth/ISynthOutput';
import type { MidiEventsPlayedEventArgs } from '@coderline/alphatab/synth/MidiEventsPlayedEventArgs';
import type { PlaybackRange } from '@coderline/alphatab/synth/PlaybackRange';
import { PlaybackRangeChangedEventArgs } from '@coderline/alphatab/synth/PlaybackRangeChangedEventArgs';
import { PlayerState } from '@coderline/alphatab/synth/PlayerState';
import { PlayerStateChangedEventArgs } from '@coderline/alphatab/synth/PlayerStateChangedEventArgs';
import type { PositionChangedEventArgs } from '@coderline/alphatab/synth/PositionChangedEventArgs';
import { SynthConstants } from '@coderline/alphatab/synth/SynthConstants';

/**
 * The parts a combined player is built from (BrowserUiFacade builds the real ones; tests build fakes).
 * @target web
 * @internal
 */
export class MediaSynthPlayerParts {
    /**
     * A BackingTrackPlayer, or an ExternalMediaPlayer.
     */
    public media!: BackingTrackPlayer;
    public synth!: IMediaSynth;
    public synthOutput!: IMediaFollowingOutput;
    public graph!: IMediaMixGraph;
    public clock!: IMediaClock;
    /**
     * External media only: the same object as `clock`.
     */
    public externalClock: ExternalMediaClock | null = null;
    public timer!: IMediaTimer;
    /**
     * Backing track only.
     */
    public probe: IMediaLatencyProbe | null = null;
    /**
     * The probe's values (MediaLatencyProbe.cache in the browser); the backing-track clock reads them too.
     */
    public probeLatencies: PerSpeedValues = new PerSpeedValues();
    /**
     * Whether settings.player.soundFont is set.
     */
    public hasSoundFont: boolean = true;
    /**
     * The learned start values (MediaSyncLearnedValues.backingTrack or .externalMedia in the browser).
     */
    public learned: MediaSyncLearnedValues = new MediaSyncLearnedValues();
}

/**
 * @target web
 * @internal
 */
export class MediaSynthCountInRecord {
    public readonly speed: number;
    /** How late the media's play() was issued against its planned time, ms. */
    public readonly lateMs: number;

    public constructor(speed: number, lateMs: number) {
        this.speed = speed;
        this.lateMs = lateMs;
    }
}

/**
 * @target web
 * @internal
 */
export class MediaSynthProbeRecord {
    public readonly speed: number;
    public readonly latencyMs: number;
    public readonly time: number;

    public constructor(speed: number, latencyMs: number, time: number) {
        this.speed = speed;
        this.latencyMs = latencyMs;
        this.time = time;
    }
}

/**
 * The sync lab's view into the combined player (spec §3). Not public API.
 * @target web
 * @internal
 */
export class MediaSynthDiagnostics {
    public readonly wraps: number[] = [];
    public readonly countIns: MediaSynthCountInRecord[] = [];
    public readonly probes: MediaSynthProbeRecord[] = [];
    private readonly _parts: MediaSynthPlayerParts;
    private readonly _controller: MediaSyncController;

    public constructor(parts: MediaSynthPlayerParts, controller: MediaSyncController) {
        this._parts = parts;
        this._controller = controller;
    }

    public get audioContext(): AudioContext | null {
        return this._parts.graph.context;
    }

    public get mediaSourceNode(): AudioNode | null {
        return this._parts.graph.mediaSourceNode;
    }

    public get synthNode(): AudioNode | null {
        return this._parts.synthOutput.workletNode;
    }

    public get masterGainNode(): GainNode | null {
        return this._parts.graph.masterGainNode;
    }

    public get stats(): MediaSyncStats {
        return this._controller.stats;
    }

    public get startLeads(): Record<string, number> {
        return this._controller.startLeads.toRecord();
    }

    public get mediaStartLatencies(): Record<string, number> {
        return this._controller.mediaStartLatencies.toRecord();
    }

    public get probeLatencies(): Record<string, number> {
        return this._parts.probeLatencies.toRecord();
    }

    /**
     * The drift log grows with every reading: only on while the lab measures.
     */
    public enableDriftLog(enabled: boolean): void {
        this._controller.stats.driftLog = enabled ? [] : null;
    }

    public forgetStartLead(speed: number): void {
        this._controller.startLeads.delete(speed);
    }

    public forgetProbeLatency(speed: number): void {
        this._parts.probeLatencies.delete(speed);
    }

    /**
     * Measures a speed now without caching it (the lab's 0.25× and 2×).
     */
    public measureLatency(speed: number): Promise<number> {
        const probe = this._parts.probe;
        return probe ? probe.measure(speed) : Promise.resolve(0);
    }
}

/**
 * One count-in hand-off in flight.
 * @target web
 * @internal
 */
class CountInHandOff {
    public readonly target: number;
    /** The speed of the Play: the synthesizer measures the count-in's length at it. */
    public readonly startSpeed: number;
    public speed: number;
    public preRoll: number;
    /** The count-in's length at speed 1 (ms); 0 until the synthesizer reports it. */
    public lengthAt1x: number = 0;
    /** The context frame of the count-in's end; -1 until the worklet reports it. */
    public endFrame: number = -1;
    /** The context time (s) for the media's play(); -1 until the count-in end is known. */
    public playAt: number = -1;
    public handOffTimer: number = 0;
    public limitTimer: number = 0;
    /** The speed changed during the count-in: the hand-off doesn't learn the media-start latency. */
    public speedChanged: boolean = false;

    public constructor(target: number, speed: number, preRoll: number) {
        this.target = target;
        this.startSpeed = speed;
        this.speed = speed;
        this.preRoll = preRoll;
    }
}

/**
 * One IAlphaSynth over a media player (the clock) and the worker synthesizer that follows it (spec §6.1).
 * It owns the transport state and the loop wrap; MediaSyncController keeps the two together.
 * @target web
 * @internal
 */
export class MediaSynthPlayer implements IAlphaSynth {
    private static readonly _soundFontFailure: string = 'the SoundFont failed to load';

    public readonly controller: MediaSyncController;
    public readonly diagnostics: MediaSynthDiagnostics;

    private readonly _media: BackingTrackPlayer;
    private readonly _synth: IMediaSynth;
    private readonly _synthOutput: IMediaFollowingOutput;
    private readonly _graph: IMediaMixGraph;
    private readonly _clock: IMediaClock;
    private readonly _externalClock: ExternalMediaClock | null;
    private readonly _timer: IMediaTimer;
    private readonly _probe: IMediaLatencyProbe | null;
    private readonly _probeLatencies: PerSpeedValues;
    private readonly _output: MediaSynthOutput;
    private readonly _unsubscribe: (() => void)[] = [];

    private _state: PlayerState = PlayerState.Paused;
    private _midiLoaded: boolean = false;
    private _hasSoundFont: boolean;
    private _synthReadyForPlayback: boolean = false;
    private _warmedUp: boolean = false;
    private _synthFailure: string = '';
    private _readyFired: boolean = false;
    private _destroyed: boolean = false;

    private _masterVolume: number = 1;
    private _backingTrackVolume: number = 1;
    private _synthVolume: number = 1;
    private _countInVolume: number = 0;
    private _playbackRange: PlaybackRange | null = null;
    private _isLooping: boolean = false;
    private _syncPoints: BackingTrackSyncPoint[] = [];

    private _handshake: number = 0;
    private _holdBefore: number = -1;
    /**
     * Where the start in flight was made for (media ms): from its begin until the first playback position, while the
     * cursor hold is set. -1 when no start is in flight.
     */
    private _startTarget: number = -1;
    private _mediaDelayTimer: number = 0;
    private _countIn: CountInHandOff | null = null;
    private _mediaStartCheckTimer: number = 0;
    private _wrapTimer: number = 0;
    /**
     * External media: the synthesizer is silent until the media's clock has a fit again (after a seek, a wrap, a stall
     * or a start inside the media's own player), and then starts at the media's position.
     */
    private _awaitingSynthStart: boolean = false;
    /** External media: the synthesizer was silenced for a stall (F-17); the next update that moves ends it. */
    private _stalled: boolean = false;
    /** External media: fit the clock anew from the next update that moves (after a start, a stall or a jump). */
    private _refitOnMove: boolean = false;

    private _probeQueue: number[] = [];
    private _probing: boolean = false;
    private _waitingForContext: boolean = false;

    public constructor(parts: MediaSynthPlayerParts) {
        this._media = parts.media;
        this._synth = parts.synth;
        this._synthOutput = parts.synthOutput;
        this._graph = parts.graph;
        this._clock = parts.clock;
        this._externalClock = parts.externalClock;
        this._timer = parts.timer;
        this._probe = parts.probe;
        this._probeLatencies = parts.probeLatencies;
        this._hasSoundFont = parts.hasSoundFont;
        if (!this._hasSoundFont) {
            // §6.1: the media plays alone, with a warning, until api.loadSoundFont() brings one
            Logger.warning('Player', 'No player.soundFont is set; playing the media only until a SoundFont is loaded');
        }
        this.controller = new MediaSyncController(this._synth, this._clock, this._timer, parts.learned);
        this.controller.baseLatencyMs = this._graph.baseLatencyMs;
        this.diagnostics = new MediaSynthDiagnostics(parts, this.controller);
        this._output = new MediaSynthOutput(this._media.output as IBackingTrackSynthOutput, this._synth.output);

        this.ready = new EventEmitter(() => this.isReady);
        this.readyForPlayback = new EventEmitter(() => this.isReadyForPlayback);
        this.midiLoaded = new EventEmitterOfT<PositionChangedEventArgs>(() => this._media.loadedMidiInfo ?? null);
        this.stateChanged = new EventEmitterOfT<PlayerStateChangedEventArgs>(
            () => new PlayerStateChangedEventArgs(this._state, false)
        );
        this.positionChanged = new EventEmitterOfT<PositionChangedEventArgs>(() => this._media.currentPosition);
        this.playbackRangeChanged = new EventEmitterOfT<PlaybackRangeChangedEventArgs>(() =>
            this._playbackRange ? new PlaybackRangeChangedEventArgs(this._playbackRange) : null
        );

        // the inner players run without a range, looping, count-in or volumes of their own (§6.1)
        this._media.isLooping = false;
        this._media.countInVolume = 0;
        this._synth.isLooping = false;
        this._synth.countInVolume = 0;
        this._synth.masterVolume = 1;

        const media = this._media;
        const synth = this._synth;
        const subscribe = (unsubscribe: () => void) => this._unsubscribe.push(unsubscribe);
        subscribe(media.positionChanged.on(e => this._onMediaPosition(e)));
        subscribe(media.finished.on(() => this._onMediaFinished()));
        subscribe(media.midiLoaded.on(e => (this.midiLoaded as EventEmitterOfT<PositionChangedEventArgs>).trigger(e)));
        subscribe(media.midiLoadFailed.on(e => (this.midiLoadFailed as EventEmitterOfT<Error>).trigger(e)));
        subscribe(media.ready.on(() => this._checkReady()));
        subscribe(media.readyForPlayback.on(() => this._checkReadyForPlayback()));
        subscribe((media.output as IBackingTrackSynthOutput).timeUpdate.on(t => this._onMediaTimeUpdate(t)));
        const externalClock = this._externalClock;
        if (externalClock) {
            // after a seek the media reports its old position for a moment (spike 9): those updates stop here, before
            // the media player's cursor and end check
            this._output.skipPosition = position => externalClock.isFromBeforeJump(position);
        }
        subscribe(synth.ready.on(() => this._checkReady()));
        subscribe(synth.readyForPlayback.on(() => this._onSynthReadyForPlayback()));
        subscribe(
            synth.midiEventsPlayed.on(e =>
                (this.midiEventsPlayed as EventEmitterOfT<MidiEventsPlayedEventArgs>).trigger(e)
            )
        );
        subscribe(synth.soundFontLoaded.on(() => (this.soundFontLoaded as EventEmitter).trigger()));
        // the synth's own failure and a failed download (raised on this instance, F-8) both arrive here
        subscribe(synth.soundFontLoadFailed.on(e => (this.soundFontLoadFailed as EventEmitterOfT<Error>).trigger(e)));
        subscribe(
            this.soundFontLoadFailed.on(e =>
                this._fallBackToMediaOnly(`${MediaSynthPlayer._soundFontFailure}: ${e.message}`)
            )
        );
        subscribe(synth.workerFailed.on(e => this._fallBackToMediaOnly(e.message)));
        subscribe(this._synthOutput.workletFailed.on(e => this._fallBackToMediaOnly(e.message)));
        subscribe(this._synthOutput.mediaTimestamp.on(e => this.controller.onStamp(e.frame, e.mediaTime)));
        subscribe(this._synthOutput.countInEnd.on(frame => this._onCountInEnd(frame)));
        subscribe(synth.countInStarted.on(lengthMs => this._onCountInStarted(lengthMs)));
        this._applyVolumes();
    }

    // ---- readiness and the media-only fallback (§6.1) ----

    public get isReady(): boolean {
        return this._media.isReady && (this._synth.isReady || this._synthFailure !== '');
    }

    public get isReadyForPlayback(): boolean {
        return this._media.isReadyForPlayback && (this._synthReadyForPlayback || this._isMediaOnly);
    }

    /**
     * The synthesizer can't play now: it failed, or there is no SoundFont yet.
     */
    private get _isMediaOnly(): boolean {
        return this._synthFailure !== '' || !this._hasSoundFont;
    }

    /**
     * The worker or the worklet failed, and nothing later undoes that. A SoundFont failure is different: a SoundFont
     * loaded later ends that fallback.
     */
    private get _synthLost(): boolean {
        return this._synthFailure !== '' && !this._synthFailure.startsWith(MediaSynthPlayer._soundFontFailure);
    }

    private _checkReady(): void {
        if (!this._readyFired && this.isReady) {
            this._readyFired = true;
            (this.ready as EventEmitter).trigger();
        }
    }

    private _checkReadyForPlayback(): void {
        if (this.isReadyForPlayback) {
            (this.readyForPlayback as EventEmitter).trigger();
        }
    }

    private _onSynthReadyForPlayback(): void {
        if (this._synthLost) {
            // a worker that still answers after its error does not bring the synthesizer back
            return;
        }
        if (this._synthReadyForPlayback && !this._isMediaOnly) {
            // already ready for this song: the worker's API raises readyForPlayback twice per song from the second
            // one on (on midiLoaded and on readyForPlayback, it never clears its flag), the combined player fires once.
            // (In the fallback the raise that brings the synthesizer back passes.)
            return;
        }
        this._synthReadyForPlayback = true;
        // a SoundFont loaded later (api.loadSoundFont(), FYI-4) ends the fallback
        this._hasSoundFont = true;
        if (this._synthFailure.startsWith(MediaSynthPlayer._soundFontFailure)) {
            this._synthFailure = '';
        }
        if (!this._warmedUp) {
            // build the worklet before the first Play, measure the media latency in the background (§6.1, §6.4);
            // once: a later song or SoundFont, or a synthesizer that comes back, neither warms up nor probes again
            this._warmedUp = true;
            this._synthOutput.keepAlive = true;
            this._synthOutput.warmUp();
            this._startBackgroundProbe();
        }
        this._checkReadyForPlayback();
    }

    private _fallBackToMediaOnly(reason: string): void {
        if (this._synthLost || (this._synthFailure !== '' && reason.startsWith(MediaSynthPlayer._soundFontFailure))) {
            // the media plays alone already, for a reason that stays or of the same kind: a second event changes
            // nothing. (A worker or worklet failure on top of a SoundFont failure is recorded, so that a SoundFont
            // loaded later does not end the fallback.)
            return;
        }
        const wasReady = this.isReadyForPlayback;
        this._synthFailure = reason;
        Logger.warning('Player', `The synthesizer can't play along the media; playing the media only: ${reason}`);
        if (this._state === PlayerState.Playing) {
            // the media keeps playing alone
            this.controller.stopped();
            this._synth.pause();
            if (this._countIn) {
                // the count-in was the synthesizer's alone and the media waits, paused, at its pre-roll start: nothing
                // else would start it. It plays alone now, and R-2 applies to this play() too
                this._cancelCountIn();
                this._playMedia();
                this._watchMediaStart(MediaSyncConstants.MediaStartCheckMs);
                this._scheduleWrap(0);
            }
        }
        this._checkReady();
        if (!wasReady) {
            // readyForPlayback fires once per song: not again when the media was ready for this one already
            this._checkReadyForPlayback();
        }
    }

    // ---- volumes (§6.1, §7) ----

    public get masterVolume(): number {
        return this._masterVolume;
    }

    public set masterVolume(value: number) {
        this._masterVolume = Math.max(value, SynthConstants.MinVolume);
        this._applyVolumes();
    }

    public get backingTrackVolume(): number {
        return this._backingTrackVolume;
    }

    public set backingTrackVolume(value: number) {
        this._backingTrackVolume = Math.max(value, SynthConstants.MinVolume);
        this._applyVolumes();
    }

    public get synthVolume(): number {
        return this._synthVolume;
    }

    public set synthVolume(value: number) {
        this._synthVolume = Math.max(value, SynthConstants.MinVolume);
        this._applyVolumes();
    }

    private _applyVolumes(): void {
        const graph = this._graph;
        graph.masterGain = this._masterVolume;
        graph.synthGain = this._synthVolume;
        if (this._externalClock) {
            // the external player isn't in the graph: its handler gets masterVolume alone, as today (§7)
            this._media.masterVolume = this._masterVolume;
            graph.mediaGain = 1;
        } else {
            // the <audio> stays at full volume; the gains mix
            this._media.masterVolume = 1;
            this._media.backingTrackVolume = 1;
            graph.mediaGain = this._backingTrackVolume;
        }
    }

    // ---- the latency probe's schedule (§6.4) ----

    private _startBackgroundProbe(): void {
        for (const speed of MediaLatencyProbe.backgroundSpeeds) {
            this._queueProbe(speed, false);
        }
        this._probeNext();
    }

    private _queueProbe(speed: number, first: boolean): void {
        if (!this._probe || this._probeLatencies.has(speed)) {
            return;
        }
        const key = PerSpeedValues.key(speed);
        const index = this._probeQueue.indexOf(key);
        if (index >= 0) {
            this._probeQueue.splice(index, 1);
        }
        if (first) {
            this._probeQueue.unshift(key);
        } else {
            this._probeQueue.push(key);
        }
    }

    private _probeNext(): void {
        const probe = this._probe;
        if (!probe || this._probing || this._destroyed || this._probeQueue.length === 0) {
            return;
        }
        if (!this._graph.isRunning) {
            // the probe waits until the AudioContext runs (§13)
            if (!this._waitingForContext) {
                this._waitingForContext = true;
                this._graph.whenRunning(() => {
                    this._waitingForContext = false;
                    this._probeNext();
                });
            }
            return;
        }
        const speed = this._probeQueue.shift()!;
        if (this._probeLatencies.has(speed)) {
            this._probeNext();
            return;
        }
        this._probing = true;
        probe.measure(speed).then(
            latency => this._onProbed(speed, latency),
            e => this._onProbeFailed(speed, e)
        );
    }

    /**
     * A refused, timed-out or silent (no beeps heard) measurement is not a measured 0: the speed stays unmeasured
     * (the guess applies) and is measured again on its next use, a Play or a speed change (§6.4).
     */
    private _onProbeFailed(speed: number, e: unknown): void {
        this._probing = false;
        if (this._destroyed) {
            return;
        }
        Logger.warning(
            'Player',
            `Measuring the media latency at ${speed}x failed; measuring it again on its next use: ${e}`
        );
        this._probeNext();
    }

    private _onProbed(speed: number, latency: number): void {
        this._probing = false;
        if (this._destroyed) {
            return;
        }
        this._probeLatencies.set(speed, latency);
        this.diagnostics.probes.push(new MediaSynthProbeRecord(speed, latency, this._timer.now()));
        if (this._state === PlayerState.Playing && PerSpeedValues.key(this.playbackSpeed) === speed) {
            // a measured value replaced the guess mid-playback: settle, no forced re-sync (F-9a, D-1)
            this.controller.latencyChanged();
        }
        this._probeNext();
    }

    // ---- transport ----

    public get state(): PlayerState {
        return this._state;
    }

    public play(): boolean {
        if (this._state !== PlayerState.Paused || !this._media.isReadyForPlayback) {
            return false;
        }
        this._setState(PlayerState.Playing, false);
        // an app Play from Paused is the only start that counts in (§6.1)
        this._startPlayback(true);
        return true;
    }

    public pause(): void {
        if (this._state === PlayerState.Paused) {
            return;
        }
        this._interrupt();
        this._setState(PlayerState.Paused, false);
    }

    public playPause(): void {
        if (this._state !== PlayerState.Paused) {
            this.pause();
        } else {
            this.play();
        }
    }

    public stop(): void {
        if (!this._midiLoaded) {
            return;
        }
        this._interrupt();
        this._media.stop();
        this._synth.stop();
        if (this._playbackRange) {
            // back to the range start, as today
            this._media.tickPosition = this._playbackRange.startTick;
        }
        this._noteMovedPausedMedia();
        this._setState(PlayerState.Paused, true);
    }

    public get timePosition(): number {
        return this._media.timePosition;
    }

    public set timePosition(value: number) {
        this._seek(() => {
            this._media.timePosition = value;
        });
    }

    public get tickPosition(): number {
        return this._media.tickPosition;
    }

    public set tickPosition(value: number) {
        this._seek(() => {
            this._media.tickPosition = value;
        });
    }

    public get playbackSpeed(): number {
        return this._media.playbackSpeed;
    }

    public set playbackSpeed(value: number) {
        if (value === this.playbackSpeed) {
            // a second handshake would seek the media again and re-sync, cutting the synth's sounding notes
            return;
        }
        if (this._holdBefore >= 0) {
            // the cursor hold is kept in the units of the speed it was set at (a slower speed doubles them): convert it
            // before the media reports its position at the new speed, so that report is held against the new units too
            this._holdBefore =
                (this._holdBefore * this.playbackSpeed) /
                ModelUtils.clamp(value, SynthConstants.MinPlaybackSpeed, SynthConstants.MaxPlaybackSpeed);
        }
        this._media.playbackSpeed = value;
        const speed = this._media.playbackSpeed;
        this._synth.playbackSpeed = speed;
        this._clock.speed = speed;
        this._queueProbe(speed, true);
        this._probeNext();
        if (this._state === PlayerState.Playing && this._isMixing && !this._countIn) {
            if (this._startTarget >= 0 && !this.controller.isActive) {
                // the start still waits for the media's seek and is planned at the old speed: it starts again, so the
                // plan, the controller's speed and the start lead it learns are the new speed's
                this._startPlayback(false);
            } else {
                // the fitted line is at the old rate
                this._externalClock?.restartFit();
                // both at the new speed with its latency: re-sync and settle (§6.2; spike 11)
                this.controller.speedChanged(speed);
            }
        }
        if (this._countIn) {
            this._retimeCountIn(this._countIn, speed);
        }
        if (this._state === PlayerState.Playing) {
            this._scheduleWrap(0);
        }
    }

    public get playbackRange(): PlaybackRange | null {
        return this._playbackRange;
    }

    public set playbackRange(value: PlaybackRange | null) {
        this._playbackRange = value;
        if (value) {
            // seeks to the range start, as AlphaSynthBase does
            this.tickPosition = value.startTick;
        }
        (this.playbackRangeChanged as EventEmitterOfT<PlaybackRangeChangedEventArgs>).trigger(
            new PlaybackRangeChangedEventArgs(value)
        );
        this._scheduleWrap(0);
    }

    public get isLooping(): boolean {
        return this._isLooping;
    }

    public set isLooping(value: boolean) {
        this._isLooping = value;
        this._scheduleWrap(0);
    }

    public playOneTimeMidiFile(midi: MidiFile): void {
        if (!this._isMixing) {
            // no synthesizer can play it: pause (the app sees Paused, as below) and drop it. The media player would
            // pause itself, seek its <audio> to the song's start and play it there, none of it visible to the app
            this.pause();
            return;
        }
        // pause both (the app sees Paused); the synth leaves follow mode and plays it on its own clock; the next
        // Play follows the media again through the start handshake (§6.1, spike 7)
        this.pause();
        this._synth.followMedia(false, this._mediaDuration, this._syncPoints);
        this._synth.playOneTimeMidiFile(midi);
    }

    private _setState(state: PlayerState, stopped: boolean): void {
        this._state = state;
        (this.stateChanged as EventEmitterOfT<PlayerStateChangedEventArgs>).trigger(
            new PlayerStateChangedEventArgs(state, stopped)
        );
    }

    /**
     * Starts from the media's position (§6.2 start handshake).
     */
    private _startPlayback(countIn: boolean): void {
        this._supersedeStart();
        const speed = this.playbackSpeed;
        this._queueProbe(speed, true);
        this._probeNext();
        if (!this._isMixing) {
            this._playMedia();
            this._scheduleWrap(0);
            return;
        }
        const external = this._externalClock;
        if (external && external.movedSincePause()) {
            // F-6: play was pressed inside the media's own player and it already moves:
            // no count-in, no learning; the synth starts where the media is
            this._playMedia();
            this._awaitingSynthStart = true;
            this._startSynthWhenTheMediaRuns();
            return;
        }
        this._sendFollowConfig();
        // external media: alphaTab may have moved the paused media since its last update (a Stop, the song's end), so
        // start from alphaTab's own position; inside a lead-in (before bar 1) only the media's updates know where it is
        const target =
            external && this._media.timePosition >= 0 ? this._media.mediaTimeOfPosition : this._clock.position;
        if (countIn && this._countInVolume > 0) {
            this._startCountIn(target, speed);
            return;
        }
        this._runStart(this.controller.planStart(target, speed, this._mediaLatency(speed)), true);
    }

    /**
     * A new start supersedes an earlier one that is still in flight: play() reports Playing before it starts, so a
     * seek in the app's handler starts playback first, and a speed change restarts a start that waits for the media's
     * seek. What the earlier start has pending is dropped, the media it may have started stops, and the media goes
     * back to the position that start was made for, not where its pre-roll left it. (The new start pauses the
     * synthesizer itself.)
     */
    private _supersedeStart(): void {
        const target = this._startTarget;
        this._dropStartInFlight();
        if (target < 0) {
            return;
        }
        this.controller.stopped();
        this._pauseMedia();
        if (this._clock.position !== target) {
            this._media.seekMediaTo(target);
        }
    }

    private _runStart(plan: MediaStartPlan, learnStartLead: boolean): void {
        // the cursor stays at the start position while the media pre-rolls
        this._holdBefore = this._media.timePosition;
        this._startTarget = plan.target;
        // ends a one-time MIDI the synth may still play (spike 7)
        this._synth.pause();
        if (plan.mediaSeekTo !== this._clock.position) {
            this._media.seekMediaTo(plan.mediaSeekTo);
        }
        const handshake = this._handshake;
        this._clock.whenSeeked(() => {
            if (handshake !== this._handshake) {
                // a pause or another handshake came first
                return;
            }
            if (!this._isMixing) {
                // the synthesizer failed while the media seeked: the media starts alone, without waiting for it
                this._playMedia();
                this._scheduleWrap(0);
                return;
            }
            this._synth.seekToMediaTime(plan.synthSeekTo);
            this._synth.play();
            if (plan.mediaDelayMs > 0) {
                this._mediaDelayTimer = this._timer.setTimeout(() => {
                    this._mediaDelayTimer = 0;
                    this._playMedia();
                }, plan.mediaDelayMs);
            } else {
                this._playMedia();
            }
            this.controller.started(plan, learnStartLead);
            this._scheduleWrap(plan.mediaDelayMs);
            // R-2: away from 1x (after the pre-roll seek) or after the media delay, the media's play() runs after the
            // Play call returned; check that the media runs, as after a count-in
            this._watchMediaStart(
                plan.mediaDelayMs +
                    this.controller.mediaStartLatencies.get(plan.speed) +
                    MediaSyncConstants.MediaStartCheckMs
            );
        });
    }

    private _startCountIn(target: number, speed: number): void {
        // the media can't wait below its time 0: near it the pre-roll shrinks (the hand-off time uses this value)
        const preRoll = Math.min(MediaSyncController.preRoll(speed, true), Math.max(0, target));
        // the cursor stays at the start position meanwhile
        this._holdBefore = this._media.timePosition;
        this._startTarget = target;
        this._synth.pause();
        if (preRoll > 0) {
            // the media waits, paused, at its pre-roll start
            this._media.seekMediaTo(target - preRoll);
        }
        this._countIn = new CountInHandOff(target, speed, preRoll);
        this._synth.seekToMediaTime(target);
        this._synth.countInVolume = this._countInVolume;
        this._synth.play();
        // later starts in this playback (a seek, a wrap) never count in
        this._synth.countInVolume = 0;
    }

    private _onCountInStarted(lengthMs: number): void {
        const countIn = this._countIn;
        if (!countIn || countIn.limitTimer !== 0) {
            return;
        }
        countIn.lengthAt1x = lengthMs * countIn.startSpeed;
        countIn.limitTimer = this._timer.setTimeout(
            () => this._onCountInTimeLimit(countIn),
            // (a speed change can come before this message)
            Math.max(lengthMs, countIn.lengthAt1x / countIn.speed) + MediaSyncConstants.CountInTimeLimitExtraMs
        );
    }

    private _onCountInEnd(frame: number): void {
        const countIn = this._countIn;
        if (!countIn) {
            return;
        }
        countIn.endFrame = frame;
        // the end came: the time limit is only for an end that never comes (§6.2); the hand-off timer below runs
        // even when the audio started late
        this._timer.clearTimeout(countIn.limitTimer);
        countIn.limitTimer = 0;
        countIn.playAt = this.controller.handOffPlayTime(frame, this._graph.sampleRate, countIn.speed, countIn.preRoll);
        // every report plans the hand-off again: the first comes about a bar ahead, and a speed change or an
        // underrun moves the end after it
        this._timer.clearTimeout(countIn.handOffTimer);
        const waitMs = (countIn.playAt - this._graph.currentTime) * 1000 - MediaSyncConstants.HandOffEarlyMs;
        countIn.handOffTimer = this._timer.setTimeout(() => this._handOff(countIn), Math.max(0, waitMs));
    }

    private _handOff(countIn: CountInHandOff): void {
        if (this._countIn !== countIn) {
            return;
        }
        // the last ms on the audio clock (G-5; spike 6: play() 0.2–4.8 ms after its time)
        this._timer.spinUntil(() => this._graph.currentTime >= countIn.playAt, MediaSyncConstants.HandOffSpinMaxMs);
        this._countIn = null;
        this._timer.clearTimeout(countIn.limitTimer);
        this.diagnostics.countIns.push(
            new MediaSynthCountInRecord(countIn.speed, (this._graph.currentTime - countIn.playAt) * 1000)
        );
        this._playMedia();
        // a speed change during the count-in: nothing to learn from this start
        this.controller.startedAfterHandOff(countIn.speed, !countIn.speedChanged);
        this._watchMediaStart(
            this.controller.mediaStartLatencies.get(countIn.speed) + MediaSyncConstants.MediaStartCheckMs
        );
        this._scheduleWrap(0);
    }

    private _onCountInTimeLimit(countIn: CountInHandOff): void {
        if (this._countIn !== countIn) {
            return;
        }
        // the hand-off never came: start the media anyway and play it alone (§6.2)
        this._countIn = null;
        this._timer.clearTimeout(countIn.handOffTimer);
        this._fallBackToMediaOnly('the count-in hand-off never came');
        this._playMedia();
        // R-2: this play() runs long after the gesture too
        this._watchMediaStart(
            this.controller.mediaStartLatencies.get(countIn.speed) + MediaSyncConstants.MediaStartCheckMs
        );
        this._scheduleWrap(0);
    }

    /**
     * A speed change during the count-in (Review Focus 2): the media waits at the new speed's pre-roll start, the
     * time limit allows for slower clicks, and a known count-in end gets the media's play() planned again.
     */
    private _retimeCountIn(countIn: CountInHandOff, speed: number): void {
        const slower = speed < countIn.speed;
        countIn.speed = speed;
        // as at the start, the media can't wait below its time 0
        countIn.preRoll = Math.min(MediaSyncController.preRoll(speed, true), Math.max(0, countIn.target));
        countIn.speedChanged = true;
        this._media.seekMediaTo(countIn.target - countIn.preRoll);
        if (slower && countIn.limitTimer !== 0) {
            // at most the whole bar at the new speed is still to come
            this._timer.clearTimeout(countIn.limitTimer);
            countIn.limitTimer = this._timer.setTimeout(
                () => this._onCountInTimeLimit(countIn),
                countIn.lengthAt1x / speed + MediaSyncConstants.CountInTimeLimitExtraMs
            );
        }
        if (countIn.endFrame >= 0) {
            this._timer.clearTimeout(countIn.handOffTimer);
            countIn.handOffTimer = 0;
            this._onCountInEnd(countIn.endFrame);
        }
    }

    private _cancelCountIn(): void {
        const countIn = this._countIn;
        if (countIn) {
            this._timer.clearTimeout(countIn.handOffTimer);
            this._timer.clearTimeout(countIn.limitTimer);
            this._countIn = null;
        }
    }

    /**
     * After a delayed media start: check that the media runs.
     */
    private _watchMediaStart(delayMs: number): void {
        this._timer.clearTimeout(this._mediaStartCheckTimer);
        this._mediaStartCheckTimer = this._timer.setTimeout(() => {
            this._mediaStartCheckTimer = 0;
            if (
                this._state !== PlayerState.Playing ||
                !Number.isNaN(this._clock.mediaTimeNow()) ||
                // (a jump external media has not shown yet is no reason to wait: the synth is silent until it moves)
                (this._clock.isSeeking && !this._externalClock)
            ) {
                return;
            }
            if (this._externalClock) {
                // the video buffers: the synth restarts at the media's position once it moves (§6.2)
                this._silenceUntilTheMediaMoves();
                return;
            }
            // R-2: the browser refused the media's play(); decision D-7 picks the real fallback
            Logger.warning('Player', 'The media did not start; pausing (the browser may have refused its play())');
            this.pause();
        }, delayMs);
    }

    private _seek(apply: () => void): void {
        if (this._state !== PlayerState.Playing) {
            apply();
            this._noteMovedPausedMedia();
            return;
        }
        if (this._externalClock && !this._countIn) {
            // external media can't be held: it jumps while playing, the synth waits for it (§6.2)
            this._timer.clearTimeout(this._wrapTimer);
            this._wrapTimer = 0;
            // the jump ends a start's pre-roll: the cursor follows from the new position, not held at the old start
            this._holdBefore = -1;
            this._startTarget = -1;
            apply();
            this._jumpExternal(this._media.mediaTimeOfPosition);
            return;
        }
        // pause both, seek, restart through the start handshake: no count-in, no stateChanged (§6.2)
        this._interrupt();
        apply();
        this._startPlayback(false);
    }

    /**
     * Stops whatever a handshake has in flight; both end paused.
     */
    private _interrupt(): void {
        this._dropStartInFlight();
        this.controller.stopped();
        this._pauseMedia();
        this._synth.pause();
    }

    /**
     * Drops what a start has in flight: its wait for the media's seek, its media delay and start check, its count-in
     * and the cursor hold, the loop wrap's timer (every start schedules its own) and, for external media, the
     * synthesizer's wait for the media.
     */
    private _dropStartInFlight(): void {
        this._handshake++;
        this._timer.clearTimeout(this._mediaDelayTimer);
        this._mediaDelayTimer = 0;
        this._timer.clearTimeout(this._mediaStartCheckTimer);
        this._mediaStartCheckTimer = 0;
        this._timer.clearTimeout(this._wrapTimer);
        this._wrapTimer = 0;
        this._cancelCountIn();
        this._holdBefore = -1;
        this._startTarget = -1;
        this._awaitingSynthStart = false;
        this._stalled = false;
        this._refitOnMove = false;
    }

    /**
     * Both play: the synthesizer is ready and nothing failed.
     */
    private get _isMixing(): boolean {
        return !this._isMediaOnly && this._synthReadyForPlayback;
    }

    private _mediaLatency(speed: number): number {
        return this._externalClock ? 0 : this._probeLatencies.get(speed);
    }

    private _playMedia(): void {
        this._externalClock?.setPlaying(true);
        // external media: the paused position and the updates while the media starts would bend the first fit: fit
        // from where it moves, as after a stall
        this._refitOnMove = true;
        this._media.play();
    }

    private _pauseMedia(): void {
        this._externalClock?.setPlaying(false);
        this._media.pause();
    }

    private get _mediaDuration(): number {
        return (this._media.output as IBackingTrackSynthOutput).backingTrackDuration;
    }

    private _sendFollowConfig(): void {
        this._synth.followMedia(true, this._mediaDuration, this._syncPoints);
    }

    private _onMediaPosition(e: PositionChangedEventArgs): void {
        if (this._holdBefore >= 0) {
            if (e.currentTime < this._holdBefore - 1) {
                // the media's pre-roll: keep the cursor at the start position (§6.1)
                return;
            }
            if (!e.isSeek) {
                // only playback releases the hold: the pre-roll's own seek report (clamped at the song's start before
                // a lead-in) would release it ahead of the negative positions the pre-roll then reports
                this._holdBefore = -1;
                this._startTarget = -1;
            }
        }
        (this.positionChanged as EventEmitterOfT<PositionChangedEventArgs>).trigger(e);
        if (this._wrapTimer !== 0 && !e.isSeek) {
            const range = this._playbackRange;
            const endTick = range ? range.endTick : this._media.loadedMidiInfo!.endTick;
            if (e.currentTick >= endTick) {
                // the media passed the wrap point before the timer fired (a busy main thread): wrap now, before the
                // media player's own end check stops both at the song's end
                this._timer.clearTimeout(this._wrapTimer);
                this._wrapTimer = 0;
                this._wrap();
            }
        }
    }

    private _onMediaFinished(): void {
        // the media reached the song's end by itself (no range, not looping): finished, and both stop, as today
        (this.finished as EventEmitter).trigger();
        if (this._destroyed) {
            // the handler destroyed the player: nothing stops, and no state change fires into it
            return;
        }
        if (this._state === PlayerState.Playing) {
            this._interrupt();
            this._synth.stop();
            this._setState(PlayerState.Paused, true);
        }
    }

    /**
     * The media time of the end to wrap or stop at, or -1 when the media's own end handles it (no range, no loop).
     */
    private _wrapEnd(): number {
        const range = this._playbackRange;
        if (range) {
            return this._media.tickToMediaTime(range.endTick);
        }
        const info = this._media.loadedMidiInfo;
        if (this._isLooping && info) {
            return this._media.tickToMediaTime(info.endTick);
        }
        return -1;
    }

    private _scheduleWrap(extraDelayMs: number): void {
        this._timer.clearTimeout(this._wrapTimer);
        this._wrapTimer = 0;
        if (this._state !== PlayerState.Playing || this._countIn || this._awaitingSynthStart) {
            // (external media that has not shown its jump yet: the position the clock has is from before it, and the
            // synth's restart plans the wrap from the media's new position)
            return;
        }
        const end = this._wrapEnd();
        if (end < 0) {
            return;
        }
        // G-3 (spike 4): a little before the end
        const untilEndMs = (end - MediaSyncConstants.LoopWrapLeadMs - this._heardMediaPosition()) / this.playbackSpeed;
        this._wrapTimer = this._timer.setTimeout(() => this._onWrapTimer(), Math.max(0, untilEndMs) + extraDelayMs);
    }

    private _onWrapTimer(): void {
        this._wrapTimer = 0;
        const end = this._wrapEnd();
        if (this._state !== PlayerState.Playing || end < 0) {
            return;
        }
        const remainingMs = (end - MediaSyncConstants.LoopWrapLeadMs - this._heardMediaPosition()) / this.playbackSpeed;
        if (remainingMs > 5) {
            // the timer fired early or the media started late: wait for the media
            this._wrapTimer = this._timer.setTimeout(() => this._onWrapTimer(), remainingMs);
            return;
        }
        this._wrap();
    }

    /**
     * Where the wrap timer measures from (media ms): the media's reported position, plus its latency at this speed
     * when the media is heard ahead of that position (below 1×, spec §6.3; as the start plan applies it), so the
     * wrap comes before the heard range end. Above 1× (a negative latency) it stays where spike 4 measured it.
     */
    private _heardMediaPosition(): number {
        const speed = this.playbackSpeed;
        return this._clock.position + Math.max(0, this._mediaLatency(speed)) * speed;
    }

    /**
     * The range end (the song's end when looping without a range): finished, then the wrap or the stop (§6.2). Whether
     * it wraps or stops is decided before the app's finished handler runs, as the synthesizer alone does: a handler
     * that clears isLooping ("loop N times") still gets this last pass, and one that sets it at a range end that does
     * not loop still stops. What the handler did to the player wins: a destroyed player gets nothing more, and a paused
     * or stopped one is moved back to the range start but not restarted.
     */
    private _wrap(): void {
        const looping = this._isLooping;
        (this.finished as EventEmitter).trigger();
        if (this._destroyed) {
            // the handler destroyed the player: nothing restarts, and no state change fires into it
            return;
        }
        if (!looping) {
            // back to the range start, stateChanged(Paused, stopped), as today
            this.stop();
            return;
        }
        const range = this._playbackRange;
        if (this._externalClock) {
            // F-5: external media wraps without pausing: seek it; the synth waits until its clock has a fit again
            // without a range the song's start: bar 1's media time, as the backing-track wrap and today's player go
            const start = this._media.tickToMediaTime(range ? range.startTick : 0);
            this._media.seekMediaTo(start);
            if (this._state === PlayerState.Playing) {
                this.diagnostics.wraps.push(this._timer.now());
                this._jumpExternal(start);
            } else {
                this._noteMovedPausedMedia();
            }
            return;
        }
        // pause both, seek both to the range start, restart through the start handshake (§6.2):
        // no count-in, no stateChanged
        this._interrupt();
        if (range) {
            this._media.tickPosition = range.startTick;
        } else {
            this._media.timePosition = 0;
        }
        if (this._state === PlayerState.Playing) {
            this.diagnostics.wraps.push(this._timer.now());
            this._startPlayback(false);
        }
    }

    // ---- external media (§6.2): the media can't be held, so the synthesizer waits for it ----

    private _onMediaTimeUpdate(position: number): void {
        const clock = this._externalClock;
        if (!clock) {
            return;
        }
        if (
            (this._awaitingSynthStart || Number.isNaN(clock.mediaTimeNow())) &&
            !clock.isSeeking &&
            position === clock.position
        ) {
            // the media holds (after a jump, or at a start before its clock has a time): fit from where it moves
            this._refitOnMove = true;
        }
        if (this._refitOnMove && position !== clock.position) {
            // the media moves (again): fit from here; a fit across a stall re-syncs twice (spike 9 §4)
            this._refitOnMove = false;
            this._stalled = false;
            clock.restartFit();
        }
        if (!this._graph.isRunning) {
            // the heard time stands still until the context renders: these updates would share one stamp and bend the
            // fit once it runs, so only the latest one is kept
            clock.restartFit();
        }
        clock.addSample(position);
        if (this._mediaStartCheckTimer !== 0 && !Number.isNaN(clock.mediaTimeNow())) {
            // the media runs: its start needs no more checking
            this._timer.clearTimeout(this._mediaStartCheckTimer);
            this._mediaStartCheckTimer = 0;
        }
        if (this._state !== PlayerState.Playing || this._countIn) {
            return;
        }
        if (!this._isMixing) {
            if (this._awaitingSynthStart && !clock.isSeeking) {
                // media only: no synthesizer to restart after a jump; plan the next wrap from the media's new position
                this._awaitingSynthStart = false;
                this._scheduleWrap(0);
            }
            return;
        }
        if (!this._stalled && !this._awaitingSynthStart && clock.isStalled) {
            // F-17: the media stalls (buffering): silence the synth until it moves again
            this._stalled = true;
            this._silenceUntilTheMediaMoves();
            return;
        }
        this._startSynthWhenTheMediaRuns();
    }

    private _startSynthWhenTheMediaRuns(): void {
        if (!this._awaitingSynthStart || this._stalled || Number.isNaN(this._clock.mediaTimeNow())) {
            return;
        }
        this._awaitingSynthStart = false;
        // started by the media, or after an external seek, wrap or stall: no count-in, no learning; the synth starts
        // where the media is and the settling re-sync locks it (§6.2)
        this._sendFollowConfig();
        this.controller.startedAfterHandOff(this.playbackSpeed, false);
        this._synth.pause();
        this.controller.resync();
        this._synth.play();
        this._scheduleWrap(0);
    }

    /**
     * alphaTab moved the paused media (a Stop, a seek, a wrap that the app's handler paused). That position is where
     * the next start begins, not a start of the media's own, and the updates that still show the old position (the
     * media applies the seek a moment late) stay out of the media player and the clock: otherwise they would move
     * alphaTab back, or, inside the clock's pause-settle window, read as the media's own start at the next Play.
     */
    private _noteMovedPausedMedia(): void {
        const clock = this._externalClock;
        if (clock) {
            const position = this._media.mediaTimeOfPosition;
            clock.notePausedPosition(position);
            clock.expectJumpTo(position);
        }
    }

    private _jumpExternal(target: number): void {
        // an app's handler may have re-armed the wrap during the jump (its finished or positionChanged) from the
        // position before it; the synth's restart arms it again from the media's new position
        this._timer.clearTimeout(this._wrapTimer);
        this._wrapTimer = 0;
        this.controller.stopped();
        this._synth.pause();
        this._externalClock!.expectJumpTo(target);
        this._awaitingSynthStart = true;
    }

    private _silenceUntilTheMediaMoves(): void {
        this.controller.stopped();
        this._synth.pause();
        this._awaitingSynthStart = true;
        this._refitOnMove = true;
    }

    // ---- delegation ----

    public get output(): ISynthOutput {
        return this._output;
    }

    public get logLevel(): LogLevel {
        return this._synth.logLevel;
    }

    public set logLevel(value: LogLevel) {
        this._media.logLevel = value;
        this._synth.logLevel = value;
    }

    public get metronomeVolume(): number {
        return this._synth.metronomeVolume;
    }

    public set metronomeVolume(value: number) {
        this._synth.metronomeVolume = value;
    }

    public get countInVolume(): number {
        return this._countInVolume;
    }

    public set countInVolume(value: number) {
        // applied by the combined player itself: only an app Play from Paused counts in (§6.1)
        this._countInVolume = Math.max(value, SynthConstants.MinVolume);
    }

    public get midiEventsPlayedFilter(): MidiEventType[] {
        return this._synth.midiEventsPlayedFilter;
    }

    public set midiEventsPlayedFilter(value: MidiEventType[]) {
        this._synth.midiEventsPlayedFilter = value;
    }

    public get loadedMidiInfo(): PositionChangedEventArgs | undefined {
        return this._media.loadedMidiInfo;
    }

    public get currentPosition(): PositionChangedEventArgs {
        return this._media.currentPosition;
    }

    public destroy(): void {
        this._destroyed = true;
        this._interrupt();
        for (const unsubscribe of this._unsubscribe) {
            unsubscribe();
        }
        this._unsubscribe.length = 0;
        this._media.destroy();
        this._synth.destroy();
    }

    public loadSoundFont(data: Uint8Array, append: boolean): void {
        if (this._state === PlayerState.Playing) {
            // loading a SoundFont pauses the synthesizer, and the app of a synth-only player sees Paused (it presses Play
            // again once the SoundFont is loaded): pause both here, so the synthesizer is not left silent under Playing
            this.pause();
        }
        if (!this._isMediaOnly) {
            // ready again when the worker says so, once per SoundFont: the app re-sends the channel volumes on it
            this._synthReadyForPlayback = false;
        }
        this._synth.loadSoundFont(data, append);
    }

    public resetSoundFonts(): void {
        this.stop();
        this._synth.resetSoundFonts();
    }

    public loadMidiFile(midi: MidiFile): void {
        this.stop();
        this._midiLoaded = true;
        if (!this._isMediaOnly) {
            // the synthesizer is ready for this song when its worker says so; the media is ready at once. The combined
            // player fires readyForPlayback once per song, after the synthesizer has it (in the fallback it follows
            // the media).
            this._synthReadyForPlayback = false;
        }
        this._media.loadMidiFile(midi);
        this._synth.loadMidiFile(midi);
    }

    public loadBackingTrack(score: Score): void {
        this._media.loadBackingTrack(score);
    }

    public updateSyncPoints(syncPoints: BackingTrackSyncPoint[]): void {
        this._syncPoints = syncPoints;
        this._media.updateSyncPoints(syncPoints);
        // loading a MIDI file drops the worker's sync points: send them again
        this._sendFollowConfig();
    }

    public applyTranspositionPitches(transpositionPitches: Map<number, number>): void {
        this._synth.applyTranspositionPitches(transpositionPitches);
    }

    public setChannelTranspositionPitch(channel: number, semitones: number): void {
        this._synth.setChannelTranspositionPitch(channel, semitones);
    }

    public setChannelMute(channel: number, mute: boolean): void {
        this._synth.setChannelMute(channel, mute);
    }

    public resetChannelStates(): void {
        this._synth.resetChannelStates();
    }

    public setChannelSolo(channel: number, solo: boolean): void {
        this._synth.setChannelSolo(channel, solo);
    }

    public setChannelVolume(channel: number, volume: number): void {
        this._synth.setChannelVolume(channel, volume);
    }

    public readonly ready: IEventEmitter;
    public readonly readyForPlayback: IEventEmitter;
    public readonly finished: IEventEmitter = new EventEmitter();
    public readonly soundFontLoaded: IEventEmitter = new EventEmitter();
    public readonly soundFontLoadFailed: IEventEmitterOfT<Error> = new EventEmitterOfT<Error>();
    public readonly midiLoaded: IEventEmitterOfT<PositionChangedEventArgs>;
    public readonly midiLoadFailed: IEventEmitterOfT<Error> = new EventEmitterOfT<Error>();
    public readonly stateChanged: IEventEmitterOfT<PlayerStateChangedEventArgs>;
    public readonly positionChanged: IEventEmitterOfT<PositionChangedEventArgs>;
    public readonly midiEventsPlayed: IEventEmitterOfT<MidiEventsPlayedEventArgs> =
        new EventEmitterOfT<MidiEventsPlayedEventArgs>();
    public readonly playbackRangeChanged: IEventEmitterOfT<PlaybackRangeChangedEventArgs>;
}
