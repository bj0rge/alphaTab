/**
 * The count-in hand-off (spec §6.2) and the refused-start safety net (R-2).
 * @target web
 */
import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@coderline/alphatab/Logger';
import { PlayerState } from '@coderline/alphatab/synth/PlayerState';
import { MediaSynthHarness } from 'test/audio/MediaSyncFakes';

async function countingIn(speed: number = 1, at: number = 5000): Promise<MediaSynthHarness> {
    const h = new MediaSynthHarness();
    await h.loadSong();
    h.player.playbackSpeed = speed;
    h.player.countInVolume = 1;
    h.mediaOutput!.currentTime = at;
    h.player.play();
    return h;
}

describe('MediaSynthPlayerCountInTests', () => {
    it('play-with-count-in-starts-the-synth-alone', async () => {
        const h = await countingIn();
        expect(h.states).toEqual(['Playing']);
        expect(h.synth.calls.slice(-3)).toEqual(['pause', 'seek:5000', 'play:countIn=1']);
        expect(h.synth.countInVolume).toBe(0); // handshakes later in this playback never count in
        expect(h.mediaOutput!.isPlaying).toBe(false);
        expect(h.player.controller.isActive).toBe(false);
    });

    it('no-position-reaches-the-app-during-the-count-in', async () => {
        const h = new MediaSynthHarness();
        await h.loadSong();
        h.player.playbackSpeed = 0.5;
        h.player.countInVolume = 1;
        h.player.timePosition = 10000;
        const start = h.player.timePosition;
        h.positions.length = 0;
        h.player.play(); // the media pre-rolls 120 ms, paused
        expect(h.positions.filter(p => p < start - 1)).toEqual([]);
    });

    it('the-count-in-end-schedules-the-media-start', async () => {
        const h = await countingIn();
        h.synth.startCountIn(2000);
        h.synthOutput.endCountIn(1.5 * 48000); // no learned latency and no pre-roll at 1x: play() at the boundary
        h.timer.advance(1500 - 12 - 1);
        expect(h.mediaOutput!.isPlaying).toBe(false);
        h.timer.advance(2); // fires 12 ms early, then waits on the audio clock
        expect(h.mediaOutput!.isPlaying).toBe(true);
        expect(h.graph.currentTime).toBeGreaterThanOrEqual(1.5);
        expect(h.player.diagnostics.countIns[0].lateMs).toBeLessThan(0.2);
        expect(h.player.controller.isActive).toBe(true);
    });

    it('below-1x-the-media-pre-rolls-120-ms', async () => {
        // F-14 (D-3)
        const h = await countingIn(0.5, 5000);
        expect(h.mediaOutput!.seekTimes[h.mediaOutput!.seekTimes.length - 1]).toBeCloseTo(5000 - 120, 3);
        h.synth.startCountIn(4000);
        h.synthOutput.endCountIn(3 * 48000);
        // play() at the boundary minus the pre-roll in real time: 120 / 0.5 = 240 ms
        h.timer.advance(3000 - 240 - 12 - 1);
        expect(h.mediaOutput!.isPlaying).toBe(false);
        h.timer.advance(2);
        expect(h.mediaOutput!.isPlaying).toBe(true);
        expect(h.graph.currentTime).toBeCloseTo(2.76, 3);
    });

    it('below-1x-the-pre-roll-stops-at-the-media-start', async () => {
        // a count-in 50 ms into the media: it waits at 0, so the pre-roll is 50 ms, not 120
        const h = await countingIn(0.5, 50);
        expect(Math.min(...h.mediaOutput!.seekTimes)).toBeGreaterThanOrEqual(0);
        h.synth.startCountIn(4000);
        h.synthOutput.endCountIn(3 * 48000);
        // play() at the boundary minus the pre-roll in real time: 50 / 0.5 = 100 ms
        h.timer.advance(3000 - 100 - 12 - 1);
        expect(h.mediaOutput!.isPlaying).toBe(false);
        h.timer.advance(2);
        expect(h.mediaOutput!.isPlaying).toBe(true);
        expect(h.graph.currentTime).toBeCloseTo(2.9, 3);
    });

    it('a-count-in-below-1x-pre-rolls-into-a-lead-in', async () => {
        // bar 1 starts 2 s into the recording: the media waits 120 ms before bar 1, not at the media's own start
        const h = new MediaSynthHarness();
        await h.loadSong(true, 2000);
        h.player.playbackSpeed = 0.5;
        h.player.countInVolume = 1;
        h.mediaOutput!.currentTime = 2000;
        h.player.play();
        expect(h.mediaOutput!.seekTimes[h.mediaOutput!.seekTimes.length - 1]).toBeCloseTo(1880, 3);
        expect(h.synth.lastSeek()).toBeCloseTo(2000, 3);
    });

    it('a-refined-count-in-end-moves-the-media-start', async () => {
        const h = await countingIn();
        h.synth.startCountIn(2000);
        h.synthOutput.endCountIn(1.5 * 48000);
        h.synthOutput.endCountIn(1.51 * 48000); // an underrun moved the boundary 10 ms
        h.timer.advance(1510 - 12 - 1);
        expect(h.mediaOutput!.isPlaying).toBe(false); // the hand-off is planned again from the refined end
        h.timer.advance(2);
        expect(h.mediaOutput!.isPlaying).toBe(true);
        expect(h.graph.currentTime).toBeGreaterThanOrEqual(1.51 - 1e-9);
    });

    it('a-speed-change-after-the-first-end-report-hands-off-at-the-new-end', async () => {
        // the worklet reports the end from the count-in's first chunk; the clicks still to come then speed up
        const h = await countingIn();
        h.synth.startCountIn(2000);
        h.synthOutput.endCountIn(2 * 48000); // a bar ahead
        h.timer.advance(500);
        h.player.playbackSpeed = 1.5;
        h.timer.advance(100);
        h.synthOutput.endCountIn(1.5 * 48000); // the chunks rendered at 1.5x: the end moved to 1.5 s
        // play() at the new end minus the pre-roll in real time: 60 / 1.5 = 40 ms
        h.timer.advance(1500 - 40 - 12 - 1 - 600);
        expect(h.mediaOutput!.isPlaying).toBe(false);
        h.timer.advance(2);
        expect(h.mediaOutput!.isPlaying).toBe(true); // not at the old end's time (2 - 0.04 s)
        expect(h.graph.currentTime).toBeCloseTo(1.46, 3);
    });

    it('the-time-limit-starts-the-media-alone', async () => {
        const h = await countingIn();
        h.synth.startCountIn(2000);
        h.timer.advance(2249);
        expect(h.mediaOutput!.isPlaying).toBe(false);
        h.timer.advance(1);
        expect(h.mediaOutput!.isPlaying).toBe(true);
        expect(h.synth.calls[h.synth.calls.length - 1]).toBe('pause');
        // media only from here on
        h.player.pause();
        const plays = h.synth.count('play:');
        h.player.play();
        expect(h.synth.count('play:')).toBe(plays);
    });

    it('pause-during-the-count-in-cancels-the-hand-off', async () => {
        // Review Focus 2
        const h = await countingIn();
        h.synth.startCountIn(2000);
        h.synthOutput.endCountIn(1.5 * 48000);
        h.player.pause();
        h.timer.advance(3000);
        expect(h.mediaOutput!.isPlaying).toBe(false);
        expect(h.timer.pending).toBe(0);
    });

    it('a-seek-during-the-count-in-restarts-without-count-in', async () => {
        // Review Focus 2
        const h = await countingIn();
        h.synth.startCountIn(2000);
        h.player.timePosition = 20000;
        expect(h.states).toEqual(['Playing']);
        expect(h.synth.calls[h.synth.calls.length - 1]).toBe('play:countIn=0');
        expect(h.mediaOutput!.isPlaying).toBe(true);
        h.timer.advance(3000); // the old count-in's timers are gone
        expect(h.timer.pending).toBe(0);
    });

    it('a-speed-change-during-the-count-in-hands-off-at-the-new-speed', async () => {
        // Review Focus 2: the worker plays the clicks still to come at the new speed
        const h = await countingIn();
        h.synth.startCountIn(2000);
        h.synthOutput.endCountIn(1.5 * 48000); // the count-in ends at 1.5 s
        h.timer.advance(500);
        h.player.playbackSpeed = 0.5;
        // the media waits at the new pre-roll start (120 ms below 1x, F-14)
        expect(h.mediaOutput!.seekTimes[h.mediaOutput!.seekTimes.length - 1]).toBeCloseTo(5000 - 120, 3);
        // play() at the count-in end minus the pre-roll in real time: 120 / 0.5 = 240 ms
        h.timer.advance(1500 - 240 - 12 - 1 - 500);
        expect(h.mediaOutput!.isPlaying).toBe(false);
        h.timer.advance(2);
        expect(h.mediaOutput!.isPlaying).toBe(true);
        expect(h.graph.currentTime).toBeCloseTo(1.26, 3);
        expect(h.player.controller.speed).toBe(0.5);
        expect(h.player.diagnostics.countIns[0].speed).toBe(0.5);
        h.timer.advance(300);
        h.synthOutput.stamp(0, h.mediaOutput!.currentTime + 40);
        h.synthOutput.stamp(0, h.mediaOutput!.currentTime + 40);
        expect(h.player.controller.mediaStartLatencies.size).toBe(0); // a changed speed teaches nothing
    });

    it('a-speed-change-during-a-count-in-at-the-song-start-keeps-the-media-at-0', async () => {
        // the re-timed pre-roll stops at media time 0 too: not a seek to -120 ms
        const h = await countingIn(1, 0);
        h.synth.startCountIn(2000);
        h.timer.advance(500);
        h.player.playbackSpeed = 0.5;
        expect(h.mediaOutput!.seekTimes[h.mediaOutput!.seekTimes.length - 1]).toBe(0);
    });

    it('a-slower-count-in-does-not-hit-the-time-limit', async () => {
        const h = await countingIn();
        h.synth.startCountIn(2000); // the time limit would be at 2.25 s
        h.timer.advance(500);
        h.player.playbackSpeed = 0.5; // the clicks still to come take twice as long: the end is at 3.5 s
        h.timer.advance(2000);
        expect(h.mediaOutput!.isPlaying).toBe(false);
        h.synthOutput.endCountIn(3.5 * 48000);
        h.timer.advance(1000);
        expect(h.mediaOutput!.isPlaying).toBe(true);
        h.player.pause();
        const plays = h.synth.count('play:');
        h.player.play();
        expect(h.synth.count('play:')).toBe(plays + 1); // still mixing
    });

    it('a-late-count-in-end-still-hands-off', async () => {
        // the end was reported, but the output started 400 ms late: the time limit is for an end that never comes
        const h = await countingIn();
        h.synth.startCountIn(2000); // the time limit would be at 2.25 s
        h.timer.advance(1900);
        h.synthOutput.endCountIn(2.4 * 48000);
        h.timer.advance(350);
        expect(h.mediaOutput!.isPlaying).toBe(false);
        h.timer.advance(200);
        expect(h.mediaOutput!.isPlaying).toBe(true);
        expect(h.player.diagnostics.countIns.length).toBe(1);
        h.player.pause();
        const plays = h.synth.count('play:');
        h.player.play();
        expect(h.synth.count('play:')).toBe(plays + 1); // still mixing
    });

    it('a-media-start-that-never-happens-pauses-both', async () => {
        // R-2 safety net
        const h = await countingIn();
        h.synth.startCountIn(2000);
        h.synthOutput.endCountIn(1.5 * 48000);
        h.timer.advance(1500);
        expect(h.mediaOutput!.isPlaying).toBe(true);
        h.mediaOutput!.isPlaying = false; // the browser refused the delayed play()
        h.timer.advance(600);
        expect(h.states).toEqual(['Playing', 'Paused']);
    });

    it('a-refused-media-start-away-from-1x-pauses-both', async () => {
        // R-2: away from 1x the media's play() runs in the pre-roll seek's 'seeked' event, after Play returned
        const h = new MediaSynthHarness();
        await h.loadSong();
        h.player.playbackSpeed = 0.75;
        h.mediaOutput!.currentTime = 5000;
        const warning = vi.spyOn(Logger, 'warning');
        h.backingClock!.isSeeking = true; // the pre-roll seek ends with 'seeked' a moment later
        h.player.play();
        expect(h.mediaOutput!.isPlaying).toBe(false);
        h.backingClock!.finishSeek();
        expect(h.mediaOutput!.isPlaying).toBe(true);
        h.mediaOutput!.isPlaying = false; // the browser refused the play()
        h.timer.advance(600);
        expect(h.states).toEqual(['Playing', 'Paused']);
        expect(h.synth.calls[h.synth.calls.length - 1]).toBe('pause');
        expect(warning.mock.calls.some(c => String(c[1]).startsWith('The media did not start'))).toBe(true);
        warning.mockRestore();
    });

    it('a-media-start-that-never-happens-after-the-time-limit-pauses-it', async () => {
        // R-2 on the time-limit path: the count-in end never comes, the media starts anyway, and then does not run
        const warning = vi.spyOn(Logger, 'warning').mockImplementation(() => {});
        const h = await countingIn();
        h.synth.startCountIn(2000);
        h.timer.advance(2250);
        expect(h.mediaOutput!.isPlaying).toBe(true);
        h.mediaOutput!.isPlaying = false; // the browser refused the play()
        h.timer.advance(600);
        expect(h.states).toEqual(['Playing', 'Paused']);
        expect(h.synth.calls[h.synth.calls.length - 1]).toBe('pause');
        expect(warning.mock.calls.some(c => String(c[1]).startsWith('The media did not start'))).toBe(true);
        warning.mockRestore();
    });

    it('a-media-that-runs-after-the-time-limit-keeps-playing', async () => {
        const warning = vi.spyOn(Logger, 'warning').mockImplementation(() => {});
        const h = await countingIn();
        h.synth.startCountIn(2000);
        h.timer.advance(2250);
        for (let i = 0; i < 14; i++) {
            h.timer.advance(50);
            h.mediaOutput!.advance(50);
        }
        expect(h.states).toEqual(['Playing']);
        expect(warning.mock.calls.some(c => String(c[1]).startsWith('The media did not start'))).toBe(false);
        warning.mockRestore();
    });

    it('a-seek-from-the-playing-handler-keeps-the-media-paused-for-the-count-in', async () => {
        // play() reports Playing before it starts: the app's seek in its handler starts playback first, without a
        // count-in. The start Play makes supersedes it: the media that start played stops, and waits for the count-in
        const h = new MediaSynthHarness();
        await h.loadSong();
        h.player.countInVolume = 1;
        h.player.stateChanged.on(e => {
            if (e.state === PlayerState.Playing) {
                h.player.timePosition = 8000;
            }
        });
        h.player.play();
        expect(h.synth.calls.slice(-3)).toEqual(['pause', `seek:${h.mediaOutput!.currentTime}`, 'play:countIn=1']);
        expect(h.mediaOutput!.isPlaying).toBe(false);
        expect(h.player.controller.isActive).toBe(false);
        h.synth.startCountIn(2000);
        h.synthOutput.endCountIn(1.5 * 48000);
        h.timer.advance(1500);
        expect(h.mediaOutput!.isPlaying).toBe(true);
        expect(h.player.diagnostics.countIns.length).toBe(1);
    });

    it('a-speed-change-during-the-count-in-keeps-the-cursor-at-the-start', async () => {
        // the cursor hold is in the units of the speed it was set at (a slower speed doubles them): it follows it
        const h = new MediaSynthHarness();
        await h.loadSong();
        h.player.countInVolume = 1;
        h.player.timePosition = 5000;
        h.player.play();
        h.synth.startCountIn(2000);
        const start = h.player.timePosition * 2; // the start position in 0.5x units
        h.positions.length = 0;
        h.player.playbackSpeed = 0.5; // the media now waits 120 ms before the start
        expect(h.positions.filter(p => p < start - 1)).toEqual([]);
        h.synthOutput.endCountIn(1.5 * 48000);
        h.timer.advance(1500);
        for (let i = 0; i < 12; i++) {
            h.timer.advance(50);
            h.mediaOutput!.advance(50);
        }
        expect(h.positions.length).toBeGreaterThan(0); // the cursor follows the media after the hand-off
        expect(Math.min(...h.positions)).toBeGreaterThanOrEqual(start - 1);
    });

    it('a-slower-speed-during-a-count-in-with-a-pre-roll-keeps-the-cursor-at-the-start', async () => {
        // the media reports its position at the new speed as the speed changes: the hold is converted before that
        const h = new MediaSynthHarness();
        await h.loadSong();
        h.player.playbackSpeed = 0.75;
        h.player.countInVolume = 1;
        h.player.timePosition = 6000;
        const start = (h.player.timePosition * 0.75) / 0.5; // the start position in 0.5x units
        h.player.play(); // the media waits 120 ms before the start
        h.synth.startCountIn(2000);
        h.positions.length = 0;
        h.player.playbackSpeed = 0.5;
        expect(h.positions.filter(p => p < start - 1)).toEqual([]);
    });
});
