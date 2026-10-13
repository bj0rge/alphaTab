import type { IEventEmitter, IEventEmitterOfT } from '@coderline/alphatab/EventEmitter';
import type { BackingTrack } from '@coderline/alphatab/model/BackingTrack';
import type { IAudioElementBackingTrackSynthOutput } from '@coderline/alphatab/platform/javascript/AudioElementBackingTrackSynthOutput';
import type { IBackingTrackSynthOutput } from '@coderline/alphatab/synth/BackingTrackPlayer';
import type { IExternalMediaHandler, IExternalMediaSynthOutput } from '@coderline/alphatab/synth/ExternalMediaPlayer';
import type { ISynthOutput, ISynthOutputDevice } from '@coderline/alphatab/synth/ISynthOutput';

/**
 * MediaSynthPlayer.output (spec §6.1): the media output's members, so `output.audioElement` and an external-media
 * `handler` keep working, with the synthesizer output's device methods, because the media now plays through the
 * synthesizer's AudioContext. The transport members do nothing: each player drives its own output.
 * @target web
 * @internal
 */
export class MediaSynthOutput implements IExternalMediaSynthOutput {
    private readonly _media: IBackingTrackSynthOutput;
    private readonly _synth: ISynthOutput;

    public constructor(media: IBackingTrackSynthOutput, synth: ISynthOutput) {
        this._media = media;
        this._synth = synth;
    }

    /**
     * The backing track's <audio> (undefined for external media).
     */
    public get audioElement(): HTMLAudioElement | undefined {
        return (this._media as Partial<IAudioElementBackingTrackSynthOutput>).audioElement;
    }

    public get handler(): IExternalMediaHandler | undefined {
        return (this._media as Partial<IExternalMediaSynthOutput>).handler;
    }

    public set handler(value: IExternalMediaHandler | undefined) {
        if ('handler' in this._media) {
            (this._media as IExternalMediaSynthOutput).handler = value;
        }
    }

    /**
     * External media: whether a position update still shows the position from before a seek (set by the combined
     * player). Such an update never reaches the media player, so neither its cursor nor its end check jumps back.
     */
    public skipPosition: ((currentTime: number) => boolean) | null = null;

    public updatePosition(currentTime: number): void {
        if (this.skipPosition?.(currentTime)) {
            return;
        }
        (this._media as Partial<IExternalMediaSynthOutput>).updatePosition?.(currentTime);
    }

    public get timeUpdate(): IEventEmitterOfT<number> {
        return this._media.timeUpdate;
    }

    public get backingTrackDuration(): number {
        return this._media.backingTrackDuration;
    }

    public get playbackRate(): number {
        return this._media.playbackRate;
    }

    public set playbackRate(value: number) {
        this._media.playbackRate = value;
    }

    public get masterVolume(): number {
        return this._media.masterVolume;
    }

    public set masterVolume(value: number) {
        this._media.masterVolume = value;
    }

    public seekTo(time: number): void {
        this._media.seekTo(time);
    }

    public loadBackingTrack(backingTrack: BackingTrack): void {
        this._media.loadBackingTrack(backingTrack);
    }

    public get sampleRate(): number {
        return this._synth.sampleRate;
    }

    public get ready(): IEventEmitter {
        return this._media.ready;
    }

    public get samplesPlayed(): IEventEmitterOfT<number> {
        return this._synth.samplesPlayed;
    }

    public get sampleRequest(): IEventEmitter {
        return this._synth.sampleRequest;
    }

    public open(_bufferTimeInMilliseconds: number): void {}
    public play(): void {}
    public pause(): void {}
    public destroy(): void {}
    public addSamples(_samples: Float32Array): void {}
    public resetSamples(): void {}

    public activate(): void {
        // resumes the shared AudioContext (a user gesture)
        this._synth.activate();
    }

    public enumerateOutputDevices(): Promise<ISynthOutputDevice[]> {
        return this._synth.enumerateOutputDevices();
    }

    public setOutputDevice(device: ISynthOutputDevice | null): Promise<void> {
        return this._synth.setOutputDevice(device);
    }

    public getOutputDevice(): Promise<ISynthOutputDevice | null> {
        return this._synth.getOutputDevice();
    }
}
