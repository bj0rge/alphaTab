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
import type { Score } from '@coderline/alphatab/model/Score';
import type { ExternalMediaClock, IMediaClock } from '@coderline/alphatab/platform/javascript/MediaClock';
import { MediaLatencyProbe } from '@coderline/alphatab/platform/javascript/MediaLatencyProbe';
import {
    MediaSyncController,
    MediaSyncLearnedValues,
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
        this._synthReadyForPlayback = true;
        // a SoundFont loaded later (api.loadSoundFont(), FYI-4) ends the fallback
        this._hasSoundFont = true;
        if (this._synthFailure.startsWith(MediaSynthPlayer._soundFontFailure)) {
            this._synthFailure = '';
        }
        if (this._synthFailure === '') {
            // build the worklet before the first Play, measure the media latency in the background (§6.1, §6.4)
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
        this._startPlayback();
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
        this._media.playbackSpeed = value;
        const speed = this._media.playbackSpeed;
        this._synth.playbackSpeed = speed;
        this._clock.speed = speed;
        this._queueProbe(speed, true);
        this._probeNext();
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
    }

    public get isLooping(): boolean {
        return this._isLooping;
    }

    public set isLooping(value: boolean) {
        this._isLooping = value;
    }

    public playOneTimeMidiFile(midi: MidiFile): void {
        this._media.playOneTimeMidiFile(midi);
    }

    private _setState(state: PlayerState, stopped: boolean): void {
        this._state = state;
        (this.stateChanged as EventEmitterOfT<PlayerStateChangedEventArgs>).trigger(
            new PlayerStateChangedEventArgs(state, stopped)
        );
    }

    private _startPlayback(): void {
        const speed = this.playbackSpeed;
        this._queueProbe(speed, true);
        this._probeNext();
        this._playMedia();
    }

    private _seek(apply: () => void): void {
        apply();
    }

    /**
     * Stops whatever is in flight; both end paused.
     */
    private _interrupt(): void {
        this.controller.stopped();
        this._pauseMedia();
        this._synth.pause();
    }

    private _playMedia(): void {
        this._externalClock?.setPlaying(true);
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
        (this.positionChanged as EventEmitterOfT<PositionChangedEventArgs>).trigger(e);
    }

    private _onMediaFinished(): void {
        (this.finished as EventEmitter).trigger();
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
            // the synthesizer is ready for this song when its worker says so; the media is ready at once. Players
            // fire readyForPlayback once per song, after the song is loaded (in the fallback it follows the media).
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
