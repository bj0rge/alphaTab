import {
    EventEmitter,
    EventEmitterOfT,
    type IEventEmitter,
    type IEventEmitterOfT
} from '@coderline/alphatab/EventEmitter';
import type { BackingTrack } from '@coderline/alphatab/model/BackingTrack';
import type { IBackingTrackSynthOutput } from '@coderline/alphatab/synth/BackingTrackPlayer';
import type { IExternalMediaHandler } from '@coderline/alphatab/synth/ExternalMediaPlayer';
import type { ISynthOutputDevice } from '@coderline/alphatab/synth/ISynthOutput';

/**
 * A backing-track output whose media moves only when the test advances it.
 * @internal
 */
export class TestMediaOutput implements IBackingTrackSynthOutput {
    /**
     * The media's position, ms.
     */
    public currentTime: number = 0;
    public isPlaying: boolean = false;
    public readonly seekTimes: number[] = [];
    public backingTrackDuration: number = 42000;
    public playbackRate: number = 1;
    public masterVolume: number = 1;
    public readonly sampleRate: number = 44100;

    public seekTo(time: number): void {
        this.seekTimes.push(time);
        this.currentTime = time;
    }

    public loadBackingTrack(_backingTrack: BackingTrack): void {}

    public open(_bufferTimeInMilliseconds: number): void {
        (this.ready as EventEmitter).trigger();
    }

    public play(): void {
        this.isPlaying = true;
    }

    public pause(): void {
        this.isPlaying = false;
    }

    public destroy(): void {}
    public addSamples(_samples: Float32Array): void {}
    public resetSamples(): void {}
    public activate(): void {}

    /**
     * The media moves forward and reports its position, as the <audio> does every 50 ms.
     */
    public advance(ms: number): void {
        if (this.isPlaying) {
            this.currentTime += ms * this.playbackRate;
            (this.timeUpdate as EventEmitterOfT<number>).trigger(this.currentTime);
        }
    }

    public readonly timeUpdate: IEventEmitterOfT<number> = new EventEmitterOfT<number>();
    public readonly ready: IEventEmitter = new EventEmitter();
    public readonly samplesPlayed: IEventEmitterOfT<number> = new EventEmitterOfT<number>();
    public readonly sampleRequest: IEventEmitter = new EventEmitter();

    public async enumerateOutputDevices(): Promise<ISynthOutputDevice[]> {
        return [] as ISynthOutputDevice[];
    }
    public async setOutputDevice(_device: ISynthOutputDevice | null): Promise<void> {}
    public async getOutputDevice(): Promise<ISynthOutputDevice | null> {
        return null;
    }
}

/**
 * An external-media handler that records what alphaTab asks of it.
 * @internal
 */
export class TestMediaHandler implements IExternalMediaHandler {
    public backingTrackDuration: number = 42000;
    public playbackRate: number = 1;
    public masterVolume: number = 1;
    public readonly seekTimes: number[] = [];
    public plays: number = 0;
    public pauses: number = 0;

    public seekTo(time: number): void {
        this.seekTimes.push(time);
    }

    public play(): void {
        this.plays++;
    }

    public pause(): void {
        this.pauses++;
    }
}
