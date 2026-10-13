/**
 * The media clocks (spec §6.3).
 * @target web
 */
import { describe, expect, it } from 'vitest';
import {
    BackingTrackMediaClock,
    ExternalMediaClock,
    type IBackingTrackClockSource,
    type IExternalClockSource
} from '@coderline/alphatab/platform/javascript/MediaClock';
import { PerSpeedValues } from '@coderline/alphatab/platform/javascript/PerSpeedValues';

class FakeElementSource implements IBackingTrackClockSource {
    public mediaCurrentTime: number = 10; // s
    public mediaPaused: boolean = false;
    public mediaSeeking: boolean = false;
    public contextTime: number = 2; // s
    public sampleRate: number = 48000;
    private _seeked: (() => void)[] = [];
    public onceSeeked(action: () => void): void {
        this._seeked.push(action);
    }
    public finishSeek(): void {
        this.mediaSeeking = false;
        for (const action of this._seeked.splice(0)) {
            action();
        }
    }
}

class FakeHeardTime implements IExternalClockSource {
    public heard: number = 0; // s
    public sampleRate: number = 48000;
    public heardContextTime(): number {
        return this.heard;
    }
}

describe('BackingTrackMediaClockTests', () => {
    it('media-time-at-a-frame', () => {
        const source = new FakeElementSource();
        const clock = new BackingTrackMediaClock(source, new PerSpeedValues(), () => 0);
        // the frame 0.1 s before the context's current time, at 1x
        expect(clock.mediaTimeAt((2 - 0.1) * 48000)).toBeCloseTo(10000 - 100, 9);
        clock.speed = 0.5;
        expect(clock.mediaTimeAt((2 - 0.1) * 48000)).toBeCloseTo(10000 - 50, 9);
        expect(clock.mediaTimeNow()).toBeCloseTo(10000, 9);
    });

    it('adds-the-latency-times-the-speed', () => {
        const latencies = new PerSpeedValues();
        latencies.set(0.5, 60);
        const clock = new BackingTrackMediaClock(new FakeElementSource(), latencies, () => 0);
        clock.speed = 0.5;
        expect(clock.mediaTimeNow()).toBeCloseTo(10000 + 30, 9);
    });

    it('subtracts-the-offset-times-the-speed', () => {
        // F-11: + = the synth plays later; ms of real time at any speed
        let offset = 20;
        const clock = new BackingTrackMediaClock(new FakeElementSource(), new PerSpeedValues(), () => offset);
        expect(clock.mediaTimeNow()).toBeCloseTo(10000 - 20, 9);
        clock.speed = 2;
        expect(clock.mediaTimeNow()).toBeCloseTo(10000 - 40, 9);
        offset = -10;
        expect(clock.mediaTimeNow()).toBeCloseTo(10000 + 20, 9);
    });

    it('no-time-while-paused-or-seeking', () => {
        const source = new FakeElementSource();
        const clock = new BackingTrackMediaClock(source, new PerSpeedValues(), () => 0);
        source.mediaPaused = true;
        expect(clock.mediaTimeNow()).toBeNaN();
        source.mediaPaused = false;
        source.mediaSeeking = true;
        expect(clock.mediaTimeNow()).toBeNaN();
        expect(clock.isSeeking).toBe(true);
        expect(clock.position).toBe(10000);
    });

    it('when-seeked-runs-now-or-after-the-seek', () => {
        const source = new FakeElementSource();
        const clock = new BackingTrackMediaClock(source, new PerSpeedValues(), () => 0);
        const ran: string[] = [];
        clock.whenSeeked(() => ran.push('now'));
        source.mediaSeeking = true;
        clock.whenSeeked(() => ran.push('later'));
        expect(ran).toEqual(['now']);
        source.finishSeek();
        expect(ran).toEqual(['now', 'later']);
    });
});

describe('ExternalMediaClockTests', () => {
    function feed(
        clock: ExternalMediaClock,
        time: FakeHeardTime,
        from: number,
        to: number,
        position: (t: number) => number
    ) {
        for (let t = from; t <= to + 1e-9; t += 0.05) {
            time.heard = t;
            clock.addSample(position(t));
        }
    }

    it('fits-a-line-that-one-late-update-does-not-bend', () => {
        const time = new FakeHeardTime();
        const clock = new ExternalMediaClock(time, () => 0);
        clock.setPlaying(true);
        feed(clock, time, 0, 1, t => 5000 + (Math.abs(t - 0.5) < 1e-6 ? t * 1000 - 40 : t * 1000));
        expect(clock.mediaTimeAt(1.05 * 48000)).toBeCloseTo(5000 + 1050, 0);
    });

    it('no-time-before-three-samples-over-100-ms', () => {
        const time = new FakeHeardTime();
        const clock = new ExternalMediaClock(time, () => 0);
        clock.setPlaying(true);
        feed(clock, time, 0, 0.05, t => t * 1000);
        expect(clock.mediaTimeNow()).toBeNaN();
        feed(clock, time, 0.1, 0.1, t => t * 1000);
        expect(clock.mediaTimeNow()).toBeCloseTo(100, 6);
    });

    it('no-time-while-the-media-does-not-move', () => {
        const time = new FakeHeardTime();
        const clock = new ExternalMediaClock(time, () => 0);
        clock.setPlaying(true);
        feed(clock, time, 0, 0.5, () => 3000); // play() issued, the video hasn't started yet
        expect(clock.mediaTimeNow()).toBeNaN();
        expect(clock.isStalled).toBe(false); // no stall before it has moved
    });

    it('a-stall-is-the-same-position-for-100-ms-after-moving', () => {
        // F-17
        const time = new FakeHeardTime();
        const clock = new ExternalMediaClock(time, () => 0);
        clock.setPlaying(true);
        // whole milliseconds: `t += 0.05` accumulates float error (the ramp would end at 1000.0000000000002)
        feed(clock, time, 0, 1, t => Math.round(t * 1000));
        expect(clock.isStalled).toBe(false);
        feed(clock, time, 1.05, 1.15, () => 1000); // frozen since t = 1: 150 ms, clear of the 100 ms limit
        expect(clock.isStalled).toBe(true);
        expect(clock.mediaTimeNow()).toBeNaN();
        time.heard = 1.2;
        clock.addSample(1050);
        expect(clock.isStalled).toBe(false);
    });

    it('subtracts-the-offset-times-the-speed', () => {
        const time = new FakeHeardTime();
        const clock = new ExternalMediaClock(time, () => 20);
        clock.speed = 2;
        clock.setPlaying(true);
        feed(clock, time, 0, 1, t => t * 2000);
        expect(clock.mediaTimeAt(1 * 48000)).toBeCloseTo(2000 - 40, 6);
    });

    it('moved-since-pause-tells-a-start-inside-the-media', () => {
        // F-6
        const time = new FakeHeardTime();
        const clock = new ExternalMediaClock(time, () => 0);
        time.heard = 1;
        clock.addSample(1000); // paused at 1000
        expect(clock.movedSincePause()).toBe(false);
        time.heard = 1.3;
        clock.addSample(1220); // the user pressed play in the video: it reached the app ~220 ms later
        expect(clock.movedSincePause()).toBe(true);
        time.heard = 1.5; // 200 ms later the update is too old to tell
        expect(clock.movedSincePause()).toBe(false);
    });

    it('a-seek-while-paused-is-not-a-start', () => {
        const time = new FakeHeardTime();
        const clock = new ExternalMediaClock(time, () => 0);
        time.heard = 1;
        clock.addSample(1000);
        clock.notePausedPosition(9000); // alphaTab seeked the paused media
        time.heard = 1.05;
        clock.addSample(9000);
        expect(clock.movedSincePause()).toBe(false);
    });

    it('a-seek-while-paused-moves-the-position', () => {
        // the integration reports positions only while the media plays
        const time = new FakeHeardTime();
        const clock = new ExternalMediaClock(time, () => 0);
        time.heard = 1;
        clock.addSample(1000);
        clock.expectJumpTo(20000); // a seek while playing, paused before an update showed it
        clock.notePausedPosition(9000); // a seek while paused; no update follows
        expect(clock.position).toBe(9000);
        expect(clock.isSeeking).toBe(false);
        expect(clock.movedSincePause()).toBe(false);
    });

    it('updates-right-after-a-pause-show-where-the-media-stopped', () => {
        // the media stops up to one update after the pause: an integration that keeps reporting while paused shows a
        // later position than the update before the pause, and that is not a start inside the media
        const time = new FakeHeardTime();
        const clock = new ExternalMediaClock(time, () => 0);
        clock.setPlaying(true);
        feed(clock, time, 0, 1, t => t * 1000); // the last update: 1000
        time.heard = 1.03;
        clock.setPlaying(false); // the media stops at 1030
        feed(clock, time, 1.05, 3, () => 1030);
        expect(clock.movedSincePause()).toBe(false);
        time.heard = 3.3;
        clock.addSample(1250); // play pressed inside the media
        expect(clock.movedSincePause()).toBe(true);
    });

    it('expect-jump-ignores-updates-from-before-the-seek', () => {
        const time = new FakeHeardTime();
        const clock = new ExternalMediaClock(time, () => 0);
        clock.setPlaying(true);
        feed(clock, time, 0, 1, t => t * 1000);
        clock.expectJumpTo(20000);
        expect(clock.isSeeking).toBe(true);
        feed(clock, time, 1.05, 1.1, t => t * 1000); // still the old position
        expect(clock.isSeeking).toBe(true);
        feed(clock, time, 1.15, 1.3, t => 20000 + (t - 1.15) * 1000);
        expect(clock.isSeeking).toBe(false);
        expect(clock.mediaTimeAt(1.3 * 48000)).toBeCloseTo(20150, 6);
    });

    it('a-seek-the-media-never-shows-is-given-up-after-a-second', () => {
        const time = new FakeHeardTime();
        const clock = new ExternalMediaClock(time, () => 0);
        clock.setPlaying(true);
        feed(clock, time, 0, 1, t => t * 1000);
        clock.expectJumpTo(20000);
        expect(clock.isFromBeforeJump(1100)).toBe(true);
        expect(clock.isFromBeforeJump(20100)).toBe(false);
        feed(clock, time, 1.05, 1.9, t => t * 1000); // the media didn't go there: still its old positions
        expect(clock.isSeeking).toBe(true);
        feed(clock, time, 2.1, 2.4, t => t * 1000);
        expect(clock.isSeeking).toBe(false); // given up: the media's own position counts again
        expect(clock.mediaTimeAt(2.4 * 48000)).toBeCloseTo(2400, 6);
    });
});
