import {
    EventEmitter,
    EventEmitterOfT,
    type IEventEmitter,
    type IEventEmitterOfT
} from '@coderline/alphatab/EventEmitter';
import type { ISynthOutput, ISynthOutputDevice } from '@coderline/alphatab/synth/ISynthOutput';
import type { IMediaSampleOutput, MediaSampleChunk } from '@coderline/alphatab/synth/MediaSampleOutput';
import { SynthConstants } from '@coderline/alphatab/synth/SynthConstants';

/**
 * A chunk the {@link FollowTestOutput} received.
 * @internal
 */
export class RecordedChunk {
    public readonly frames: number;
    public readonly mediaStart: number;
    public readonly mediaPerFrame: number;
    public readonly countInEnd: boolean;

    public constructor(frames: number, mediaStart: number, mediaPerFrame: number, countInEnd: boolean) {
        this.frames = frames;
        this.mediaStart = mediaStart;
        this.mediaPerFrame = mediaPerFrame;
        this.countInEnd = countInEnd;
    }

    public get mediaEnd(): number {
        return this.mediaStart + this.frames * this.mediaPerFrame;
    }
}

/**
 * An output for a synthesizer that follows a media clock: records the chunks with their media time; the test
 * asks for chunks and reports frames as played.
 * @internal
 */
export class FollowTestOutput implements ISynthOutput, IMediaSampleOutput {
    public readonly chunks: RecordedChunk[] = [];
    public resetCount: number = 0;

    public get sampleRate(): number {
        return 44100;
    }

    public open(_bufferTimeInMilliseconds: number): void {
        (this.ready as EventEmitter).trigger();
    }

    public play(): void {}
    public pause(): void {}
    public destroy(): void {}
    public activate(): void {}

    public addSamples(samples: Float32Array): void {
        this.chunks.push(new RecordedChunk(samples.length / SynthConstants.AudioChannels, -1, 0, false));
    }

    /**
     * The countInFramesLeft of each received media chunk.
     */
    public readonly countInFramesLeft: number[] = [];

    public addMediaSamples(samples: Float32Array, chunk: MediaSampleChunk): void {
        this.countInFramesLeft.push(chunk.countInFramesLeft);
        this.chunks.push(
            new RecordedChunk(
                samples.length / SynthConstants.AudioChannels,
                chunk.mediaStart,
                chunk.mediaPerFrame,
                chunk.countInEnd
            )
        );
    }

    public resetSamples(): void {
        this.resetCount++;
    }

    /**
     * Asks the synthesizer for the next chunk.
     */
    public request(): void {
        (this.sampleRequest as EventEmitter).trigger();
    }

    /**
     * Reports frames as played.
     */
    public played(frames: number): void {
        (this.samplesPlayed as EventEmitterOfT<number>).trigger(frames);
    }

    /**
     * The song chunks (on the media's time axis), in order.
     */
    public get stampedChunks(): RecordedChunk[] {
        return this.chunks.filter(c => c.mediaStart >= 0);
    }

    /**
     * The media time at the end of each micro buffer rendered, in order (64 frames per micro buffer).
     */
    public microBufferEnds(): number[] {
        const ends: number[] = [];
        for (const chunk of this.chunks) {
            const microBuffers = chunk.frames / SynthConstants.MicroBufferSize;
            for (let i = 0; i < microBuffers; i++) {
                ends.push(
                    chunk.mediaStart < 0
                        ? -1
                        : chunk.mediaStart + (i + 1) * SynthConstants.MicroBufferSize * chunk.mediaPerFrame
                );
            }
        }
        return ends;
    }

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
