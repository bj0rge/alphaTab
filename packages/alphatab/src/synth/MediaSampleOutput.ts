/**
 * The media time of one chunk of samples the synthesizer rendered while following a media clock.
 * @internal
 */
export class MediaSampleChunk {
    /**
     * The media time (milliseconds) of the chunk's first frame, or -1 when the chunk is not on the media's
     * time axis (the count-in).
     */
    public mediaStart: number = -1;

    /**
     * The media milliseconds per frame, constant within a chunk.
     */
    public mediaPerFrame: number = 0;

    /**
     * Whether the chunk's first frame is the first frame after the count-in.
     */
    public countInEnd: boolean = false;

    /**
     * A count-in chunk: the frames from its first frame to the count-in's end, at the speed it was rendered at;
     * -1 for other chunks. The worklet reports the count-in's end from it, about a bar ahead (Task 7).
     */
    public countInFramesLeft: number = -1;
}

/**
 * Receives the samples the synthesizer renders while following a media clock, with their media time.
 * @internal
 */
export interface IMediaSampleOutput {
    addMediaSamples(samples: Float32Array, chunk: MediaSampleChunk): void;
}
