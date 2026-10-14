/**
 * The playback range and the loop wrap (spec §6.2).
 * @target web
 */
import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@coderline/alphatab/Logger';
import { PlaybackRange } from '@coderline/alphatab/synth/PlaybackRange';
import { PlayerState } from '@coderline/alphatab/synth/PlayerState';
import { MediaSynthHarness } from 'test/audio/MediaSyncFakes';

const StartTick = 7680;
const EndTick = 15360;

async function looping(speed: number = 1, loop: boolean = true) {
    const h = new MediaSynthHarness();
    await h.loadSong();
    h.player.playbackSpeed = speed;
    h.player.isLooping = loop;
    const range = new PlaybackRange();
    range.startTick = StartTick;
    range.endTick = EndTick;
    h.player.playbackRange = range;
    return { h, start: h.media.tickToMediaTime(StartTick), end: h.media.tickToMediaTime(EndTick) };
}

/**
 * Time and the media move together, in 10 ms steps.
 */
function run(h: MediaSynthHarness, ms: number) {
    for (let t = 0; t < ms; t += 10) {
        h.timer.advance(10);
        h.mediaOutput!.advance(10);
    }
}

describe('MediaSynthPlayerLoopTests', () => {
    it('setting-a-range-seeks-to-its-start-and-raises-the-event', async () => {
        const h = new MediaSynthHarness();
        await h.loadSong();
        let changed = 0;
        h.player.playbackRangeChanged.on(() => changed++);
        const range = new PlaybackRange();
        range.startTick = StartTick;
        range.endTick = EndTick;
        h.player.playbackRange = range;
        expect(changed).toBe(1);
        expect(h.mediaOutput!.currentTime).toBeCloseTo(h.media.tickToMediaTime(StartTick), 3);
    });

    it('a-wrap-fires-finished-and-restarts-through-the-handshake', async () => {
        const { h, start, end } = await looping();
        h.player.countInVolume = 1;
        h.player.play(); // counts in
        h.synth.startCountIn(2000);
        h.synthOutput.endCountIn(0.5 * 48000);
        h.timer.advance(600);
        const plays = h.synth.count('play:');
        run(h, (end - start) + 100);
        expect(h.finished).toBe(1);
        expect(h.states).toEqual(['Playing']);
        expect(h.synth.count('play:')).toBe(plays + 1);
        expect(h.synth.calls[h.synth.calls.length - 1]).toBe('play:countIn=0');
        expect(h.player.diagnostics.wraps.length).toBe(1);
        expect(h.mediaOutput!.currentTime).toBeLessThan(start + 200);
    });

    it('a-wrap-above-1x-pre-rolls-60-ms', async () => {
        const { h, start, end } = await looping(1.5);
        h.player.play();
        run(h, (end - start) / 1.5 + 100);
        expect(h.finished).toBe(1);
        // the first Play at 1.5x pre-rolls too: the wrap's own pre-roll is the last seek
        expect(h.mediaOutput!.seekTimes[h.mediaOutput!.seekTimes.length - 1]).toBeCloseTo(start - 60, 3);
    });

    it('a-wrap-below-1x-comes-before-the-heard-range-end', async () => {
        // at 0.5x the media is heard 60 ms x 0.5 = 30 ms ahead of the position it reports (the clock's model, as in
        // planStart): timed from the reported position, the wrap lets the next bar's downbeat sound first
        const { h, start, end } = await looping(0.5);
        h.probeLatencies.set(0.5, 60);
        h.backingClock!.latencyMs = 60;
        const heard: number[] = [];
        h.player.finished.on(() => heard.push(h.mediaOutput!.currentTime + 60 * 0.5));
        h.player.play();
        run(h, (end - start + 60) / 0.5 + 100);
        expect(heard.length).toBe(1);
        expect(heard[0]).toBeLessThanOrEqual(end - 15);
        expect(heard[0]).toBeGreaterThan(end - 25);
    });

    it('the-range-end-without-looping-stops-at-the-range-start', async () => {
        const { h, start, end } = await looping(1, false);
        h.player.play();
        run(h, (end - start) + 100);
        expect(h.finished).toBe(1);
        expect(h.states).toEqual(['Playing', 'Stopped']);
        expect(h.mediaOutput!.currentTime).toBeCloseTo(start, 3);
    });

    it('looping-without-a-range-wraps-at-the-song-end', async () => {
        const h = new MediaSynthHarness();
        await h.loadSong();
        h.player.isLooping = true;
        const songEnd = h.media.tickToMediaTime(h.media.loadedMidiInfo!.endTick);
        h.mediaOutput!.currentTime = songEnd - 300;
        h.player.play();
        run(h, 400);
        expect(h.finished).toBe(1);
        expect(h.states).toEqual(['Playing']);
        expect(h.mediaOutput!.currentTime).toBeLessThan(200);
    });

    it('a-whole-song-wrap-below-1x-pre-rolls-into-a-lead-in', async () => {
        // bar 1 starts 2 s into the recording: every pass restarts 60 ms before bar 1, not at the media's own start
        const h = new MediaSynthHarness();
        await h.loadSong(true, 2000);
        h.player.playbackSpeed = 0.5;
        h.player.isLooping = true;
        const songEnd = h.media.tickToMediaTime(h.media.loadedMidiInfo!.endTick);
        h.mediaOutput!.currentTime = songEnd - 300;
        h.player.play();
        run(h, 800);
        expect(h.finished).toBe(1);
        expect(h.mediaOutput!.seekTimes[h.mediaOutput!.seekTimes.length - 1]).toBeCloseTo(1940, 3);
    });

    it('a-late-wrap-timer-still-wraps-at-the-song-end', async () => {
        // the media's own update passes the song's end before the timer fires (a busy main thread)
        const h = new MediaSynthHarness();
        await h.loadSong();
        h.player.isLooping = true;
        const songEnd = h.media.tickToMediaTime(h.media.loadedMidiInfo!.endTick);
        h.mediaOutput!.currentTime = songEnd - 300;
        h.player.play();
        h.timer.advance(250); // the timer is due at the song's end - 15 ms (285 ms) and hasn't run yet
        h.mediaOutput!.advance(350); // the next update is already past the song's end
        expect(h.finished).toBe(1);
        expect(h.states).toEqual(['Playing']);
        expect(h.mediaOutput!.isPlaying).toBe(true);
        expect(h.mediaOutput!.currentTime).toBeLessThan(200);
        h.timer.advance(100); // the old timer is gone: no second wrap
        expect(h.finished).toBe(1);
    });

    it('an-early-timer-waits-for-the-media', async () => {
        const { h, start, end } = await looping();
        h.player.play();
        h.timer.advance((end - start) + 100); // the media hasn't moved (it started late)
        expect(h.finished).toBe(0);
        run(h, (end - start) + 100);
        expect(h.finished).toBe(1);
    });

    it('destroy-clears-the-wrap-timer', async () => {
        // Review Focus 5
        const { h } = await looping();
        h.player.play();
        h.player.destroy();
        expect(h.timer.pending).toBe(0);
    });

    it('a-pause-or-a-stop-cancels-the-wrap', async () => {
        for (const interrupt of ['pause', 'stop'] as const) {
            const { h, start, end } = await looping();
            h.player.play();
            run(h, 100);
            h.player[interrupt]();
            expect(h.timer.pending).toBe(0);
            run(h, end - start + 100);
            expect(h.finished).toBe(0);
        }
    });

    it('a-seek-drops-the-wrap-until-the-media-has-seeked', async () => {
        const { h } = await looping();
        h.player.play();
        h.backingClock!.isSeeking = true; // the <audio> takes a moment to seek
        h.player.tickPosition = EndTick - 480; // 125 ms before the range end
        expect(h.timer.pending).toBe(0);
        h.backingClock!.finishSeek();
        run(h, 200);
        expect(h.finished).toBe(1);
    });

    it('a-speed-change-while-playing-times-the-wrap-at-the-new-speed', async () => {
        const { h, start, end } = await looping();
        const heard: number[] = [];
        h.player.finished.on(() => heard.push(h.mediaOutput!.currentTime));
        h.player.play();
        run(h, 100);
        h.player.playbackSpeed = 2; // the timer was set for 1x: at twice the speed the end comes in half the time
        run(h, (end - start - 100) / 2 + 100);
        expect(heard.length).toBe(1);
        expect(heard[0]).toBeLessThanOrEqual(end - 15);
        expect(heard[0]).toBeGreaterThan(end - 60);
    });

    it('turning-looping-on-while-playing-arms-the-wrap', async () => {
        const h = new MediaSynthHarness();
        await h.loadSong();
        const songEnd = h.media.tickToMediaTime(h.media.loadedMidiInfo!.endTick);
        h.mediaOutput!.currentTime = songEnd - 300;
        h.player.play(); // not looping: the media's own end would stop both
        h.player.isLooping = true;
        run(h, 400);
        expect(h.finished).toBe(1);
        expect(h.states).toEqual(['Playing']);
        expect(h.mediaOutput!.currentTime).toBeLessThan(200);
    });

    it('the-media-alone-wraps-too', async () => {
        // no SoundFont: the media plays alone (§6.1), and its start arms the wrap
        const warning = vi.spyOn(Logger, 'warning').mockImplementation(() => {});
        const h = new MediaSynthHarness(false, false);
        warning.mockRestore();
        await h.loadSong(false);
        h.player.isLooping = true;
        const range = new PlaybackRange();
        range.startTick = StartTick;
        range.endTick = EndTick;
        h.player.playbackRange = range;
        const start = h.media.tickToMediaTime(StartTick);
        const end = h.media.tickToMediaTime(EndTick);
        h.player.play();
        run(h, end - start + 100);
        expect(h.finished).toBe(1);
        expect(h.states).toEqual(['Playing']);
        expect(h.synth.count('play')).toBe(0);
    });

    it('a-count-in-time-limit-still-wraps', async () => {
        // the count-in's end never comes: the media starts alone at the time limit, and that start arms the wrap
        const warning = vi.spyOn(Logger, 'warning').mockImplementation(() => {});
        const { h, start, end } = await looping();
        h.player.countInVolume = 1;
        h.player.play(); // counts in
        h.synth.startCountIn(2000);
        h.timer.advance(2300); // past the count-in's length and the time limit's extra 250 ms
        warning.mockRestore();
        expect(h.mediaOutput!.isPlaying).toBe(true);
        run(h, end - start + 100);
        expect(h.finished).toBe(1);
    });

    it('a-synth-failure-during-the-count-in-still-wraps', async () => {
        // the count-in is the synthesizer's alone: the media plays alone from the failure on, and that start arms the
        // wrap like any other
        const warning = vi.spyOn(Logger, 'warning').mockImplementation(() => {});
        const { h, start, end } = await looping();
        h.player.countInVolume = 1;
        h.player.play(); // counts in
        h.synth.startCountIn(2000);
        h.synth.fail('alphaTab.worker.mjs: 404');
        warning.mockRestore();
        expect(h.mediaOutput!.isPlaying).toBe(true);
        run(h, end - start + 100);
        expect(h.finished).toBe(1);
        expect(h.states).toEqual(['Playing']);
        expect(h.mediaOutput!.currentTime).toBeLessThan(start + 200);
    });

    it('a-synth-failure-while-the-media-seeks-still-wraps', async () => {
        // the synthesizer is lost between Play and the end of the media's seek: only the media's half of the start
        // runs, and it arms the wrap
        const warning = vi.spyOn(Logger, 'warning').mockImplementation(() => {});
        const { h, start, end } = await looping();
        h.backingClock!.isSeeking = true; // the <audio> is still seeking when Play comes
        h.player.play();
        h.synth.fail('alphaTab.worker.mjs: 404');
        warning.mockRestore();
        h.backingClock!.finishSeek();
        expect(h.mediaOutput!.isPlaying).toBe(true);
        run(h, end - start + 100);
        expect(h.finished).toBe(1);
        expect(h.states).toEqual(['Playing']);
    });

    it('a-finished-handler-that-stops-the-player-ends-the-wrap', async () => {
        // a practice app that stops after N loops: its stop() wins over the wrap
        const { h, start, end } = await looping();
        h.player.finished.on(() => h.player.stop());
        h.player.play();
        run(h, end - start + 100);
        expect(h.finished).toBe(1);
        expect(h.states).toEqual(['Playing', 'Stopped']);
        expect(h.mediaOutput!.isPlaying).toBe(false);
        expect(h.synth.state).toBe(PlayerState.Paused);
        expect(h.synth.count('play:')).toBe(1);
        expect(h.mediaOutput!.currentTime).toBeCloseTo(start, 3);
        expect(h.timer.pending).toBe(0);
    });

    it('a-finished-handler-that-pauses-the-player-ends-the-wrap', async () => {
        const { h, start, end } = await looping();
        h.player.finished.on(() => h.player.pause());
        h.player.play();
        run(h, end - start + 100);
        expect(h.finished).toBe(1);
        expect(h.states).toEqual(['Playing', 'Paused']);
        expect(h.mediaOutput!.isPlaying).toBe(false);
        expect(h.synth.state).toBe(PlayerState.Paused);
        expect(h.synth.count('play:')).toBe(1);
        // back at the range start, as the synthesizer alone seeks there after finished: the next Play starts a pass
        expect(h.mediaOutput!.currentTime).toBeCloseTo(start, 3);
        expect(h.timer.pending).toBe(0);
    });

    it('a-finished-handler-that-destroys-the-player-ends-the-wrap', async () => {
        // Review Focus 5: nothing restarts in a destroyed player, and no timer is armed
        const { h, start, end } = await looping();
        h.player.finished.on(() => h.player.destroy());
        h.player.play();
        run(h, end - start + 100);
        expect(h.finished).toBe(1);
        expect(h.states).toEqual(['Playing']);
        expect(h.mediaOutput!.isPlaying).toBe(false);
        expect(h.synth.state).toBe(PlayerState.Paused);
        expect(h.synth.count('play:')).toBe(1);
        expect(h.timer.pending).toBe(0);
    });

    it('a-finished-handler-that-destroys-the-player-fires-no-stop-without-looping', async () => {
        // the range end without looping stops both, as today; not in a player the handler destroyed
        const { h, start, end } = await looping(1, false);
        h.player.finished.on(() => h.player.destroy());
        h.player.play();
        run(h, end - start + 100);
        expect(h.finished).toBe(1);
        expect(h.states).toEqual(['Playing']);
        expect(h.timer.pending).toBe(0);
    });

    it('a-finished-handler-that-clears-looping-still-gets-the-last-pass', async () => {
        // "loop N times": the app clears isLooping in its finished handler. Whether the pass wraps is decided before the
        // handler runs, as the synthesizer alone does, so this pass still wraps and the next range end stops
        const { h, start, end } = await looping();
        h.player.finished.on(() => {
            h.player.isLooping = false;
        });
        h.player.play();
        run(h, end - start + 100);
        expect(h.finished).toBe(1);
        expect(h.states).toEqual(['Playing']);
        expect(h.mediaOutput!.isPlaying).toBe(true);
        run(h, end - start + 100);
        expect(h.finished).toBe(2);
        expect(h.states).toEqual(['Playing', 'Stopped']);
    });

    it('a-finished-handler-that-sets-looping-at-a-range-end-without-a-loop-still-stops', async () => {
        const { h, start, end } = await looping(1, false);
        h.player.finished.on(() => {
            h.player.isLooping = true;
        });
        h.player.play();
        run(h, end - start + 100);
        expect(h.finished).toBe(1);
        expect(h.states).toEqual(['Playing', 'Stopped']);
        expect(h.mediaOutput!.isPlaying).toBe(false);
        expect(h.timer.pending).toBe(0);
    });

    it('a-pass-the-finished-handler-ends-leaves-no-wrap-record', async () => {
        // diagnostics.wraps lists the wraps that restarted
        for (const interrupt of ['pause', 'stop'] as const) {
            const { h, start, end } = await looping();
            h.player.finished.on(() => h.player[interrupt]());
            h.player.play();
            run(h, end - start + 100);
            expect(h.finished).toBe(1);
            expect(h.player.diagnostics.wraps.length).toBe(0);
        }
    });
});
