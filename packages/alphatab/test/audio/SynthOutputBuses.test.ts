import { describe, expect, it } from 'vitest';
import { ScoreLoader } from '@coderline/alphatab/importer/ScoreLoader';
import { AlphaSynthMidiFileHandler } from '@coderline/alphatab/midi/AlphaSynthMidiFileHandler';
import { MidiFile } from '@coderline/alphatab/midi/MidiFile';
import { MidiFileGenerator } from '@coderline/alphatab/midi/MidiFileGenerator';
import type { Score } from '@coderline/alphatab/model/Score';
import { AlphaSynth } from '@coderline/alphatab/synth/AlphaSynth';
import { SynthConstants } from '@coderline/alphatab/synth/SynthConstants';
import { TestOutput } from 'test/audio/TestOutput';
import { TestPlatform } from 'test/TestPlatform';

/**
 * Two tracks, the second one starting a bar later.
 */
const TwoTracks = `
    \\tempo 120
    .
    \\track "T01"
    \\ts 4 4
    \\instrument 25
    3.3.4 3.3.4 3.3.4 3.3.4 | r.1 | r.1
    \\track "T02"
    \\instrument 30
    r.1 | 5.2.4 5.2.4 5.2.4 5.2.4 | r.1`;

interface Rendered {
    /** the stereo values of each bus, frame by frame */
    buses: Float32Array[];
    frames: number;
    playedFrames: number;
    finished: boolean;
}

async function render(
    busCount: number,
    route: (synth: AlphaSynth, score: Score) => void,
    maxRequests: number = 200
): Promise<Rendered> {
    const soundFont = await TestPlatform.loadFile('test-data/audio/default.sf2');
    const score = ScoreLoader.loadAlphaTex(TwoTracks);
    const midi = new MidiFile();
    new MidiFileGenerator(score, null, new AlphaSynthMidiFileHandler(midi)).generate();

    const output = new TestOutput(true, busCount);
    const synth = new AlphaSynth(output, 500, busCount);
    synth.loadSoundFont(soundFont, false);
    synth.loadMidiFile(midi);
    route(synth, score);
    let playedFrames = 0;
    output.samplesPlayed.on(frames => {
        playedFrames += frames;
    });
    let finished = false;
    synth.finished.on(() => {
        finished = true;
    });
    synth.play();
    for (let i = 0; i < maxRequests && !finished; i++) {
        output.next();
    }

    const stride = SynthConstants.AudioChannels * busCount;
    let frames = 0;
    for (const chunk of output.samples) {
        frames += chunk.length / stride;
    }
    const buses: Float32Array[] = [];
    for (let b = 0; b < busCount; b++) {
        buses.push(new Float32Array(frames * SynthConstants.AudioChannels));
    }
    let frame = 0;
    for (const chunk of output.samples) {
        for (let i = 0; i < chunk.length; i += stride) {
            for (let b = 0; b < busCount; b++) {
                buses[b][frame * 2] = chunk[i + b * 2];
                buses[b][frame * 2 + 1] = chunk[i + b * 2 + 1];
            }
            frame++;
        }
    }
    return { buses, frames, playedFrames, finished };
}

function routeTrack(synth: AlphaSynth, score: Score, trackIndex: number, bus: number): void {
    const info = score.tracks[trackIndex].playbackInfo;
    synth.setChannelOutputBus(info.primaryChannel, bus);
    synth.setChannelOutputBus(info.secondaryChannel, bus);
}

function energy(values: Float32Array, fromFrame: number = 0, toFrame: number = values.length / 2): number {
    let sum = 0;
    for (let i = fromFrame * 2; i < toFrame * 2; i++) {
        sum += values[i] * values[i];
    }
    return sum;
}

function expectClose(actual: Float32Array, expected: Float32Array): void {
    expect(actual.length).toBe(expected.length);
    let maxDiff = 0;
    for (let i = 0; i < actual.length; i++) {
        maxDiff = Math.max(maxDiff, Math.abs(actual[i] - expected[i]));
    }
    expect(maxDiff).toBeLessThan(1e-6);
}

describe('SynthOutputBusesTests', () => {
    it('one-bus-renders-as-before', async () => {
        const single = await render(1, () => {});
        const routed = await render(1, (synth, score) => routeTrack(synth, score, 1, 1));
        expect(single.finished).toBe(true);
        // a bus that does not exist is bus 0
        expectClose(routed.buses[0], single.buses[0]);
    });

    it('buses-sum-to-the-single-bus-render', async () => {
        const single = await render(1, () => {});
        const split = await render(2, (synth, score) => routeTrack(synth, score, 1, 1));
        expect(split.frames).toBe(single.frames);
        const sum = new Float32Array(split.buses[0].length);
        for (let i = 0; i < sum.length; i++) {
            sum[i] = split.buses[0][i] + split.buses[1][i];
        }
        expectClose(sum, single.buses[0]);
    });

    it('routed-track-plays-only-on-its-bus', async () => {
        const split = await render(2, (synth, score) => routeTrack(synth, score, 1, 1));
        const barFrames = 2 * 44100; // 4/4 at 120 bpm
        // events start on micro-buffer boundaries: T02 may begin up to one micro-buffer before its bar
        const barStart = barFrames - SynthConstants.MicroBufferSize;
        // bar 1: only T01 (bus 0); bar 2: only T02 (bus 1), apart from T01's release tail
        expect(energy(split.buses[0], 0, barFrames)).toBeGreaterThan(0);
        expect(energy(split.buses[1], 0, barStart)).toBe(0);
        expect(energy(split.buses[1], barFrames, 2 * barFrames)).toBeGreaterThan(0);
        expect(energy(split.buses[0], barFrames + 22050, 2 * barFrames)).toBe(0);
    });

    it('missing-bus-falls-back-to-bus-0', async () => {
        const single = await render(1, () => {});
        const split = await render(2, (synth, score) => routeTrack(synth, score, 1, 5));
        expectClose(split.buses[0], single.buses[0]);
        expect(energy(split.buses[1])).toBe(0);
    });

    it('reset-routes-back-to-bus-0', async () => {
        const split = await render(2, (synth, score) => {
            routeTrack(synth, score, 1, 1);
            synth.resetChannelOutputBuses();
        });
        expect(energy(split.buses[1])).toBe(0);
    });

    it('frame-counting-matches-the-single-bus-render', async () => {
        const single = await render(1, () => {});
        const split = await render(3, (synth, score) => routeTrack(synth, score, 0, 2));
        expect(split.finished).toBe(true);
        expect(split.frames).toBe(single.frames);
        expect(split.playedFrames).toBe(single.playedFrames);
    });
});
