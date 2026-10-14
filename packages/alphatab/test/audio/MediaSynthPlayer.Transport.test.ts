/**
 * The combined player's start, seek and speed handshakes (spec §6.2).
 * @target web
 */
import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@coderline/alphatab/Logger';
import { MediaSyncLearnedValues } from '@coderline/alphatab/platform/javascript/MediaSyncController';
import { PlayerState } from '@coderline/alphatab/synth/PlayerState';
import { flush, MediaSynthHarness } from 'test/audio/MediaSyncFakes';

async function playing(at: number = 5000, speed: number = 1): Promise<MediaSynthHarness> {
    const h = new MediaSynthHarness();
    await h.loadSong();
    h.player.playbackSpeed = speed;
    h.mediaOutput!.currentTime = at;
    h.player.play();
    return h;
}

describe('MediaSynthPlayerTransportTests', () => {
    it('play-reports-playing-at-once-and-starts-both-at-the-target', async () => {
        const h = await playing(5000);
        expect(h.states).toEqual(['Playing']);
        expect(h.synth.calls.slice(-4)).toEqual(['followMedia:true', 'pause', 'seek:5000', 'play:countIn=0']);
        expect(h.mediaOutput!.isPlaying).toBe(true);
        expect(h.player.controller.isActive).toBe(true);
    });

    it('a-slower-synth-delays-the-media', async () => {
        const h = new MediaSynthHarness();
        await h.loadSong();
        h.player.controller.startLeads.set(1, 8);
        h.mediaOutput!.currentTime = 5000;
        h.player.play();
        expect(h.mediaOutput!.isPlaying).toBe(false);
        h.timer.advance(7);
        expect(h.mediaOutput!.isPlaying).toBe(false);
        h.timer.advance(1);
        expect(h.mediaOutput!.isPlaying).toBe(true);
    });

    it('other-speeds-pre-roll-the-media-and-start-the-synth-where-it-is-heard', async () => {
        const h = new MediaSynthHarness();
        await h.loadSong();
        h.probeLatencies.set(0.5, 60);
        h.player.playbackSpeed = 0.5;
        h.mediaOutput!.currentTime = 5000;
        h.player.play();
        expect(h.mediaOutput!.seekTimes[h.mediaOutput!.seekTimes.length - 1]).toBeCloseTo(4940, 3);
        expect(h.synth.lastSeek()).toBeCloseTo(4940 + 30, 3);
    });

    it('a-start-away-from-1x-pre-rolls-into-a-lead-in', async () => {
        // bar 1 starts 2 s into the recording: Play from the song's start seeks the media 60 ms before bar 1, not
        // to the media's own start, and the cursor stays at the song's start meanwhile (no position before it)
        const h = new MediaSynthHarness();
        await h.loadSong(true, 2000);
        h.probeLatencies.set(0.5, 60);
        h.player.playbackSpeed = 0.5;
        h.player.timePosition = 0; // the cursor is exactly at the song's start, as after Stop
        h.mediaOutput!.currentTime = 2000;
        h.positions.length = 0;
        h.player.play();
        expect(h.mediaOutput!.seekTimes[h.mediaOutput!.seekTimes.length - 1]).toBeCloseTo(1940, 3);
        expect(h.synth.lastSeek()).toBeCloseTo(1940 + 30, 3);
        for (let i = 0; i < 10; i++) {
            h.timer.advance(50);
            h.mediaOutput!.advance(50);
        }
        expect(h.positions.length).toBeGreaterThan(0);
        expect(Math.min(...h.positions)).toBeGreaterThanOrEqual(0);
    });

    it('the-media-pre-roll-does-not-move-the-cursor-back', async () => {
        const h = new MediaSynthHarness();
        await h.loadSong();
        h.probeLatencies.set(0.5, 60);
        h.player.playbackSpeed = 0.5;
        h.player.timePosition = 10000;
        const start = h.player.timePosition;
        h.positions.length = 0;
        h.player.play();
        expect(h.positions.filter(p => p < start - 1)).toEqual([]);
        for (let i = 0; i < 10; i++) {
            h.timer.advance(50);
            h.mediaOutput!.advance(50);
        }
        expect(h.positions.length).toBeGreaterThan(0);
        expect(Math.min(...h.positions)).toBeGreaterThanOrEqual(start - 1);
    });

    it('pause-during-the-media-delay-cancels-the-media-start', async () => {
        // Review Focus 2
        const h = new MediaSynthHarness();
        await h.loadSong();
        h.player.controller.startLeads.set(1, 50);
        h.player.play();
        h.player.pause();
        h.timer.advance(100);
        expect(h.mediaOutput!.isPlaying).toBe(false);
        expect(h.states).toEqual(['Playing', 'Paused']);
    });

    it('a-seek-while-playing-restarts-without-state-change-or-count-in', async () => {
        const h = await playing(5000);
        h.player.countInVolume = 1;
        h.player.timePosition = 20000;
        expect(h.states).toEqual(['Playing']);
        expect(h.synth.calls[h.synth.calls.length - 1]).toBe('play:countIn=0');
        expect(h.synth.lastSeek()).toBeCloseTo(h.mediaOutput!.currentTime, 3);
        expect(h.mediaOutput!.isPlaying).toBe(true);
    });

    it('a-speed-change-while-playing-re-syncs', async () => {
        const h = await playing(5000);
        const seeks = h.synth.seeks.length;
        h.player.playbackSpeed = 0.75;
        expect(h.synth.seeks.length).toBe(seeks + 1);
        expect(h.synth.playbackSpeed).toBe(0.75);
        expect(h.player.controller.isSettling).toBe(true);
        // the new speed is probed next, after the measurement already running (1x)
        h.probe.resolveNext(0);
        await flush();
        expect(h.probe.requests).toEqual([1, 0.75]);
    });

    it('the-same-speed-again-changes-nothing', async () => {
        // apps feed the media's rate event back (YouTube's onPlaybackRateChange, the rhythm game's ratechange)
        const h = await playing(5000);
        h.player.playbackSpeed = 0.75;
        const synthSeeks = h.synth.seeks.length;
        const mediaSeeks = h.mediaOutput!.seekTimes.length;
        h.player.playbackSpeed = 0.75; // the echo
        expect(h.synth.seeks.length).toBe(synthSeeks); // no second re-sync: it cuts the synth's sounding notes
        expect(h.mediaOutput!.seekTimes.length).toBe(mediaSeeks); // no second seek of the media
    });

    it('a-probe-value-during-playback-settles', async () => {
        // Review Focus 3, F-9a (D-1)
        const h = await playing(5000);
        h.timer.advance(2000);
        expect(h.player.controller.isSettling).toBe(false);
        const seeks = h.synth.seeks.length;
        h.probe.resolveNext(3); // the background probe of 1x lands now
        await flush();
        expect(h.player.controller.isSettling).toBe(true);
        expect(h.synth.seeks.length).toBe(seeks);
    });

    it('stamps-reach-the-controller', async () => {
        const h = await playing(5000);
        h.timer.advance(2000);
        const seeks = h.synth.seeks.length;
        h.synthOutput.stamp(0, h.mediaOutput!.currentTime + 200);
        h.timer.advance(50);
        h.synthOutput.stamp(0, h.mediaOutput!.currentTime + 200);
        expect(h.synth.seeks.length).toBe(seeks + 1);
    });

    it('one-time-midi-pauses-both-and-leaves-follow-mode', async () => {
        const h = new MediaSynthHarness();
        const midi = await h.loadSong();
        h.mediaOutput!.currentTime = 5000;
        h.player.play();
        h.player.playOneTimeMidiFile(midi);
        expect(h.states[h.states.length - 1]).toBe('Paused');
        expect(h.synth.calls.slice(-2)).toEqual(['followMedia:false', 'playOneTimeMidiFile']);
        h.player.play();
        expect(h.synth.calls.slice(-4)).toEqual(['followMedia:true', 'pause', `seek:${h.synth.lastSeek()}`, 'play:countIn=0']);
    });

    it('the-song-end-stops-both-once', async () => {
        // Review Focus 1: the song ends at its last sync point (42004.7 ms); an 18 s outro after it is not played
        const h = await playing(41950);
        h.mediaOutput!.backingTrackDuration = 60000;
        h.mediaOutput!.advance(100);
        expect(h.finished).toBe(1);
        expect(h.states).toEqual(['Playing', 'Stopped']);
        expect(h.synth.count('stop')).toBeGreaterThan(0);
        expect(h.mediaOutput!.isPlaying).toBe(false);
    });

    it('a-recreated-player-keeps-the-learned-start-values', async () => {
        // alphaTab recreates the player on a playerMode change, or with EnabledAutomatic between a file with a
        // recording and one without; the browser hands each new player the page's learned values (Task 20)
        const learned = new MediaSyncLearnedValues();
        const first = new MediaSynthHarness(false, true, learned);
        await first.loadSong();
        first.mediaOutput!.currentTime = 5000;
        first.player.play();
        for (let i = 0; i < 3; i++) {
            first.timer.advance(50);
            first.mediaOutput!.advance(50);
            first.synthOutput.stamp(0, first.mediaOutput!.currentTime + 6); // the synth came out 6 ms ahead
        }
        expect(first.player.controller.startLeads.get(1)).toBe(-6);
        first.player.destroy();
        const second = new MediaSynthHarness(false, true, learned);
        expect(second.player.controller.startLeads.get(1)).toBe(-6);
    });

    it('destroy-clears-pending-timers', async () => {
        // Review Focus 5
        const h = new MediaSynthHarness();
        await h.loadSong();
        h.player.controller.startLeads.set(1, 50);
        h.player.play();
        h.player.destroy();
        h.timer.advance(100);
        expect(h.mediaOutput!.isPlaying).toBe(false);
        expect(h.timer.pending).toBe(0);
    });

    it('a-pause-while-the-media-seeks-cancels-the-start', async () => {
        const h = new MediaSynthHarness();
        await h.loadSong();
        h.mediaOutput!.currentTime = 5000;
        h.backingClock!.isSeeking = true; // the <audio> is still seeking when Play comes
        h.player.play();
        h.player.pause();
        h.backingClock!.finishSeek();
        expect(h.synth.count('play')).toBe(0);
        expect(h.mediaOutput!.isPlaying).toBe(false);
        expect(h.player.controller.isActive).toBe(false);
    });

    it('a-seek-while-the-media-seeks-runs-only-the-last-start', async () => {
        const h = new MediaSynthHarness();
        await h.loadSong();
        h.mediaOutput!.currentTime = 5000;
        h.backingClock!.isSeeking = true;
        h.player.play();
        h.player.timePosition = 20000;
        h.backingClock!.finishSeek();
        expect(h.synth.count('play')).toBe(1);
        expect(h.synth.seeks.length).toBe(1);
        expect(h.synth.lastSeek()).toBeCloseTo(h.mediaOutput!.currentTime, 3);
    });

    it('a-seek-while-paused-starts-nothing', async () => {
        const h = new MediaSynthHarness();
        await h.loadSong();
        const calls = h.synth.calls.length;
        h.player.timePosition = 10000;
        h.player.tickPosition = 1920;
        expect(h.synth.calls.slice(calls)).toEqual([]);
        expect(h.mediaOutput!.isPlaying).toBe(false);
        expect(h.states).toEqual([]);
    });

    it('a-start-at-1x-does-not-seek-the-media-again', async () => {
        const h = new MediaSynthHarness();
        await h.loadSong();
        h.mediaOutput!.currentTime = 5000;
        const seeks = h.mediaOutput!.seekTimes.length;
        h.player.play();
        expect(h.mediaOutput!.seekTimes.length).toBe(seeks);
    });

    it('a-stop-during-the-media-pre-roll-moves-the-cursor-to-the-start', async () => {
        const h = new MediaSynthHarness();
        await h.loadSong();
        h.probeLatencies.set(0.5, 60);
        h.player.playbackSpeed = 0.5;
        h.player.timePosition = 10000;
        h.player.play(); // the cursor is held at the start position
        h.positions.length = 0;
        h.player.stop();
        expect(h.positions[h.positions.length - 1]).toBe(0);
    });

    it('a-one-time-midi-in-the-media-only-fallback-pauses-and-is-dropped', async () => {
        // no synthesizer can play it, and the media player would pause itself, seek its <audio> to the song's start and
        // play it there with its silent synthesizer, none of it visible to the app
        const warning = vi.spyOn(Logger, 'warning').mockImplementation(() => {});
        const h = new MediaSynthHarness();
        const midi = await h.loadSong(false);
        h.synth.fail('alphaTab.worker.mjs: 404');
        warning.mockRestore();
        h.mediaOutput!.currentTime = 5000;
        h.player.play();
        h.mediaOutput!.advance(50);
        const position = h.player.timePosition;
        const seeks = h.mediaOutput!.seekTimes.length;
        const calls = h.synth.calls.length;
        h.player.playOneTimeMidiFile(midi);
        expect(h.states).toEqual(['Playing', 'Paused']);
        expect(h.mediaOutput!.isPlaying).toBe(false);
        expect(h.mediaOutput!.seekTimes.length).toBe(seeks); // the <audio> stays where it is
        expect(h.player.timePosition).toBe(position);
        expect(h.synth.calls.slice(calls).filter(c => c !== 'pause')).toEqual([]); // only the pause reaches the synth
        h.player.playOneTimeMidiFile(midi); // while Paused it changes nothing
        expect(h.states).toEqual(['Playing', 'Paused']);
        expect(h.mediaOutput!.seekTimes.length).toBe(seeks);
        expect(h.mediaOutput!.isPlaying).toBe(false);
        h.player.play(); // the next Play runs the media alone again
        expect(h.states).toEqual(['Playing', 'Paused', 'Playing']);
        expect(h.mediaOutput!.isPlaying).toBe(true);
    });

    it('a-soundfont-reload-while-playing-pauses-both', async () => {
        // loading a SoundFont pauses the synthesizer, and the app of a synth-only player sees Paused: the combined
        // player pauses both as well, instead of playing the media on with a silent synthesizer
        const h = await playing(5000);
        h.player.loadSoundFont(new Uint8Array(0), false);
        expect(h.states).toEqual(['Playing', 'Paused']);
        expect(h.mediaOutput!.isPlaying).toBe(false);
        expect(h.synth.state).toBe(PlayerState.Paused);
        expect(h.player.controller.isActive).toBe(false);
        expect(h.synth.calls.slice(-2)).toEqual(['pause', 'loadSoundFont']);
        h.synth.becomeReadyForPlayback(); // the worker has the SoundFont
        h.player.play();
        expect(h.synth.calls.slice(-4)).toEqual([
            'followMedia:true',
            'pause',
            `seek:${h.synth.lastSeek()}`,
            'play:countIn=0'
        ]);
        expect(h.synth.state).toBe(PlayerState.Playing);
        expect(h.mediaOutput!.isPlaying).toBe(true);
        expect(h.player.controller.isActive).toBe(true);
    });

    it('a-synth-failure-while-the-media-seeks-starts-the-media-alone', async () => {
        // the synthesizer is lost between Play and the end of the media's seek: only the media's half of the start runs
        const warning = vi.spyOn(Logger, 'warning').mockImplementation(() => {});
        const h = new MediaSynthHarness();
        await h.loadSong();
        h.mediaOutput!.currentTime = 5000;
        h.backingClock!.isSeeking = true; // the <audio> is still seeking when Play comes
        h.player.play();
        h.synth.fail('alphaTab.worker.mjs: 404');
        warning.mockRestore();
        const seeks = h.synth.seeks.length;
        h.backingClock!.finishSeek();
        expect(h.mediaOutput!.isPlaying).toBe(true);
        expect(h.synth.count('play')).toBe(0);
        expect(h.synth.seeks.length).toBe(seeks);
        expect(h.player.controller.isActive).toBe(false);
        expect(h.states).toEqual(['Playing']);
    });

    it('the-cursor-follows-the-media-once-the-pre-roll-is-over', async () => {
        // the hold ends with the first position the media plays: a later position below the start (a faster speed
        // halves the time units) is reported, not held back
        const h = new MediaSynthHarness();
        await h.loadSong();
        h.probeLatencies.set(0.5, 60);
        h.player.playbackSpeed = 0.5;
        h.player.timePosition = 10000;
        const start = h.player.timePosition;
        h.player.play();
        for (let i = 0; i < 10; i++) {
            h.timer.advance(50);
            h.mediaOutput!.advance(50);
        }
        h.positions.length = 0;
        h.player.playbackSpeed = 1;
        expect(h.positions.length).toBeGreaterThan(0);
        expect(h.positions[h.positions.length - 1]).toBeLessThan(start);
    });

    it('a-speed-change-while-the-media-seeks-starts-again-at-the-new-speed', async () => {
        // the start waits for the pre-roll seek, planned at 0.5x: the plan, the controller's speed and the start lead
        // it learns must be the new speed's, and the start stays where Play was pressed (not at the pre-roll start)
        const h = new MediaSynthHarness();
        await h.loadSong();
        h.player.playbackSpeed = 0.5;
        h.mediaOutput!.currentTime = 5000;
        h.backingClock!.isSeeking = true;
        h.player.play();
        h.player.playbackSpeed = 1;
        h.backingClock!.finishSeek();
        expect(h.player.controller.speed).toBe(1);
        expect(h.synth.count('play:')).toBe(1); // the first plan never ran
        expect(h.synth.lastSeek()).toBeCloseTo(5000, 3);
        expect(h.mediaOutput!.isPlaying).toBe(true);
        for (let i = 0; i < 3; i++) {
            h.timer.advance(50);
            h.mediaOutput!.advance(50);
            h.synthOutput.stamp(0, h.mediaOutput!.currentTime + 6); // the synth came out 6 ms ahead
        }
        expect(h.player.controller.startLeads.has(0.5)).toBe(false);
        expect(h.player.controller.startLeads.get(1)).toBe(-6);
    });

    it('a-speed-change-before-the-first-position-does-not-hold-the-cursor-back', async () => {
        // the hold is in the units of the speed it was set at (a faster speed halves them): the speed change drops it
        const h = new MediaSynthHarness();
        await h.loadSong();
        h.probeLatencies.set(0.5, 60);
        h.player.playbackSpeed = 0.5;
        h.player.timePosition = 10000;
        h.player.play();
        h.positions.length = 0;
        h.player.playbackSpeed = 1;
        for (let i = 0; i < 2; i++) {
            h.timer.advance(50);
            h.mediaOutput!.advance(50);
        }
        expect(h.positions.length).toBeGreaterThan(0);
    });

    it('a-seek-from-the-playing-handler-leaves-no-media-start-behind-a-pause', async () => {
        // play() reports Playing before it starts: a seek in the app's handler runs a full handshake, then Play runs its
        // own. The first one's media-delay timer must not start the media after the Pause
        const h = new MediaSynthHarness();
        await h.loadSong();
        h.player.controller.startLeads.set(1, 50);
        h.player.stateChanged.on(e => {
            if (e.state === PlayerState.Playing) {
                h.player.timePosition = 8000;
            }
        });
        h.player.play();
        h.player.pause();
        h.timer.advance(100);
        expect(h.mediaOutput!.isPlaying).toBe(false);
        expect(h.states).toEqual(['Playing', 'Paused']);
        expect(h.timer.pending).toBe(0);
    });

    it('a-seek-from-the-playing-handler-at-0-5x-starts-once-at-the-seek-target', async () => {
        // play() reports Playing before it starts: the app's seek in its handler starts playback first, and its
        // pre-roll seek moves the <audio> 60 ms before the target. The start Play makes supersedes it and begins at the
        // target, not at the position that pre-roll left (60 ms early, and 120 ms after its own pre-roll)
        const h = new MediaSynthHarness();
        await h.loadSong();
        h.player.playbackSpeed = 0.5;
        h.mediaOutput!.currentTime = 5000;
        h.player.stateChanged.on(e => {
            if (e.state === PlayerState.Playing) {
                h.backingClock!.isSeeking = true; // the <audio> seeks asynchronously
                h.player.timePosition = 8000; // media time 4000 at 0.5x
            }
        });
        h.player.play();
        h.backingClock!.finishSeek();
        expect(h.synth.count('play:')).toBe(1); // the seek's own start never ran
        expect(h.synth.lastSeek()).toBeCloseTo(4000 - 60, 3);
        expect(h.mediaOutput!.seekTimes[h.mediaOutput!.seekTimes.length - 1]).toBeCloseTo(4000 - 60, 3);
        expect(h.mediaOutput!.isPlaying).toBe(true);
    });
});
