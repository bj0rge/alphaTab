import type { EventEmitter, IEventEmitterOfT } from '@coderline/alphatab/EventEmitter';
import type { MidiEvent } from '@coderline/alphatab/midi/MidiEvent';
import type { MidiFile } from '@coderline/alphatab/midi/MidiFile';
import type { BackingTrack } from '@coderline/alphatab/model/BackingTrack';
import type { Score } from '@coderline/alphatab/model/Score';
import { AlphaSynthBase } from '@coderline/alphatab/synth/AlphaSynth';
import { Queue } from '@coderline/alphatab/synth/ds/Queue';
import type { BackingTrackSyncPoint } from '@coderline/alphatab/synth/IAlphaSynth';
import type { IAudioSampleSynthesizer } from '@coderline/alphatab/synth/IAudioSampleSynthesizer';
import type { ISynthOutput } from '@coderline/alphatab/synth/ISynthOutput';
import type { Hydra } from '@coderline/alphatab/synth/soundfont/Hydra';
import type { SynthEvent } from '@coderline/alphatab/synth/synthesis/SynthEvent';

/**
 * A synth output for playing backing tracks.
 * @public
 */
export interface IBackingTrackSynthOutput extends ISynthOutput {
    /**
     * An event fired when the playback time changes. The time is in absolute milliseconds.
     */
    readonly timeUpdate: IEventEmitterOfT<number>;
    /**
     * The total duration of the backing track in milliseconds.
     */
    readonly backingTrackDuration: number;
    /**
     * The playback rate at which the output should playback.
     */
    playbackRate: number;
    /**
     * The volume at which the output should play (0-1)
     */
    masterVolume: number;
    /**
     * Instructs the output to seek to the given time position.
     * @param time The absolute time in milliseconds.
     */
    seekTo(time: number): void;

    /**
     * Instructs the output to load the given backing track.
     * @param backingTrack The backing track to load.
     */
    loadBackingTrack(backingTrack: BackingTrack): void;
}

/**
 * @internal
 */
class BackingTrackAudioSynthesizer implements IAudioSampleSynthesizer {
    private _midiEventQueue: Queue<SynthEvent> = new Queue<SynthEvent>();

    public masterVolume: number = 1;
    public metronomeVolume: number = 0;
    public outSampleRate: number = 44100;
    public currentTempo: number = 120;
    public timeSignatureNumerator: number = 4;
    public timeSignatureDenominator: number = 4;
    public activeVoiceCount: number = 0;
    public output!: IBackingTrackSynthOutput;

    public noteOffAll(_immediate: boolean): void {
        // not supported, ignore
    }

    public resetSoft(): void {
        // not supported, ignore
    }

    public resetPresets(): void {
        // not supported, ignore
    }

    public loadPresets(
        _hydra: Hydra,
        _instrumentPrograms: Set<number>,
        _percussionKeys: Set<number>,
        _append: boolean
    ): void {
        // not supported, ignore
    }

    public setupMetronomeChannel(_metronomeChannel: number, _metronomeVolume: number): void {
        // not supported, ignore
    }

    public synthesizeSilent(_sampleCount: number): void {
        this.fakeSynthesize();
    }

    private _processMidiMessage(_e: MidiEvent): void {}

    public dispatchEvent(synthEvent: SynthEvent): void {
        this._midiEventQueue.enqueue(synthEvent);
    }

    public synthesize(_buffer: Float32Array, _bufferPos: number, _sampleCount: number): SynthEvent[] {
        return this.fakeSynthesize();
    }

    public fakeSynthesize(): SynthEvent[] {
        const processedEvents: SynthEvent[] = [];
        while (!this._midiEventQueue.isEmpty) {
            const m: SynthEvent = this._midiEventQueue.dequeue()!;
            if (m.isMetronome && this.metronomeVolume > 0) {
                // ignore metronome
            } else if (m.event) {
                this._processMidiMessage(m.event);
            }
            processedEvents.push(m);
        }
        return processedEvents;
    }

    public applyTranspositionPitches(_transpositionPitches: Map<number, number>): void {
        // not supported, ignore
    }
    public setChannelTranspositionPitch(_channel: number, _semitones: number): void {
        // not supported, ignore
    }
    public channelSetMute(_channel: number, _mute: boolean): void {
        // not supported, ignore
    }
    public channelSetSolo(_channel: number, _solo: boolean): void {
        // not supported, ignore
    }
    public resetChannelStates(): void {
        // not supported, ignore
    }
    public channelSetMixVolume(_channel: number, _volume: number): void {
        // not supported, ignore
    }
    public hasSamplesForProgram(_program: number): boolean {
        return true;
    }
    public hasSamplesForPercussion(_key: number): boolean {
        return true;
    }

    public readonly outputBusCount: number = 1;

    public channelSetOutputBus(_channel: number, _bus: number): void {}

    public resetChannelOutputBuses(): void {}
}

/**
 * @internal
 */
export class BackingTrackPlayer extends AlphaSynthBase {
    private _backingTrackOutput: IBackingTrackSynthOutput;
    constructor(backingTrackOutput: IBackingTrackSynthOutput, bufferTimeInMilliseconds: number) {
        super(backingTrackOutput, new BackingTrackAudioSynthesizer(), bufferTimeInMilliseconds);
        (this.synthesizer as BackingTrackAudioSynthesizer).output = backingTrackOutput;
        this._backingTrackOutput = backingTrackOutput;

        backingTrackOutput.timeUpdate.on(timePosition => {
            const alphaTabTimePosition = this.sequencer.mainTimePositionFromBackingTrack(
                timePosition,
                backingTrackOutput.backingTrackDuration
            );

            this.sequencer.fillMidiEventQueueToEndTime(alphaTabTimePosition);
            (this.synthesizer as BackingTrackAudioSynthesizer).fakeSynthesize();

            this.updateTimePosition(alphaTabTimePosition, false);
            this.checkForFinish();
        });
    }

    protected override updateMasterVolume(value: number): void {
        super.updateMasterVolume(value);
        this.applyMediaVolume();
    }

    protected override updateBackingTrackVolume(_value: number): void {
        this.applyMediaVolume();
    }

    /**
     * The media's own volume: masterVolume × backingTrackVolume (§7), so it also works without mixing. An
     * `<audio>` element's volume stops at 1 (the browser throws `IndexSizeError` above it), so a level above 1
     * needs mixing, where the gains apply it.
     */
    protected applyMediaVolume(): void {
        this._backingTrackOutput.masterVolume = Math.min(1, this.masterVolume * this.backingTrackVolume);
    }

    protected override updatePlaybackSpeed(value: number): void {
        super.updatePlaybackSpeed(value);
        this._backingTrackOutput.playbackRate = value;
    }

    protected override onSampleRequest(): void {
        // should never be called
    }

    public override loadMidiFile(midi: MidiFile): void {
        if (!this.isSoundFontLoaded) {
            this.isSoundFontLoaded = true;
            (this.soundFontLoaded as EventEmitter).trigger();
        }
        super.loadMidiFile(midi);
    }

    protected override updateTimePosition(timePosition: number, isSeek: boolean): void {
        super.updateTimePosition(timePosition, isSeek);
        if (isSeek) {
            this._backingTrackOutput.seekTo(
                this.sequencer.mainTimePositionToBackingTrack(
                    timePosition,
                    this._backingTrackOutput.backingTrackDuration
                )
            );
        }
    }

    public override loadBackingTrack(score: Score): void {
        const backingTrackInfo = score.backingTrack;
        if (backingTrackInfo) {
            this._backingTrackOutput.loadBackingTrack(backingTrackInfo);
            this.timePosition = 0;
        }
    }

    public override updateSyncPoints(syncPoints: BackingTrackSyncPoint[]): void {
        this.sequencer.mainUpdateSyncPoints(syncPoints);
        this.tickPosition = this.tickPosition;
    }

    /**
     * Seeks to a time on the media's own axis (the combined player's handshakes).
     * @internal
     */
    public seekMediaTo(mediaTime: number): void {
        const timePosition = this.sequencer.mainTimePositionFromBackingTrack(
            mediaTime,
            this._backingTrackOutput.backingTrackDuration
        );
        this.timePosition = Math.max(0, timePosition);
        if (timePosition < 0) {
            // before bar 1 (a recording with a lead-in) the song position is negative, and the seek back from it
            // would land at media time 0: the cursor waits at the song's start, the media goes to the time itself
            // (the later seek wins)
            this._backingTrackOutput.seekTo(mediaTime);
        }
    }

    /**
     * The media time at which the main song reaches `tick` (the spec §4 mapping; without sync points the media
     * time is the song time).
     * @internal
     */
    public tickToMediaTime(tick: number): number {
        return this.sequencer.mainTickToMediaTime(tick, this._backingTrackOutput.backingTrackDuration);
    }

    /**
     * The media time this player seeks the media to for its current position.
     * @internal
     */
    public get mediaTimeOfPosition(): number {
        return this.sequencer.mainTimePositionToBackingTrack(
            this.timePosition,
            this._backingTrackOutput.backingTrackDuration
        );
    }
}
