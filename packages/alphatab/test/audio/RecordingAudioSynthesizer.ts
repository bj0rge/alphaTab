import { MidiEventType, type TempoChangeEvent, type TimeSignatureEvent } from '@coderline/alphatab/midi/MidiEvent';
import type { IAudioSampleSynthesizer } from '@coderline/alphatab/synth/IAudioSampleSynthesizer';
import type { Hydra } from '@coderline/alphatab/synth/soundfont/Hydra';
import type { SynthEvent } from '@coderline/alphatab/synth/synthesis/SynthEvent';

/**
 * An event the {@link RecordingAudioSynthesizer} received.
 * @internal
 */
export class RecordedSynthEvent {
    public readonly synthEvent: SynthEvent;
    /**
     * The micro buffer the event was dispatched for: the number of synthesize() calls before it.
     */
    public readonly microBuffer: number;

    public constructor(synthEvent: SynthEvent, microBuffer: number) {
        this.synthEvent = synthEvent;
        this.microBuffer = microBuffer;
    }
}

/**
 * A synthesizer that renders silence and records every dispatched event. Like TinySoundFont it keeps the
 * tempo and time signature of the dispatched events (the count-in reads them).
 * @internal
 */
export class RecordingAudioSynthesizer implements IAudioSampleSynthesizer {
    public masterVolume: number = 1;
    public metronomeVolume: number = 0;
    public outSampleRate: number = 44100;
    public currentTempo: number = 120;
    public timeSignatureNumerator: number = 4;
    public timeSignatureDenominator: number = 4;
    public activeVoiceCount: number = 0;

    public readonly events: RecordedSynthEvent[] = [];
    public synthesizeCalls: number = 0;

    public dispatchEvent(synthEvent: SynthEvent): void {
        this.events.push(new RecordedSynthEvent(synthEvent, this.synthesizeCalls));
        const e = synthEvent.event;
        if (e && e.type === MidiEventType.TimeSignature) {
            const timeSignature = e as TimeSignatureEvent;
            this.timeSignatureNumerator = timeSignature.numerator;
            this.timeSignatureDenominator = Math.pow(2, timeSignature.denominatorIndex);
        } else if (e && e.type === MidiEventType.TempoChange) {
            this.currentTempo = (e as TempoChangeEvent).beatsPerMinute;
        }
    }

    public synthesize(_buffer: Float32Array, _bufferPos: number, _sampleCount: number): SynthEvent[] {
        this.synthesizeCalls++;
        return [];
    }

    public synthesizeSilent(_sampleCount: number): void {}
    public noteOffAll(_immediate: boolean): void {}
    public resetSoft(): void {}
    public resetPresets(): void {}
    public loadPresets(
        _hydra: Hydra,
        _instrumentPrograms: Set<number>,
        _percussionKeys: Set<number>,
        _append: boolean
    ): void {}
    public setupMetronomeChannel(_metronomeChannel: number, _metronomeVolume: number): void {}
    public applyTranspositionPitches(_transpositionPitches: Map<number, number>): void {}
    public setChannelTranspositionPitch(_channel: number, _semitones: number): void {}
    public channelSetMute(_channel: number, _mute: boolean): void {}
    public channelSetSolo(_channel: number, _solo: boolean): void {}
    public resetChannelStates(): void {}
    public channelSetMixVolume(_channel: number, _volume: number): void {}
    public hasSamplesForProgram(_program: number): boolean {
        return true;
    }
    public hasSamplesForPercussion(_key: number): boolean {
        return true;
    }
}
