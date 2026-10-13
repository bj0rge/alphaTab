/**
 * @target web
 * @internal
 */
class MediaChunkMarker {
    public readonly frames: number;
    public consumed: number = 0;
    public readonly mediaStart: number;
    public readonly mediaPerFrame: number;
    public readonly countInEnd: boolean;
    /** A count-in chunk: the frames from its first frame to the count-in's end; -1 for other chunks. */
    public readonly countInFramesLeft: number;

    public constructor(
        frames: number,
        mediaStart: number,
        mediaPerFrame: number,
        countInEnd: boolean,
        countInFramesLeft: number
    ) {
        this.frames = frames;
        this.mediaStart = mediaStart;
        this.mediaPerFrame = mediaPerFrame;
        this.countInEnd = countInEnd;
        this.countInFramesLeft = countInFramesLeft;
    }
}

/**
 * The media time of the samples buffered in the AudioWorklet: one marker per written chunk, in write order, so
 * the markers stay aligned with the circular sample buffer (spec §5).
 * @target web
 * @internal
 */
export class MediaChunkMarkers {
    private _markers: MediaChunkMarker[] = [];

    public get bufferedFrames(): number {
        let frames = 0;
        for (const marker of this._markers) {
            frames += marker.frames - marker.consumed;
        }
        return frames;
    }

    /**
     * Records a written chunk. A negative `mediaStart` marks samples that are not on the media's time axis.
     */
    public push(
        frames: number,
        mediaStart: number,
        mediaPerFrame: number,
        countInEnd: boolean,
        countInFramesLeft: number = -1
    ): void {
        if (frames > 0) {
            this._markers.push(new MediaChunkMarker(frames, mediaStart, mediaPerFrame, countInEnd, countInFramesLeft));
        }
    }

    /**
     * The media time of the next frame to be read, or -1 when it is not stamped or nothing is buffered.
     */
    public mediaTimeAtReadPosition(): number {
        if (this._markers.length === 0) {
            return -1;
        }
        const marker = this._markers[0];
        return marker.mediaStart < 0 ? -1 : marker.mediaStart + marker.consumed * marker.mediaPerFrame;
    }

    /**
     * The frames until the count-in's end: exact once the chunk that starts after the count-in is buffered, else
     * from the latest buffered count-in chunk's frames left (the speed it was rendered at); -1 when neither is
     * buffered.
     */
    public framesUntilCountInEnd(): number {
        let frames = 0;
        let estimate = -1;
        for (const marker of this._markers) {
            if (marker.countInEnd && marker.consumed === 0) {
                return frames;
            }
            if (marker.countInFramesLeft >= 0) {
                estimate = frames + marker.countInFramesLeft - marker.consumed;
            }
            frames += marker.frames - marker.consumed;
        }
        return estimate;
    }

    /**
     * Consumes read frames.
     * @returns Whether every consumed frame came from a stamped chunk.
     */
    public consume(frames: number): boolean {
        let remaining = frames;
        let allStamped = true;
        while (remaining > 0 && this._markers.length > 0) {
            const marker = this._markers[0];
            const take = Math.min(remaining, marker.frames - marker.consumed);
            if (marker.mediaStart < 0) {
                allStamped = false;
            }
            marker.consumed += take;
            remaining -= take;
            if (marker.consumed >= marker.frames) {
                this._markers.shift();
            }
        }
        return allStamped && remaining === 0;
    }

    public clear(): void {
        this._markers = [];
    }
}
