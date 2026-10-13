import { describe, expect, it } from 'vitest';
import { ScoreLoader } from '@coderline/alphatab/importer/ScoreLoader';
import { AlphaSynthMidiFileHandler } from '@coderline/alphatab/midi/AlphaSynthMidiFileHandler';
import { MidiEventType } from '@coderline/alphatab/midi/MidiEvent';
import { MidiFile } from '@coderline/alphatab/midi/MidiFile';
import { MidiFileGenerator } from '@coderline/alphatab/midi/MidiFileGenerator';
import { MidiUtils } from '@coderline/alphatab/midi/MidiUtils';
import { Settings } from '@coderline/alphatab/Settings';
import { AlphaSynthBase } from '@coderline/alphatab/synth/AlphaSynth';
import type { BackingTrackSyncPoint } from '@coderline/alphatab/synth/IAlphaSynth';
import { MidiFileSequencer } from '@coderline/alphatab/synth/MidiFileSequencer';
import { PlayerState } from '@coderline/alphatab/synth/PlayerState';
import { SynthConstants } from '@coderline/alphatab/synth/SynthConstants';
import { FollowTestOutput } from 'test/audio/FollowTestOutput';
import { RecordingAudioSynthesizer } from 'test/audio/RecordingAudioSynthesizer';
import { TestPlatform } from 'test/TestPlatform';

/**
 * The backing track of syncpoints-testfile.gp is 42 s long (see SyncPoint.test.ts).
 */
const MediaDuration = 42000;

async function loadSyncPointSong(): Promise<{ midi: MidiFile; syncPoints: BackingTrackSyncPoint[] }> {
    const data = await TestPlatform.loadFile('test-data/audio/syncpoints-testfile.gp');
    const score = ScoreLoader.loadScoreFromBytes(data, new Settings());
    const midi = new MidiFile();
    const generator = new MidiFileGenerator(score, new Settings(), new AlphaSynthMidiFileHandler(midi));
    generator.generate();
    return { midi, syncPoints: generator.syncPoints };
}

function loadTexSong(tex: string): MidiFile {
    const score = ScoreLoader.loadAlphaTex(tex);
    const midi = new MidiFile();
    new MidiFileGenerator(score, new Settings(), new AlphaSynthMidiFileHandler(midi)).generate();
    return midi;
}

function createSequencer(midi: MidiFile, syncPoints: BackingTrackSyncPoint[], speed: number) {
    const synthesizer = new RecordingAudioSynthesizer();
    const sequencer = new MidiFileSequencer(synthesizer);
    sequencer.loadMidi(midi);
    sequencer.mainUpdateSyncPoints(syncPoints);
    sequencer.playbackSpeed = speed;
    return { sequencer, synthesizer };
}

function noteOnTimes(synthesizer: RecordingAudioSynthesizer): number[] {
    // rounded: the generator's times carry float error (the second quarter at 120 BPM is at 500.00000000000006 ms)
    return synthesizer.events
        .filter(e => !e.synthEvent.isMetronome && e.synthEvent.event?.type === MidiEventType.NoteOn)
        .map(e => Math.round(e.synthEvent.time));
}

describe('FollowMediaTests', () => {
    it('fill-until-dispatches-the-events-before-the-target', () => {
        const midi = loadTexSong(`
            \\tempo 120
            .
            C4 * 4 | C4 * 4
        `);
        const { sequencer, synthesizer } = createSequencer(midi, [], 1);

        expect(sequencer.fillMidiEventQueueUntil(1000)).toBe(true);
        expect(noteOnTimes(synthesizer)).toEqual([0, 500]);

        // a target behind the current time dispatches nothing
        expect(sequencer.fillMidiEventQueueUntil(900)).toBe(false);
        expect(noteOnTimes(synthesizer)).toEqual([0, 500]);

        sequencer.fillMidiEventQueueUntil(1000.5);
        expect(noteOnTimes(synthesizer)).toEqual([0, 500, 1000]);
    });

    it('media-time-is-the-song-time-without-sync-points', async () => {
        const { midi } = await loadSyncPointSong();
        for (const speed of [0.5, 1, 1.5]) {
            const { sequencer } = createSequencer(midi, [], speed);
            // spike 9 §1: media time × speed would play the score at speed² of its tempo
            expect(sequencer.mainMidiTimeFromMediaTime(10000, MediaDuration)).toBe(10000);
        }
    });

    it('media-time-with-sync-points-does-not-depend-on-the-speed', async () => {
        const { midi, syncPoints } = await loadSyncPointSong();
        const mediaTimes = [0, 5000, 15000, 30000, 41000];
        const atOne = createSequencer(midi, syncPoints, 1).sequencer;
        const expected = mediaTimes.map(m => atOne.mainMidiTimeFromMediaTime(m, MediaDuration));
        expect(expected).toEqual(mediaTimes.map(m => atOne.mainTimePositionFromBackingTrack(m, MediaDuration)));

        for (const speed of [0.5, 1.5]) {
            const { sequencer } = createSequencer(midi, (await loadSyncPointSong()).syncPoints, speed);
            for (let i = 0; i < mediaTimes.length; i++) {
                expect(sequencer.mainMidiTimeFromMediaTime(mediaTimes[i], MediaDuration)).toBeCloseTo(expected[i], 6);
            }
        }
    });

    it('tick-to-media-time-inverts-the-mapping', async () => {
        const { midi, syncPoints } = await loadSyncPointSong();
        for (const points of [syncPoints, []]) {
            for (const speed of [0.5, 1.5]) {
                const { sequencer } = createSequencer(midi, points, speed);
                for (const tick of [0, MidiUtils.QuarterTime * 4, MidiUtils.QuarterTime * 30]) {
                    const mediaTime = sequencer.mainTickToMediaTime(tick, MediaDuration);
                    expect(sequencer.mainMidiTimeFromMediaTime(mediaTime, MediaDuration)).toBeCloseTo(
                        sequencer.mainTickPositionToTimePosition(tick) * speed,
                        3
                    );
                }
            }
        }
    });

    it('tick-to-media-time-at-the-song-end-is-the-last-sync-point', async () => {
        // the generator ends the sync points with one at the song's end; today's mapping gives 0 / 0 there
        const { midi, syncPoints } = await loadSyncPointSong();
        const last = syncPoints[syncPoints.length - 1];
        for (const speed of [0.5, 1, 1.5]) {
            const { sequencer } = createSequencer(midi, syncPoints, speed);
            const songEnd = sequencer.mainTickToMediaTime(sequencer.currentEndTick, MediaDuration);
            expect(Number.isFinite(songEnd)).toBe(true);
            expect(songEnd).toBe(last.syncTime);
        }
    });

    it('sync-bpm-at-follows-the-active-sync-point', async () => {
        const { midi, syncPoints } = await loadSyncPointSong();
        const { sequencer } = createSequencer(midi, syncPoints, 1);
        const points = sequencer.currentSyncPoints;
        expect(points.length).toBeGreaterThan(1);
        for (let i = 0; i < points.length; i++) {
            expect(sequencer.mainSyncBpmAt(points[i].syncTime)).toBe(points[i].syncBpm);
            if (i > 0) {
                expect(sequencer.mainSyncBpmAt(points[i].syncTime - 1)).toBe(points[i - 1].syncBpm);
            }
        }
        expect(createSequencer(midi, [], 1).sequencer.mainSyncBpmAt(1000)).toBe(0);
    });

    it('count-in-uses-the-given-tempo-else-the-score-tempo', () => {
        const midi = loadTexSong(`
            \\tempo 100
            .
            \\ts 3 4
            C4 * 3 | C4 * 3
        `);
        const scoreTempo = createSequencer(midi, [], 1).sequencer;
        scoreTempo.startCountIn();
        expect(scoreTempo.isPlayingCountIn).toBe(true);
        expect(scoreTempo.currentTempo).toBe(100);
        expect(scoreTempo.currentEndTime).toBeCloseTo(3 * 600, 6); // one bar of 3/4 at 100 BPM

        const syncTempo = createSequencer(midi, [], 1).sequencer;
        syncTempo.startCountIn(90);
        expect(syncTempo.currentTempo).toBe(90);
        expect(syncTempo.currentEndTime).toBeCloseTo((3 * 60000) / 90, 6);
    });
});

const MicroBufferMs = (SynthConstants.MicroBufferSize / 44100) * 1000;

function createFollowingSynth(midi: MidiFile, syncPoints: BackingTrackSyncPoint[], speed: number, startMedia: number) {
    const output = new FollowTestOutput();
    const synthesizer = new RecordingAudioSynthesizer();
    const synth = new AlphaSynthBase(output, synthesizer, 500);
    synth.mediaSampleOutput = output;
    synth.loadMidiFile(midi);
    synth.playbackSpeed = speed;
    synth.followMedia(true, MediaDuration, syncPoints);
    synth.seekToMediaTime(startMedia);
    synthesizer.events.length = 0;
    synthesizer.synthesizeCalls = 0;
    return { output, synthesizer, synth };
}

function renderUntil(output: FollowTestOutput, mediaTime: number) {
    while (
        output.stampedChunks.length === 0 ||
        output.stampedChunks[output.stampedChunks.length - 1].mediaEnd < mediaTime
    ) {
        output.request();
    }
}

describe('FollowMediaSynthTests', () => {
    for (const withSyncPoints of [true, false]) {
        for (const speed of [0.5, 1, 1.5]) {
            it(`dispatches-events-at-their-media-time-${withSyncPoints ? 'sync-points' : 'no-sync-points'}-${speed}x`, async () => {
                const { midi, syncPoints } = await loadSyncPointSong();
                const points = withSyncPoints ? syncPoints : [];
                const { output, synthesizer, synth } = createFollowingSynth(midi, points, speed, 0);
                synth.play();
                renderUntil(output, 20000);

                const oracle = createSequencer(
                    midi,
                    withSyncPoints ? (await loadSyncPointSong()).syncPoints : [],
                    speed
                ).sequencer;
                const ends = output.microBufferEnds();
                const step = MicroBufferMs * speed;
                let checked = 0;
                for (const recorded of synthesizer.events) {
                    const e = recorded.synthEvent;
                    if (!e.isMetronome && e.event?.type !== MidiEventType.NoteOn) {
                        continue;
                    }
                    // the media time the event belongs to (the cursor's inverse mapping; none: song time = media time)
                    const expected = withSyncPoints
                        ? oracle.mainTimePositionToBackingTrack(e.time / speed, MediaDuration)
                        : e.time;
                    const dispatchedAt = ends[recorded.microBuffer];
                    expect(dispatchedAt - expected).toBeGreaterThanOrEqual(-1e-3);
                    expect(dispatchedAt - expected).toBeLessThanOrEqual(step + 1e-3);
                    checked++;
                }
                expect(checked).toBeGreaterThan(10);
            });
        }
    }

    it('chunk-stamps-are-continuous', async () => {
        const { midi, syncPoints } = await loadSyncPointSong();
        const { output, synth } = createFollowingSynth(midi, syncPoints, 1.5, 1000);
        synth.play();
        renderUntil(output, 3000);
        const chunks = output.stampedChunks;
        expect(chunks[0].mediaStart).toBe(1000);
        for (let i = 1; i < chunks.length; i++) {
            expect(chunks[i].mediaStart).toBeCloseTo(chunks[i - 1].mediaEnd, 9);
            expect(chunks[i].mediaPerFrame).toBeCloseTo((1000 / 44100) * 1.5, 12);
        }
    });

    it('rate-correction-scales-the-media-step', async () => {
        const { midi, syncPoints } = await loadSyncPointSong();
        const { output, synth } = createFollowingSynth(midi, syncPoints, 1, 0);
        synth.play();
        output.request();
        synth.setRateCorrection(1.02);
        output.request();
        const chunks = output.stampedChunks;
        expect(chunks[1].mediaPerFrame).toBeCloseTo((1000 / 44100) * 1.02, 12);
        expect(chunks[1].mediaStart).toBeCloseTo(chunks[0].mediaEnd, 9);
    });

    for (const speed of [1, 1.5]) {
        it(`seek-to-media-time-restarts-the-stamps-${speed}x`, async () => {
            const { midi, syncPoints } = await loadSyncPointSong();
            const { output, synth } = createFollowingSynth(midi, syncPoints, speed, 0);
            synth.play();
            output.request();
            const resets = output.resetCount;
            synth.seekToMediaTime(20000);
            expect(output.resetCount).toBe(resets + 1);
            output.request();
            const chunks = output.stampedChunks;
            expect(chunks[chunks.length - 1].mediaStart).toBe(20000);
            // media 20000 is off the identity mapping of the sync points (it maps to 21990.958 ms of song time); the
            // position is that song time divided by the speed
            const oracle = createSequencer(midi, (await loadSyncPointSong()).syncPoints, speed).sequencer;
            expect(synth.timePosition).toBeCloseTo(oracle.mainMidiTimeFromMediaTime(20000, MediaDuration) / speed, 6);
        });
    }

    it('played-position-follows-the-played-frames', async () => {
        // from media 20000 (off the identity mapping of the sync points) at 1.5x (the speed matters), with the played
        // frames running from the first chunk into the second
        const speed = 1.5;
        const startMedia = 20000;
        const playedFrames = 3000;
        const { midi, syncPoints } = await loadSyncPointSong();
        const { output, synth } = createFollowingSynth(midi, syncPoints, speed, startMedia);
        synth.play();
        output.request();
        output.request();
        expect(output.stampedChunks[0].frames).toBeLessThan(playedFrames);
        output.played(playedFrames);
        const oracle = createSequencer(midi, (await loadSyncPointSong()).syncPoints, speed).sequencer;
        const playedMedia = startMedia + playedFrames * (1000 / 44100) * speed;
        expect(synth.timePosition).toBeCloseTo(oracle.mainMidiTimeFromMediaTime(playedMedia, MediaDuration) / speed, 6);
    });

    it('speed-change-while-following-keeps-the-media-position', async () => {
        const { midi, syncPoints } = await loadSyncPointSong();
        const { output, synth } = createFollowingSynth(midi, syncPoints, 1, 0);
        synth.play();
        output.request();
        output.request();
        const lastEnd = output.stampedChunks[1].mediaEnd;
        const resets = output.resetCount;
        synth.playbackSpeed = 0.75; // G-1 (spike 11 §1): no rescale and seek while following
        expect(output.resetCount).toBe(resets);
        output.request();
        const chunk = output.stampedChunks[2];
        expect(chunk.mediaStart).toBeCloseTo(lastEnd, 9);
        expect(chunk.mediaPerFrame).toBeCloseTo((1000 / 44100) * 0.75, 12);
    });

    it('keeps-following-after-the-song-ends', async () => {
        // Review Focus 1: a backing track with an outro after the last bar
        const { midi, syncPoints } = await loadSyncPointSong();
        const oracle = createSequencer(midi, (await loadSyncPointSong()).syncPoints, 1).sequencer;
        const songEnd = oracle.mainTickToMediaTime(oracle.currentEndTick, MediaDuration);
        const { output, synth } = createFollowingSynth(midi, syncPoints, 1, songEnd - 50);
        let finished = 0;
        synth.finished.on(() => finished++);
        synth.play();
        for (let i = 0; i < 5; i++) {
            output.request();
            output.played(output.chunks[output.chunks.length - 1].frames);
        }
        const chunks = output.stampedChunks;
        expect(chunks.length).toBe(5);
        for (let i = 1; i < chunks.length; i++) {
            expect(chunks[i].mediaStart).toBeCloseTo(chunks[i - 1].mediaEnd, 9);
        }
        expect(finished).toBe(0);
        expect(synth.state).toBe(PlayerState.Playing);
    });
});
