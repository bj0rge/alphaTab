/**
 * Fakes for the combined player's parts.
 * @target web
 */
import {
    EventEmitter,
    EventEmitterOfT,
    type IEventEmitter,
    type IEventEmitterOfT
} from '@coderline/alphatab/EventEmitter';
import { ScoreLoader } from '@coderline/alphatab/importer/ScoreLoader';
import { LogLevel } from '@coderline/alphatab/LogLevel';
import { AlphaSynthMidiFileHandler } from '@coderline/alphatab/midi/AlphaSynthMidiFileHandler';
import type { MidiEventType } from '@coderline/alphatab/midi/MidiEvent';
import { MidiFile } from '@coderline/alphatab/midi/MidiFile';
import { MidiFileGenerator } from '@coderline/alphatab/midi/MidiFileGenerator';
import type { Score } from '@coderline/alphatab/model/Score';
import { ExternalMediaClock, type IExternalClockSource, type IMediaClock } from '@coderline/alphatab/platform/javascript/MediaClock';
import {
    MediaTimestampEventArgs,
    type IMediaFollowingOutput,
    type IMediaLatencyProbe,
    type IMediaMixGraph,
    type IMediaSynth,
    type IMediaTimer
} from '@coderline/alphatab/platform/javascript/MediaSynthTypes';
import { MediaSyncLearnedValues } from '@coderline/alphatab/platform/javascript/MediaSyncController';
import { MediaSynthPlayer, MediaSynthPlayerParts } from '@coderline/alphatab/platform/javascript/MediaSynthPlayer';
import { PerSpeedValues } from '@coderline/alphatab/platform/javascript/PerSpeedValues';
import { Settings } from '@coderline/alphatab/Settings';
import { BackingTrackPlayer } from '@coderline/alphatab/synth/BackingTrackPlayer';
import { ExternalMediaPlayer, type IExternalMediaSynthOutput } from '@coderline/alphatab/synth/ExternalMediaPlayer';
import type { BackingTrackSyncPoint } from '@coderline/alphatab/synth/IAlphaSynth';
import type { ISynthOutput } from '@coderline/alphatab/synth/ISynthOutput';
import type { MediaSampleChunk } from '@coderline/alphatab/synth/MediaSampleOutput';
import type { MidiEventsPlayedEventArgs } from '@coderline/alphatab/synth/MidiEventsPlayedEventArgs';
import type { PlaybackRange } from '@coderline/alphatab/synth/PlaybackRange';
import type { PlaybackRangeChangedEventArgs } from '@coderline/alphatab/synth/PlaybackRangeChangedEventArgs';
import { PlayerState } from '@coderline/alphatab/synth/PlayerState';
import type { PlayerStateChangedEventArgs } from '@coderline/alphatab/synth/PlayerStateChangedEventArgs';
import { PositionChangedEventArgs } from '@coderline/alphatab/synth/PositionChangedEventArgs';
import { TestMediaHandler, TestMediaOutput } from 'test/audio/TestMediaOutput';
import { TestOutput } from 'test/audio/TestOutput';
import { TestPlatform } from 'test/TestPlatform';

export const flush = () => new Promise(resolve => setTimeout(resolve, 0));

/**
 * Fake time: timers run when the test advances it.
 */
export class FakeMediaTimer implements IMediaTimer {
    public time: number = 0;
    private _nextId: number = 1;
    private _timers: { id: number; at: number; action: () => void }[] = [];

    public now(): number {
        return this.time;
    }

    public setTimeout(action: () => void, ms: number): number {
        const id = this._nextId++;
        this._timers.push({ id, at: this.time + Math.max(0, ms), action });
        return id;
    }

    public clearTimeout(id: number): void {
        this._timers = this._timers.filter(t => t.id !== id);
    }

    public spinUntil(done: () => boolean, maxMs: number): void {
        const until = this.time + maxMs;
        while (!done() && this.time < until) {
            this.time += 0.1;
        }
    }

    /**
     * Moves time forward, running the timers that come due, in order.
     */
    public advance(ms: number): void {
        const end = this.time + ms;
        for (;;) {
            this._timers.sort((a, b) => a.at - b.at);
            const next = this._timers[0];
            if (!next || next.at > end) {
                break;
            }
            this._timers.shift();
            this.time = Math.max(this.time, next.at);
            next.action();
        }
        this.time = Math.max(this.time, end);
    }

    public get pending(): number {
        return this._timers.length;
    }
}

/**
 * A mixing graph whose clock is the fake timer (context time = timer ms / 1000).
 */
export class FakeMixGraph implements IMediaMixGraph {
    public masterGain: number = 1;
    public mediaGain: number = 1;
    public synthGain: number = 1;
    public sampleRate: number = 48000;
    public baseLatencyMs: number = 0;
    public running: boolean = true;
    /**
     * The fake time (ms) at which the context started to run: the external clock's heard time counts from there.
     */
    public runningSince: number = 0;
    public readonly context: AudioContext | null = null;
    public readonly mediaSourceNode: AudioNode | null = null;
    public readonly masterGainNode: GainNode | null = null;
    private readonly _timer: FakeMediaTimer;
    private _whenRunning: (() => void)[] = [];

    public constructor(timer: FakeMediaTimer) {
        this._timer = timer;
    }

    public get currentTime(): number {
        return this._timer.time / 1000;
    }

    public get isRunning(): boolean {
        return this.running;
    }

    public whenRunning(action: () => void): void {
        if (this.running) {
            action();
        } else {
            this._whenRunning.push(action);
        }
    }

    public start(): void {
        this.running = true;
        this.runningSince = this._timer.time;
        for (const action of this._whenRunning.splice(0)) {
            action();
        }
    }
}

/**
 * The worker synthesizer as the combined player drives it: records the calls.
 */
export class FakeMediaSynth implements IMediaSynth {
    public readonly calls: string[] = [];
    public readonly seeks: number[] = [];
    public readonly corrections: number[] = [];
    public readonly output: ISynthOutput = new TestOutput();
    public isReady: boolean = false;
    public isReadyForPlayback: boolean = false;
    public state: PlayerState = PlayerState.Paused;
    public logLevel: LogLevel = LogLevel.None;
    public masterVolume: number = 1;
    public metronomeVolume: number = 0;
    public playbackSpeed: number = 1;
    public tickPosition: number = 0;
    public timePosition: number = 0;
    public loadedMidiInfo?: PositionChangedEventArgs = undefined;
    public currentPosition: PositionChangedEventArgs = new PositionChangedEventArgs(0, 0, 0, 0, false, 120, 120);
    public playbackRange: PlaybackRange | null = null;
    public isLooping: boolean = false;
    public countInVolume: number = 0;
    public midiEventsPlayedFilter: MidiEventType[] = [];
    public backingTrackVolume: number = 1;
    public synthVolume: number = 1;

    public followMedia(enabled: boolean, _mediaDuration: number, _syncPoints: BackingTrackSyncPoint[]): void {
        this.calls.push(`followMedia:${enabled}`);
    }
    public seekToMediaTime(mediaTime: number): void {
        this.seeks.push(mediaTime);
        this.calls.push(`seek:${mediaTime}`);
    }
    public setRateCorrection(factor: number): void {
        this.corrections.push(factor);
    }
    public destroy(): void {
        this.calls.push('destroy');
    }
    public play(): boolean {
        this.calls.push(`play:countIn=${this.countInVolume}`);
        this.state = PlayerState.Playing;
        return true;
    }
    public pause(): void {
        this.calls.push('pause');
        this.state = PlayerState.Paused;
    }
    public playPause(): void {}
    public stop(): void {
        this.calls.push('stop');
        this.state = PlayerState.Paused;
    }
    public playOneTimeMidiFile(_midi: MidiFile): void {
        this.calls.push('playOneTimeMidiFile');
    }
    public loadSoundFont(_data: Uint8Array, _append: boolean): void {
        this.calls.push('loadSoundFont');
    }
    public resetSoundFonts(): void {}
    public loadMidiFile(_midi: MidiFile): void {
        this.calls.push('loadMidiFile');
        if (this.isReadyForPlayback) {
            // AlphaSynthWebWorkerApi raises readyForPlayback on midiLoaded too, and never clears its flag: from the
            // second song on, a song raises it here and again in becomeReadyForPlayback() (the worker's own message)
            (this.readyForPlayback as EventEmitter).trigger();
        }
    }
    public loadBackingTrack(_score: Score): void {}
    public updateSyncPoints(_syncPoints: BackingTrackSyncPoint[]): void {}
    public applyTranspositionPitches(_transpositionPitches: Map<number, number>): void {}
    public setChannelTranspositionPitch(_channel: number, _semitones: number): void {}
    public setChannelMute(_channel: number, _mute: boolean): void {}
    public resetChannelStates(): void {}
    public setChannelSolo(_channel: number, _solo: boolean): void {}
    public setChannelVolume(_channel: number, _volume: number): void {}

    public readonly ready: IEventEmitter = new EventEmitter();
    public readonly readyForPlayback: IEventEmitter = new EventEmitter();
    public readonly finished: IEventEmitter = new EventEmitter();
    public readonly soundFontLoaded: IEventEmitter = new EventEmitter();
    public readonly soundFontLoadFailed: IEventEmitterOfT<Error> = new EventEmitterOfT<Error>();
    public readonly midiLoaded: IEventEmitterOfT<PositionChangedEventArgs> = new EventEmitterOfT<PositionChangedEventArgs>();
    public readonly midiLoadFailed: IEventEmitterOfT<Error> = new EventEmitterOfT<Error>();
    public readonly stateChanged: IEventEmitterOfT<PlayerStateChangedEventArgs> =
        new EventEmitterOfT<PlayerStateChangedEventArgs>();
    public readonly positionChanged: IEventEmitterOfT<PositionChangedEventArgs> =
        new EventEmitterOfT<PositionChangedEventArgs>();
    public readonly midiEventsPlayed: IEventEmitterOfT<MidiEventsPlayedEventArgs> =
        new EventEmitterOfT<MidiEventsPlayedEventArgs>();
    public readonly playbackRangeChanged: IEventEmitterOfT<PlaybackRangeChangedEventArgs> =
        new EventEmitterOfT<PlaybackRangeChangedEventArgs>();
    public readonly countInStarted: IEventEmitterOfT<number> = new EventEmitterOfT<number>();
    public readonly workerFailed: IEventEmitterOfT<Error> = new EventEmitterOfT<Error>();

    public becomeReady(): void {
        this.isReady = true;
        (this.ready as EventEmitter).trigger();
    }
    /**
     * The worker's own readyForPlayback message.
     */
    public becomeReadyForPlayback(): void {
        this.isReadyForPlayback = true;
        (this.readyForPlayback as EventEmitter).trigger();
    }
    public startCountIn(lengthMs: number): void {
        (this.countInStarted as EventEmitterOfT<number>).trigger(lengthMs);
    }
    public fail(message: string): void {
        (this.workerFailed as EventEmitterOfT<Error>).trigger(new Error(message));
    }
    public count(prefix: string): number {
        return this.calls.filter(c => c.startsWith(prefix)).length;
    }
    public lastSeek(): number {
        return this.seeks[this.seeks.length - 1];
    }
}

/**
 * The worklet output as the combined player sees it.
 */
export class FakeFollowingOutput implements IMediaFollowingOutput {
    public keepAlive: boolean = false;
    public destinationNode: AudioNode | null = null;
    public readonly workletNode: AudioNode | null = null;
    public warmUps: number = 0;
    public readonly mediaTimestamp: IEventEmitterOfT<MediaTimestampEventArgs> =
        new EventEmitterOfT<MediaTimestampEventArgs>();
    public readonly countInEnd: IEventEmitterOfT<number> = new EventEmitterOfT<number>();
    public readonly workletFailed: IEventEmitterOfT<Error> = new EventEmitterOfT<Error>();

    public warmUp(): void {
        this.warmUps++;
    }
    public addMediaSamples(_samples: Float32Array, _chunk: MediaSampleChunk): void {}
    public stamp(frame: number, mediaTime: number): void {
        (this.mediaTimestamp as EventEmitterOfT<MediaTimestampEventArgs>).trigger(
            new MediaTimestampEventArgs(frame, mediaTime)
        );
    }
    public endCountIn(frame: number): void {
        (this.countInEnd as EventEmitterOfT<number>).trigger(frame);
    }
    public fail(message: string): void {
        (this.workletFailed as EventEmitterOfT<Error>).trigger(new Error(message));
    }
}

/**
 * A backing-track clock on a TestMediaOutput: the media time is its position (plus a latency) while it plays.
 */
export class FakeBackingClock implements IMediaClock {
    public speed: number = 1;
    public isSeeking: boolean = false;
    public latencyMs: number = 0;
    private readonly _output: TestMediaOutput;
    private _seeked: (() => void)[] = [];

    public constructor(output: TestMediaOutput) {
        this._output = output;
    }

    public get position(): number {
        return this._output.currentTime;
    }

    public whenSeeked(action: () => void): void {
        if (this.isSeeking) {
            this._seeked.push(action);
        } else {
            action();
        }
    }

    public finishSeek(): void {
        this.isSeeking = false;
        for (const action of this._seeked.splice(0)) {
            action();
        }
    }

    public mediaTimeAt(_frame: number): number {
        return this._output.isPlaying && !this.isSeeking
            ? this._output.currentTime + this.latencyMs * this.speed
            : Number.NaN;
    }

    public mediaTimeNow(): number {
        return this.mediaTimeAt(0);
    }
}

/**
 * A latency probe the test answers.
 */
export class FakeProbe implements IMediaLatencyProbe {
    public readonly requests: number[] = [];
    private _pending: { resolve: (value: number) => void; reject: (error: Error) => void }[] = [];

    public measure(speed: number): Promise<number> {
        this.requests.push(speed);
        return new Promise<number>((resolve, reject) => this._pending.push({ resolve, reject }));
    }
    public resolveNext(value: number): void {
        this._pending.shift()!.resolve(value);
    }
    public rejectNext(error: Error): void {
        this._pending.shift()!.reject(error);
    }
}

/**
 * The heard context time of the external clock, from the fake timer. With a graph, a context that does not run stands
 * still at 0 and counts from the time it starts (a real context renders nothing before the page's first gesture).
 */
export class TimerHeardTime implements IExternalClockSource {
    public readonly sampleRate: number = 48000;
    private readonly _timer: FakeMediaTimer;
    private readonly _graph: FakeMixGraph | null;

    public constructor(timer: FakeMediaTimer, graph: FakeMixGraph | null = null) {
        this._timer = timer;
        this._graph = graph;
    }

    public heardContextTime(): number {
        if (this._graph && !this._graph.running) {
            return 0;
        }
        return (this._timer.time - (this._graph?.runningSince ?? 0)) / 1000;
    }
}

/**
 * A combined player on fakes: a real BackingTrackPlayer (or ExternalMediaPlayer) and fake synth, worklet, graph,
 * timer and probe.
 */
export class MediaSynthHarness {
    public readonly timer: FakeMediaTimer = new FakeMediaTimer();
    public readonly graph: FakeMixGraph;
    public readonly synth: FakeMediaSynth = new FakeMediaSynth();
    public readonly synthOutput: FakeFollowingOutput = new FakeFollowingOutput();
    public readonly probe: FakeProbe = new FakeProbe();
    public readonly probeLatencies: PerSpeedValues = new PerSpeedValues();
    public readonly media: BackingTrackPlayer;
    public readonly mediaOutput: TestMediaOutput | null = null;
    public readonly handler: TestMediaHandler | null = null;
    public readonly backingClock: FakeBackingClock | null = null;
    public readonly externalClock: ExternalMediaClock | null = null;
    public readonly player: MediaSynthPlayer;
    /**
     * 'Playing', 'Paused' or 'Stopped' per stateChanged.
     */
    public readonly states: string[] = [];
    public readonly positions: number[] = [];
    /**
     * The sync points loadSong() gave the player: a test shifts them and sends them again.
     */
    public syncPoints: BackingTrackSyncPoint[] = [];
    public finished: number = 0;

    /**
     * @param learned The learned start values; share one between two harnesses to stand for a recreated player.
     */
    public constructor(
        external: boolean = false,
        hasSoundFont: boolean = true,
        learned: MediaSyncLearnedValues = new MediaSyncLearnedValues()
    ) {
        this.graph = new FakeMixGraph(this.timer);
        const parts = new MediaSynthPlayerParts();
        if (external) {
            const media = new ExternalMediaPlayer(500);
            const handler = new TestMediaHandler();
            (media.output as IExternalMediaSynthOutput).handler = handler;
            const clock = new ExternalMediaClock(new TimerHeardTime(this.timer, this.graph), () => 0);
            this.media = media;
            this.handler = handler;
            this.externalClock = clock;
            parts.clock = clock;
            parts.externalClock = clock;
        } else {
            const output = new TestMediaOutput();
            const clock = new FakeBackingClock(output);
            this.media = new BackingTrackPlayer(output, 500);
            this.mediaOutput = output;
            this.backingClock = clock;
            parts.clock = clock;
            parts.probe = this.probe;
        }
        parts.media = this.media;
        parts.synth = this.synth;
        parts.synthOutput = this.synthOutput;
        parts.graph = this.graph;
        parts.timer = this.timer;
        parts.probeLatencies = this.probeLatencies;
        parts.hasSoundFont = hasSoundFont;
        parts.learned = learned;
        this.player = new MediaSynthPlayer(parts);
        this.player.stateChanged.on(e =>
            this.states.push(e.state === PlayerState.Playing ? 'Playing' : e.stopped ? 'Stopped' : 'Paused')
        );
        this.states.length = 0; // on() replays the current state at once (fire-on-register)
        this.player.positionChanged.on(e => this.positions.push(e.currentTime));
        this.player.finished.on(() => this.finished++);
    }

    /**
     * Loads syncpoints-testfile.gp; with `synthReady` the synthesizer is then ready (the usual start). `leadInMs`
     * moves every sync point that much later on the media's axis: a recording whose bar 1 comes after a lead-in
     * (a video's intro). The file's own bar 1 is at media time 0.
     */
    public async loadSong(synthReady: boolean = true, leadInMs: number = 0): Promise<MidiFile> {
        const data = await TestPlatform.loadFile('test-data/audio/syncpoints-testfile.gp');
        const score = ScoreLoader.loadScoreFromBytes(data, new Settings());
        const midi = new MidiFile();
        const generator = new MidiFileGenerator(score, new Settings(), new AlphaSynthMidiFileHandler(midi));
        generator.generate();
        for (const p of generator.syncPoints) {
            p.syncTime += leadInMs;
        }
        if (this.mediaOutput) {
            this.mediaOutput.backingTrackDuration += leadInMs;
        }
        if (this.handler) {
            this.handler.backingTrackDuration += leadInMs;
        }
        this.syncPoints = generator.syncPoints;
        this.player.loadMidiFile(midi);
        this.player.loadBackingTrack(score);
        this.player.updateSyncPoints(generator.syncPoints);
        if (synthReady) {
            this.synth.becomeReady();
            this.synth.becomeReadyForPlayback();
        }
        return midi;
    }

    /**
     * External media: the integration reports its position through the player's output, as apps do (alphaTab's
     * YouTube sample does this every 50 ms).
     */
    public report(position: number): void {
        (this.player.output as IExternalMediaSynthOutput).updatePosition(position);
    }
}
