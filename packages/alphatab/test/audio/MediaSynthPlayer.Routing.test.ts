/**
 * The combined player: routing, readiness, the media-only fallback, volumes, output, probe schedule (spec §6.1).
 * @target web
 */
import { describe, expect, it, vi } from 'vitest';
import type { EventEmitterOfT } from '@coderline/alphatab/EventEmitter';
import { Logger } from '@coderline/alphatab/Logger';
import type { IExternalMediaSynthOutput } from '@coderline/alphatab/synth/ExternalMediaPlayer';
import { MidiEventsPlayedEventArgs } from '@coderline/alphatab/synth/MidiEventsPlayedEventArgs';
import { PlayerState } from '@coderline/alphatab/synth/PlayerState';
import { PlayerStateChangedEventArgs } from '@coderline/alphatab/synth/PlayerStateChangedEventArgs';
import { PositionChangedEventArgs } from '@coderline/alphatab/synth/PositionChangedEventArgs';
import { flush, MediaSynthHarness } from 'test/audio/MediaSyncFakes';

describe('MediaSynthPlayerRoutingTests', () => {
    it('routes-the-media-and-the-synth-events', async () => {
        const h = new MediaSynthHarness();
        await h.loadSong();
        (h.synth.positionChanged as EventEmitterOfT<PositionChangedEventArgs>).trigger(
            new PositionChangedEventArgs(999, 0, 0, 0, false, 120, 120)
        );
        expect(h.positions).not.toContain(999);
        h.player.timePosition = 1000;
        expect(h.positions[h.positions.length - 1]).toBeCloseTo(1000, 6);

        let played = 0;
        h.player.midiEventsPlayed.on(() => played++);
        (h.synth.midiEventsPlayed as EventEmitterOfT<MidiEventsPlayedEventArgs>).trigger(new MidiEventsPlayedEventArgs([]));
        expect(played).toBe(1);
    });

    it('the-inner-players-states-never-reach-the-app', async () => {
        const h = new MediaSynthHarness();
        await h.loadSong();
        (h.synth.stateChanged as EventEmitterOfT<PlayerStateChangedEventArgs>).trigger(
            new PlayerStateChangedEventArgs(PlayerState.Playing, false)
        );
        h.media.play();
        h.media.pause();
        expect(h.states).toEqual([]);
    });

    it('ready-waits-for-both-and-fires-once', () => {
        const h = new MediaSynthHarness();
        let ready = 0;
        h.player.ready.on(() => ready++);
        expect(h.player.isReady).toBe(false);
        expect(ready).toBe(0);
        h.synth.becomeReady();
        expect(ready).toBe(1);
        h.synth.becomeReady();
        expect(ready).toBe(1);
    });

    it('ready-for-playback-warms-up-the-worklet-and-starts-the-probe', async () => {
        const h = new MediaSynthHarness();
        await h.loadSong(false);
        h.synth.becomeReady();
        expect(h.player.isReadyForPlayback).toBe(false); // waiting for the SoundFont, as in synth mode
        h.synth.becomeReadyForPlayback();
        expect(h.player.isReadyForPlayback).toBe(true);
        expect(h.synthOutput.keepAlive).toBe(true);
        expect(h.synthOutput.warmUps).toBe(1);
        expect(h.probe.requests).toEqual([1]);
    });

    it('ready-for-playback-fires-once-per-song-after-the-synth-has-it', async () => {
        // The worker's API raises readyForPlayback on midiLoaded and again on readyForPlayback, and never clears its
        // flag: synth-only mode fires it twice per song from the second one on, backing-track mode once. The combined
        // player fires it once per song, and not before the synthesizer has the song.
        const h = new MediaSynthHarness();
        let ready = 0;
        h.player.readyForPlayback.on(() => {
            ready++;
            h.synth.calls.push('readyForPlayback');
        });
        await h.loadSong(false);
        h.synth.becomeReady();
        expect(ready).toBe(0); // the media has the song, the synth does not
        h.synth.becomeReadyForPlayback();
        expect(ready).toBe(1);

        await h.loadSong(false); // the next song: the fake raises it on midiLoaded as the worker's API does ...
        h.synth.becomeReadyForPlayback(); // ... and again on readyForPlayback
        expect(h.player.isReadyForPlayback).toBe(true);
        expect(ready).toBe(2);
        const calls = h.synth.calls;
        expect(calls.lastIndexOf('loadMidiFile')).toBeLessThan(calls.lastIndexOf('readyForPlayback')); // not before
    });

    it('a-later-song-does-not-warm-up-or-probe-again', async () => {
        // neither raise for a later song starts the background probe again: it would measure a speed that failed
        // before its next use (§6.4)
        const warning = vi.spyOn(Logger, 'warning').mockImplementation(() => {});
        const h = new MediaSynthHarness();
        await h.loadSong();
        h.probe.rejectNext(new Error('NotAllowedError')); // 1x fails and stays unmeasured
        await flush();
        for (let i = 0; i < 4; i++) {
            h.probe.resolveNext(0); // 0.5, 0.75, 1.25, 1.5
            await flush();
        }
        warning.mockRestore();
        expect(h.probe.requests).toEqual([1, 0.5, 0.75, 1.25, 1.5]);

        await h.loadSong(); // the next song
        expect(h.synthOutput.warmUps).toBe(1);
        expect(h.probe.requests).toEqual([1, 0.5, 0.75, 1.25, 1.5]);
    });

    it('a-soundfont-reload-while-a-song-is-loaded-fires-ready-for-playback-once', async () => {
        // the app re-sends the channel volumes on readyForPlayback: a (re)loaded SoundFont gets one, no new warm-up
        const h = new MediaSynthHarness();
        let ready = 0;
        h.player.readyForPlayback.on(() => ready++);
        await h.loadSong();
        expect(ready).toBe(1);
        h.player.loadSoundFont(new Uint8Array(0), false);
        expect(h.player.isReadyForPlayback).toBe(false); // until the worker has the SoundFont
        h.synth.becomeReadyForPlayback(); // the worker raises it once for a SoundFont
        expect(h.player.isReadyForPlayback).toBe(true);
        expect(ready).toBe(2);
        expect(h.synthOutput.warmUps).toBe(1);
    });

    it('a-soundfont-after-a-soundfont-failure-brings-the-synth-back', async () => {
        // the synth was ready before the failure: in the fallback its raise is not "already ready", it joins
        const warning = vi.spyOn(Logger, 'warning').mockImplementation(() => {});
        const h = new MediaSynthHarness();
        let ready = 0;
        h.player.readyForPlayback.on(() => ready++);
        await h.loadSong();
        (h.player.soundFontLoadFailed as EventEmitterOfT<Error>).trigger(new Error('connection refused'));
        warning.mockRestore();
        expect(ready).toBe(1); // the media was ready for this song already
        h.player.loadSoundFont(new Uint8Array(0), false);
        h.synth.becomeReadyForPlayback();
        expect(ready).toBe(2);
        expect(h.synthOutput.warmUps).toBe(1);
    });

    it('in-the-media-only-fallback-each-song-is-ready-with-the-media', async () => {
        // readiness follows the media alone there: no wait for a synthesizer that is gone
        const warning = vi.spyOn(Logger, 'warning').mockImplementation(() => {});
        const h = new MediaSynthHarness();
        let ready = 0;
        h.player.readyForPlayback.on(() => ready++);
        await h.loadSong(false);
        h.synth.fail('alphaTab.worker.mjs: 404');
        warning.mockRestore();
        expect(ready).toBe(1);
        await h.loadSong(false);
        expect(h.player.isReadyForPlayback).toBe(true);
        expect(ready).toBe(2);
    });

    it('probe-waits-for-a-running-context', async () => {
        // Review Focus 3: the autoplay policy keeps the context suspended until a gesture
        const h = new MediaSynthHarness();
        h.graph.running = false;
        await h.loadSong();
        expect(h.probe.requests).toEqual([]);
        h.graph.start();
        expect(h.probe.requests).toEqual([1]);
    });

    it('probe-measures-the-background-speeds-in-turn', async () => {
        const h = new MediaSynthHarness();
        await h.loadSong();
        const values: [number, number][] = [
            [1, 0],
            [0.5, 60],
            [0.75, 27],
            [1.25, -4],
            [1.5, -4]
        ];
        for (const [speed, value] of values) {
            expect(h.probe.requests[h.probe.requests.length - 1]).toBe(speed);
            h.probe.resolveNext(value);
            await flush();
        }
        expect(h.probeLatencies.get(0.5)).toBe(60);
        expect(h.probe.requests.length).toBe(5);
        expect(h.player.diagnostics.probes.map(p => p.speed)).toEqual([1, 0.5, 0.75, 1.25, 1.5]);
    });

    it('a-failed-probe-stays-unmeasured-and-is-measured-again', async () => {
        // WebKit may refuse or never load the hidden <audio>: that is not a measured 0 (§6.4)
        const h = new MediaSynthHarness();
        await h.loadSong();
        h.probe.rejectNext(new Error('NotAllowedError'));
        await flush();
        expect(h.probeLatencies.has(1)).toBe(false);
        expect(h.probe.requests).toEqual([1, 0.5]); // the next speed is measured
        h.player.play(); // the next use of 1x measures it again
        expect(h.probe.requests).toEqual([1, 0.5]); // after the measurement already running
        h.probe.resolveNext(60);
        await flush();
        expect(h.probe.requests).toEqual([1, 0.5, 1]);
    });

    it('a-speed-without-a-value-is-probed-next', async () => {
        const h = new MediaSynthHarness();
        await h.loadSong();
        h.player.playbackSpeed = 0.875;
        h.probe.resolveNext(0);
        await flush();
        expect(h.probe.requests).toEqual([1, 0.875]);
    });

    it('no-soundfont-plays-the-media-alone-until-one-is-loaded', async () => {
        // FYI-4, spike 10 §6; the warning says why the metronome is silent (§6.1)
        const warning = vi.spyOn(Logger, 'warning');
        const h = new MediaSynthHarness(false, false);
        expect(warning.mock.calls.some(c => String(c[1]).startsWith('No player.soundFont is set'))).toBe(true);
        warning.mockRestore();
        await h.loadSong(false);
        h.synth.becomeReady();
        expect(h.player.isReadyForPlayback).toBe(true);
        expect(h.synthOutput.warmUps).toBe(0);
        h.synth.becomeReadyForPlayback(); // api.loadSoundFont() reached the synth
        expect(h.synthOutput.warmUps).toBe(1);
        expect(h.probe.requests).toEqual([1]);
    });

    it('a-failing-worker-falls-back-to-the-media-alone', async () => {
        // F-8, spike 10 §1
        const h = new MediaSynthHarness();
        await h.loadSong(false);
        h.synth.fail('alphaTab.worker.mjs: 404');
        expect(h.player.isReady).toBe(true);
        expect(h.player.isReadyForPlayback).toBe(true);
        h.player.play();
        expect(h.mediaOutput!.isPlaying).toBe(true);
        expect(h.synth.count('play')).toBe(0);
    });

    it('a-failing-worklet-falls-back-to-the-media-alone', async () => {
        // F-8, spike 10 §2
        const h = new MediaSynthHarness();
        await h.loadSong(false);
        h.synth.becomeReady();
        h.synthOutput.fail('Audio Worklet operation failed');
        expect(h.player.isReadyForPlayback).toBe(true);
    });

    it('a-failed-soundfont-download-falls-back-to-the-media-alone', async () => {
        // F-8, spike 10 §3: raised on the instance by AlphaTabApi.loadSoundFontFromUrl
        const h = new MediaSynthHarness();
        await h.loadSong(false);
        h.synth.becomeReady();
        (h.player.soundFontLoadFailed as EventEmitterOfT<Error>).trigger(new Error('connection refused'));
        expect(h.player.isReadyForPlayback).toBe(true);
        h.synth.becomeReadyForPlayback(); // a later SoundFont works: mixing again
        expect(h.synthOutput.warmUps).toBe(1);
    });

    it('a-worker-failure-after-a-soundfont-failure-is-permanent', async () => {
        // a SoundFont loaded later ends a fallback that a SoundFont caused, not one that the worker caused
        const warning = vi.spyOn(Logger, 'warning').mockImplementation(() => {});
        const h = new MediaSynthHarness();
        let ready = 0;
        h.player.readyForPlayback.on(() => ready++);
        await h.loadSong(false);
        h.synth.becomeReady();
        (h.player.soundFontLoadFailed as EventEmitterOfT<Error>).trigger(new Error('connection refused'));
        h.synth.fail('alphaTab.worker.mjs: 404');
        h.synth.becomeReadyForPlayback(); // a good SoundFont reaches the worker anyway
        warning.mockRestore();
        expect(h.player.isReadyForPlayback).toBe(true);
        expect(ready).toBe(1); // once for the song, when the SoundFont failure made the media ready
        expect(h.synthOutput.warmUps).toBe(0);
        expect(h.probe.requests).toEqual([]);
        h.player.play();
        expect(h.mediaOutput!.isPlaying).toBe(true);
        expect(h.synth.count('play')).toBe(0);
    });

    it('a-worklet-failure-after-a-soundfont-failure-is-permanent', async () => {
        const warning = vi.spyOn(Logger, 'warning').mockImplementation(() => {});
        const h = new MediaSynthHarness();
        await h.loadSong(false);
        h.synth.becomeReady();
        (h.player.soundFontLoadFailed as EventEmitterOfT<Error>).trigger(new Error('connection refused'));
        h.synthOutput.fail('Audio Worklet operation failed');
        h.synth.becomeReadyForPlayback();
        warning.mockRestore();
        expect(h.player.isReadyForPlayback).toBe(true);
        expect(h.synthOutput.warmUps).toBe(0);
        expect(h.probe.requests).toEqual([]);
    });

    it('a-soundfont-failure-after-a-worker-failure-changes-nothing', async () => {
        const warning = vi.spyOn(Logger, 'warning').mockImplementation(() => {});
        const h = new MediaSynthHarness();
        await h.loadSong(false);
        h.synth.becomeReady();
        h.synth.fail('alphaTab.worker.mjs: 404');
        (h.player.soundFontLoadFailed as EventEmitterOfT<Error>).trigger(new Error('connection refused'));
        h.synth.becomeReadyForPlayback();
        warning.mockRestore();
        expect(h.player.isReadyForPlayback).toBe(true);
        expect(h.synthOutput.warmUps).toBe(0);
        expect(h.probe.requests).toEqual([]);
    });

    it('volumes-go-to-the-gains', async () => {
        const h = new MediaSynthHarness();
        await h.loadSong();
        h.player.masterVolume = 0.8;
        h.player.backingTrackVolume = 0.35;
        h.player.synthVolume = 2;
        expect(h.graph.masterGain).toBeCloseTo(0.8, 9);
        expect(h.graph.mediaGain).toBeCloseTo(0.35, 9);
        expect(h.graph.synthGain).toBe(2);
        expect(h.mediaOutput!.masterVolume).toBe(1); // the <audio> stays at full volume
    });

    it('external-media-gets-master-volume-alone', async () => {
        const h = new MediaSynthHarness(true);
        await h.loadSong();
        h.player.masterVolume = 0.8;
        h.player.backingTrackVolume = 0.35;
        expect(h.handler!.masterVolume).toBeCloseTo(0.8, 9);
        expect(h.graph.mediaGain).toBe(1);
        expect(h.graph.masterGain).toBeCloseTo(0.8, 9); // the synth, through masterGain
    });

    it('output-passes-the-media-members-through', async () => {
        const h = new MediaSynthHarness(true);
        await h.loadSong();
        const output = h.player.output as IExternalMediaSynthOutput;
        expect(output.handler).toBe(h.handler);
        const times: number[] = [];
        output.timeUpdate.on(t => times.push(t));
        output.updatePosition(1234);
        expect(times).toEqual([1234]);
        expect(await output.enumerateOutputDevices()).toEqual([]); // the synth output's (TestOutput)
    });
});
