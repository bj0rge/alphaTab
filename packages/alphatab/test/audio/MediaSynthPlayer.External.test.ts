/**
 * External media with the combined player (spec §6.2): seeks, wraps, stalls and starts inside the media.
 * @target web
 */
import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@coderline/alphatab/Logger';
import { PlaybackRange } from '@coderline/alphatab/synth/PlaybackRange';
import { MediaSynthHarness } from 'test/audio/MediaSyncFakes';

async function externalPlaying(): Promise<MediaSynthHarness> {
    const h = new MediaSynthHarness(true);
    await h.loadSong();
    h.report(5000); // the paused media's position
    h.player.play(); // through alphaTab: no movement since the pause
    for (let i = 1; i <= 6; i++) {
        h.timer.advance(50);
        h.report(5000 + i * 50);
    }
    return h;
}

function last(h: MediaSynthHarness): string {
    return h.synth.calls[h.synth.calls.length - 1];
}

/**
 * A looping range, played through alphaTab from its start.
 */
async function externalLooping(): Promise<{ h: MediaSynthHarness; start: number }> {
    const h = new MediaSynthHarness(true);
    await h.loadSong();
    const range = new PlaybackRange();
    range.startTick = 7680;
    range.endTick = 15360;
    h.player.isLooping = true;
    h.player.playbackRange = range;
    const start = h.media.tickToMediaTime(range.startTick);
    h.report(start);
    h.player.play();
    return { h, start };
}

/**
 * The media plays on and reports every 50 ms until the range end raises finished.
 */
function playToTheRangeEnd(h: MediaSynthHarness, start: number): void {
    let position = start;
    for (let guard = 0; h.finished === 0 && guard < 10000; guard++) {
        h.timer.advance(50);
        position += 50;
        h.report(position);
    }
}

describe('MediaSynthPlayerExternalTests', () => {
    it('a-seek-silences-the-synth-until-the-clock-has-a-fit-again', async () => {
        const h = await externalPlaying();
        h.player.timePosition = 20000;
        const target = h.media.mediaTimeOfPosition;
        expect(h.handler!.seekTimes[h.handler!.seekTimes.length - 1]).toBeCloseTo(target, 3);
        expect(h.handler!.pauses).toBe(0); // the media can't be held
        expect(last(h)).toBe('pause');
        h.timer.advance(50);
        h.report(5350); // still the position from before the jump
        expect(last(h)).toBe('pause');
        for (let i = 0; i < 3; i++) {
            h.timer.advance(50);
            h.report(target + i * 50);
        }
        expect(last(h)).toBe('play:countIn=0');
        expect(h.synth.lastSeek()).toBeCloseTo(target + 100 + 10, 0); // the media now + the re-sync lead
    });

    it('a-hold-at-the-jump-target-stays-out-of-the-fit', async () => {
        // YouTube buffering after a seek: the video reports the target, stays there 150 ms, then moves
        const h = await externalPlaying();
        h.player.timePosition = 20000;
        const target = h.media.mediaTimeOfPosition;
        for (let i = 0; i < 4; i++) {
            h.timer.advance(50);
            h.report(target);
        }
        expect(last(h)).toBe('pause');
        let position = target;
        for (let i = 1; i <= 10 && last(h) !== 'play:countIn=0'; i++) {
            h.timer.advance(50);
            position = target + i * 50;
            h.report(position);
        }
        expect(last(h)).toBe('play:countIn=0');
        expect(h.synth.lastSeek()).toBeCloseTo(position + 10, 0); // where the video is now + the re-sync lead
    });

    it('a-start-fits-the-clock-from-where-the-media-moves', async () => {
        // YouTube's clock starts ~45 ms after its play() (spike 6), on a slow start 100 ms or more; an integration that
        // reports on a timer sends the paused position until then: those updates stay out of the clock's first fit
        const h = new MediaSynthHarness(true);
        await h.loadSong();
        h.report(5000); // the paused media
        h.player.play(); // through alphaTab, no count-in: the media's play() now
        const moves = h.timer.time + 100;
        const position = () => 5000 + Math.max(0, h.timer.time - moves);
        for (let i = 0; i < 10 && Number.isNaN(h.externalClock!.mediaTimeNow()); i++) {
            h.timer.advance(50);
            h.report(position());
        }
        expect(h.externalClock!.mediaTimeNow()).toBeCloseTo(position(), 0); // where the video is, not behind it
    });

    it('a-wrap-seeks-without-pausing-the-media', async () => {
        // F-5
        const h = new MediaSynthHarness(true);
        await h.loadSong();
        const range = new PlaybackRange();
        range.startTick = 7680;
        range.endTick = 15360;
        h.player.isLooping = true;
        h.player.playbackRange = range;
        const start = h.media.tickToMediaTime(range.startTick);
        h.report(start);
        h.player.play();
        let position = start;
        for (let guard = 0; h.finished === 0 && guard < 10000; guard++) {
            h.timer.advance(50);
            position += 50;
            h.report(position);
        }
        expect(h.finished).toBe(1);
        expect(h.handler!.pauses).toBe(0);
        expect(h.handler!.seekTimes[h.handler!.seekTimes.length - 1]).toBeCloseTo(start, 3);
        expect(last(h)).toBe('pause');
        for (let i = 0; i < 3; i++) {
            h.timer.advance(50);
            h.report(start + i * 50);
        }
        expect(last(h)).toBe('play:countIn=0');
    });

    it('a-speed-change-from-the-wrap-does-not-wrap-again', async () => {
        // the rhythm game's auto-BPM sets a new speed from the positionChanged the wrap raises
        const h = new MediaSynthHarness(true);
        await h.loadSong();
        const range = new PlaybackRange();
        range.startTick = 7680;
        range.endTick = 15360;
        h.player.isLooping = true;
        h.player.playbackRange = range;
        const start = h.media.tickToMediaTime(range.startTick);
        let lastTick = -1;
        h.player.positionChanged.on(e => {
            const jumpedBack = lastTick >= 0 && e.currentTick < lastTick - 960;
            lastTick = e.currentTick;
            if (jumpedBack) {
                h.player.playbackSpeed = 1.05; // the loop was passed: a little faster
            }
        });
        h.report(start);
        h.player.play();
        let position = start;
        for (let guard = 0; h.finished === 0 && guard < 10000; guard++) {
            h.timer.advance(50);
            position += 50;
            h.report(position);
        }
        expect(h.finished).toBe(1);
        h.timer.advance(20); // the media hasn't reported the jump yet
        h.report(position); // a stale update from before the seek
        h.timer.advance(20);
        expect(h.finished).toBe(1);
        expect(h.player.diagnostics.wraps.length).toBe(1);
        for (let i = 0; i < 3; i++) {
            h.timer.advance(50);
            h.report(start + i * 50 * 1.05);
        }
        expect(last(h)).toBe('play:countIn=0'); // the synth restarts past the range start, where the media is
    });

    it('a-whole-song-loop-wraps-to-bar-1-after-a-lead-in', async () => {
        // the video's bar 1 comes 2 s in (an intro): every pass goes back to bar 1, not to the intro
        const h = new MediaSynthHarness(true);
        await h.loadSong(true, 2000);
        h.player.isLooping = true;
        const songEnd = h.media.tickToMediaTime(h.media.loadedMidiInfo!.endTick);
        h.report(songEnd - 300);
        h.player.play();
        let position = songEnd - 300;
        for (let guard = 0; h.finished === 0 && guard < 10000; guard++) {
            h.timer.advance(50);
            position += 50;
            h.report(position);
        }
        expect(h.finished).toBe(1);
        expect(h.handler!.seekTimes[h.handler!.seekTimes.length - 1]).toBeCloseTo(2000, 3);
        for (let i = 0; i < 3; i++) {
            h.timer.advance(50);
            h.report(2000 + i * 50);
        }
        expect(last(h)).toBe('play:countIn=0');
    });

    it('a-stall-silences-the-synth-and-restarts-it-after', async () => {
        // F-17, spike 9 §4
        const h = await externalPlaying();
        const plays = h.synth.count('play:');
        h.timer.advance(50);
        h.report(5300);
        h.timer.advance(50);
        h.report(5300); // the same position for 100 ms: buffering
        expect(last(h)).toBe('pause');
        for (let i = 1; i <= 3; i++) {
            h.timer.advance(50);
            h.report(5300 + i * 50);
        }
        expect(h.synth.count('play:')).toBe(plays + 1);
    });

    it('a-stale-update-after-a-wrap-does-not-move-the-cursor-back', async () => {
        // after a seek the video still reports its old position for a moment (spike 9)
        const h = new MediaSynthHarness(true);
        await h.loadSong();
        const range = new PlaybackRange();
        range.startTick = 7680;
        range.endTick = 15360;
        h.player.isLooping = true;
        h.player.playbackRange = range;
        const start = h.media.tickToMediaTime(range.startTick);
        let passes = 0;
        let lastTick = -1;
        h.player.positionChanged.on(e => {
            if (lastTick >= 0 && e.currentTick < lastTick - 960) {
                passes++; // how the rhythm game counts loop passes
            }
            lastTick = e.currentTick;
        });
        h.report(start);
        h.player.play();
        let position = start;
        for (let guard = 0; h.finished === 0 && guard < 10000; guard++) {
            h.timer.advance(50);
            position += 50;
            h.report(position);
        }
        h.timer.advance(50);
        h.report(position + 50); // still the position from before the jump
        h.timer.advance(50);
        h.report(start + 20);
        expect(h.finished).toBe(1);
        expect(passes).toBe(1);
    });

    it('a-stale-update-past-the-song-end-keeps-the-whole-song-loop', async () => {
        const h = new MediaSynthHarness(true);
        await h.loadSong();
        h.player.isLooping = true;
        const songEnd = h.media.tickToMediaTime(h.media.loadedMidiInfo!.endTick);
        h.report(songEnd - 300);
        h.player.play();
        let position = songEnd - 300;
        for (let guard = 0; h.finished === 0 && guard < 10000; guard++) {
            h.timer.advance(50);
            position += 50;
            h.report(position);
        }
        h.timer.advance(50);
        h.report(position + 50); // still the position from before the jump, now past the song's end
        expect(h.finished).toBe(1);
        expect(h.states).toEqual(['Playing']);
        expect(h.handler!.pauses).toBe(0);
    });

    it('a-start-inside-the-media-skips-the-count-in-and-learning', async () => {
        // F-6
        const h = new MediaSynthHarness(true);
        await h.loadSong();
        h.player.countInVolume = 1;
        h.report(1000); // paused at 1000
        h.timer.advance(300);
        h.report(1220); // play pressed inside the video; the app hears of it ~220 ms later
        h.player.play(); // the integration calls api.play() from the media's play event
        expect(h.synth.count('play:')).toBe(0); // waits for the media's clock
        for (let i = 1; i <= 3; i++) {
            h.timer.advance(50);
            h.report(1220 + i * 50);
        }
        expect(h.synth.calls.filter(c => c.startsWith('play:'))).toEqual(['play:countIn=0']);
        expect(h.handler!.plays).toBe(1);
        expect(h.player.controller.startLeads.size).toBe(0);
    });

    it('a-play-after-a-pause-counts-in-while-the-media-reports-its-paused-position', async () => {
        // an integration that keeps calling updatePosition() while the media is paused; the media stopped 30 ms after
        // its last update before the pause
        const h = await externalPlaying(); // the last update: 5300
        h.timer.advance(30);
        h.player.pause();
        for (let i = 0; i < 20; i++) {
            h.timer.advance(50);
            h.report(5330); // where the media stopped
        }
        h.player.countInVolume = 1;
        h.player.play(); // through alphaTab
        expect(last(h)).toBe('play:countIn=1');
    });

    it('a-play-after-a-stop-counts-in-while-the-media-reports-its-paused-position', async () => {
        const h = await externalPlaying();
        h.player.stop(); // alphaTab sends the media back to the song's start
        for (let i = 0; i < 20; i++) {
            h.timer.advance(50);
            h.report(0);
        }
        h.player.countInVolume = 1;
        h.player.play();
        expect(last(h)).toBe('play:countIn=1');
    });

    it('media-only-keeps-looping-external-media', async () => {
        // the synthesizer can't play (no SoundFont, or it failed): the loop still wraps on every pass, as today
        const warning = vi.spyOn(Logger, 'warning').mockImplementation(() => {});
        const h = new MediaSynthHarness(true, false);
        warning.mockRestore();
        await h.loadSong(false);
        h.synth.becomeReady();
        const range = new PlaybackRange();
        range.startTick = 7680;
        range.endTick = 15360;
        h.player.isLooping = true;
        h.player.playbackRange = range;
        const start = h.media.tickToMediaTime(range.startTick);
        const end = h.media.tickToMediaTime(range.endTick);
        h.report(start);
        h.player.play();
        let position = start;
        let seeks = h.handler!.seekTimes.length;
        for (let t = 0; t < 2.5 * (end - start); t += 50) {
            h.timer.advance(50);
            if (h.handler!.seekTimes.length !== seeks) {
                seeks = h.handler!.seekTimes.length;
                position = h.handler!.seekTimes[seeks - 1]; // the video jumped to the range start
            } else {
                position += 50;
            }
            h.report(position);
        }
        expect(h.finished).toBe(2);
        expect(h.player.diagnostics.wraps.length).toBe(2);
        expect(position).toBeLessThan(end);
    });

    it('a-start-through-alphatab-counts-in', async () => {
        const h = new MediaSynthHarness(true);
        await h.loadSong();
        h.player.countInVolume = 1;
        h.report(1000);
        h.player.play();
        expect(last(h)).toBe('play:countIn=1');
        expect(h.handler!.plays).toBe(0); // the media starts at the hand-off
    });

    it('a-seek-while-paused-is-where-the-next-play-starts', async () => {
        // the integration reports positions only while the media plays (alphaTab's youtube-sync demo)
        const h = new MediaSynthHarness(true);
        await h.loadSong();
        h.player.playbackSpeed = 0.75;
        h.report(5000); // the last update before the pause
        h.timer.advance(1000);
        h.player.timePosition = 20000; // the user seeks while paused; no update follows
        const target = h.media.mediaTimeOfPosition;
        h.player.play();
        // the pre-roll seeks 60 ms before alphaTab's position, not before the last reported one
        expect(h.handler!.seekTimes[h.handler!.seekTimes.length - 1]).toBeCloseTo(target - 60, 3);
        expect(h.synth.lastSeek()).toBeCloseTo(target - 60, 3);
    });

    it('a-stop-is-where-the-next-play-starts', async () => {
        // the integration reports positions only while the media plays (alphaTab's youtube-sync demo)
        const h = await externalPlaying();
        h.player.stop(); // alphaTab sends the media back to the song's start; no update follows
        h.timer.advance(1000);
        h.player.playbackSpeed = 0.75;
        h.player.play();
        // the song's start is media time 0 in this file, so the pre-roll stops there
        expect(h.handler!.seekTimes[h.handler!.seekTimes.length - 1]).toBeCloseTo(0, 3);
        expect(h.synth.lastSeek()).toBeCloseTo(0, 3);
    });

    it('after-the-song-end-the-next-play-starts-at-the-song-start', async () => {
        const h = new MediaSynthHarness(true);
        await h.loadSong();
        const songEnd = h.media.tickToMediaTime(h.media.loadedMidiInfo!.endTick);
        h.report(songEnd - 300);
        h.player.play();
        let position = songEnd - 300;
        for (let guard = 0; h.finished === 0 && guard < 100; guard++) {
            h.timer.advance(50);
            position += 50;
            h.report(position);
        }
        expect(h.states).toEqual(['Playing', 'Stopped']);
        h.timer.advance(1000);
        h.player.playbackSpeed = 0.75;
        h.player.play();
        expect(h.handler!.seekTimes[h.handler!.seekTimes.length - 1]).toBeCloseTo(0, 3);
        expect(h.synth.lastSeek()).toBeCloseTo(0, 3);
    });

    it('a-play-inside-a-lead-in-starts-where-the-media-reported', async () => {
        // the video's bar 1 comes 2 s in: a pause inside the intro is known only from the media's own update
        const h = new MediaSynthHarness(true);
        await h.loadSong(true, 2000);
        h.report(1000);
        const seeks = h.handler!.seekTimes.length;
        h.player.play();
        expect(h.handler!.seekTimes.length).toBe(seeks); // at 1x the media starts where it is
        expect(h.synth.lastSeek()).toBeCloseTo(1000, 3);
    });

    it('a-media-that-has-not-started-restarts-the-synth-when-it-moves', async () => {
        const h = new MediaSynthHarness(true);
        await h.loadSong();
        h.report(5000);
        h.player.play();
        for (let i = 1; i <= 12; i++) {
            h.timer.advance(50);
            h.report(5000); // buffering
        }
        expect(last(h)).toBe('pause');
        for (let i = 1; i <= 3; i++) {
            h.timer.advance(50);
            h.report(5000 + i * 50);
        }
        expect(last(h)).toBe('play:countIn=0');
    });

    it('a-finished-handler-that-clears-looping-still-gets-the-last-pass', async () => {
        // "loop N times": whether the pass wraps is decided before the app's finished handler runs
        const { h, start } = await externalLooping();
        h.player.finished.on(() => {
            h.player.isLooping = false;
        });
        playToTheRangeEnd(h, start);
        expect(h.finished).toBe(1);
        expect(h.states).toEqual(['Playing']);
        expect(h.handler!.seekTimes[h.handler!.seekTimes.length - 1]).toBeCloseTo(start, 3);
        for (let i = 0; i < 3; i++) {
            h.timer.advance(50);
            h.report(start + i * 50);
        }
        expect(last(h)).toBe('play:countIn=0');
    });

    it('a-finished-handler-that-pauses-ends-the-external-wrap', async () => {
        // the app's pause wins over the wrap: the media goes back to the range start but nothing restarts
        const { h, start } = await externalLooping();
        h.player.finished.on(() => h.player.pause());
        playToTheRangeEnd(h, start);
        expect(h.finished).toBe(1);
        expect(h.states).toEqual(['Playing', 'Paused']);
        expect(h.player.diagnostics.wraps.length).toBe(0);
        expect(h.handler!.seekTimes[h.handler!.seekTimes.length - 1]).toBeCloseTo(start, 3);
        const plays = h.synth.count('play:');
        for (let i = 0; i < 3; i++) {
            h.timer.advance(50);
            h.report(start + i * 50);
        }
        expect(h.synth.count('play:')).toBe(plays);
        expect(h.timer.pending).toBe(0);
    });
});
