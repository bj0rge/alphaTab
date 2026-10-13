/**
 * @target web
 */
import { describe, expect, it } from 'vitest';
import { MediaChunkMarkers } from '@coderline/alphatab/platform/javascript/MediaChunkMarkers';

describe('MediaChunkMarkersTests', () => {
    it('media-time-at-the-read-position-moves-with-consumed-frames', () => {
        const markers = new MediaChunkMarkers();
        markers.push(100, 1000, 0.5, false);
        markers.push(100, 1050, 0.5, false);
        expect(markers.mediaTimeAtReadPosition()).toBe(1000);
        expect(markers.consume(40)).toBe(true);
        expect(markers.mediaTimeAtReadPosition()).toBe(1020);
        expect(markers.consume(80)).toBe(true); // crosses into the second chunk
        expect(markers.mediaTimeAtReadPosition()).toBe(1060);
        expect(markers.bufferedFrames).toBe(80);
    });

    it('unstamped-chunks-keep-the-markers-aligned', () => {
        const markers = new MediaChunkMarkers();
        markers.push(128, -1, 0, false); // count-in
        markers.push(128, 2000, 0.25, true); // the song, from the count-in's end
        expect(markers.mediaTimeAtReadPosition()).toBe(-1);
        expect(markers.consume(128)).toBe(false);
        expect(markers.mediaTimeAtReadPosition()).toBe(2000);
        expect(markers.consume(64)).toBe(true);
        expect(markers.mediaTimeAtReadPosition()).toBe(2016);
    });

    it('a-block-across-an-unstamped-chunk-is-not-stamped', () => {
        const markers = new MediaChunkMarkers();
        markers.push(64, -1, 0, false);
        markers.push(64, 500, 1, true);
        expect(markers.consume(128)).toBe(false);
    });

    it('frames-until-the-count-in-end', () => {
        const markers = new MediaChunkMarkers();
        expect(markers.framesUntilCountInEnd()).toBe(-1);
        markers.push(300, -1, 0, false);
        markers.push(200, 1000, 0.5, true);
        expect(markers.framesUntilCountInEnd()).toBe(300);
        markers.consume(128);
        expect(markers.framesUntilCountInEnd()).toBe(172);
        markers.consume(200); // the boundary has been read
        expect(markers.framesUntilCountInEnd()).toBe(-1);
    });

    it('a-buffered-count-in-chunk-already-yields-the-end', () => {
        // each count-in chunk carries the frames from its first frame to the count-in's end (Task 3)
        const markers = new MediaChunkMarkers();
        markers.push(2048, -1, 0, false, 96000);
        expect(markers.framesUntilCountInEnd()).toBe(96000);
        markers.consume(128);
        expect(markers.framesUntilCountInEnd()).toBe(96000 - 128);
        // after a speed change the latest count-in chunk counts
        markers.push(2048, -1, 0, false, 180000);
        expect(markers.framesUntilCountInEnd()).toBe(2048 - 128 + 180000);
    });

    it('the-chunk-after-the-count-in-gives-the-exact-end', () => {
        const markers = new MediaChunkMarkers();
        markers.push(2048, -1, 0, false, 2560);
        markers.push(512, -1, 0, false, 512);
        expect(markers.framesUntilCountInEnd()).toBe(2560);
        markers.push(2048, 1000, 0.5, true);
        expect(markers.framesUntilCountInEnd()).toBe(2560);
        markers.consume(2561); // the song's first frame has been read
        expect(markers.framesUntilCountInEnd()).toBe(-1);
    });

    it('clear-forgets-everything', () => {
        const markers = new MediaChunkMarkers();
        markers.push(100, 1000, 0.5, true);
        markers.clear();
        expect(markers.bufferedFrames).toBe(0);
        expect(markers.mediaTimeAtReadPosition()).toBe(-1);
        expect(markers.framesUntilCountInEnd()).toBe(-1);
    });
});
