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

    it('a-late-update-off-the-centre-does-not-tilt-the-line', () => {
        // The test above puts the late update at the centre of the updates, where its pairwise slopes cancel out (a
        // mean of them would pass too). Near the newest end they don't cancel: a mean slope would tilt the line by
        // about 10 ms per second and miss the true line by about 6 ms at 1.05 s. The median slope is not moved at all.
        const time = new FakeHeardTime();
        const clock = new ExternalMediaClock(time, () => 0);
        clock.setPlaying(true);
        // the true line is 5000 + 1000 * t; the update at 0.95 s reports its position 40 ms late
        feed(clock, time, 0, 1, t => 5000 + (Math.abs(t - 0.95) < 1e-6 ? t * 1000 - 40 : t * 1000));
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
        expect(clock.isFromBeforeJump(9000)).toBe(false); // the jump to 20000 is replaced
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

    /**
     * The media played up to 5300 (its last update, at 1 s) and paused at 1.03 s, 30 ms on.
     */
    function pausedAt5300(): { clock: ExternalMediaClock; time: FakeHeardTime } {
        const time = new FakeHeardTime();
        const clock = new ExternalMediaClock(time, () => 0);
        clock.setPlaying(true);
        feed(clock, time, 0, 1, t => 4300 + Math.round(t * 1000));
        time.heard = 1.03;
        clock.setPlaying(false);
        return { clock, time };
    }

    it('updates-from-before-a-paused-move-are-told-by-its-side', () => {
        // alphaTab moves the paused media back 300 ms (the API's move to the beat's start on Pause): until the media
        // shows the move it shows where it stopped, at or after its last update, which is within 500 ms of the target
        const { clock, time } = pausedAt5300();
        clock.notePausedPosition(5000);
        expect(clock.isFromBeforeJump(5300)).toBe(true);
        expect(clock.isFromBeforeJump(5320)).toBe(true);
        time.heard = 1.05;
        clock.addSample(5300);
        time.heard = 1.07;
        clock.addSample(5320);
        expect(clock.position).toBe(5000);
        expect(clock.isSeeking).toBe(true);
        expect(clock.isFromBeforeJump(5000)).toBe(false);
        time.heard = 1.1;
        clock.addSample(5000); // the media shows the move: the wait is over
        expect(clock.isSeeking).toBe(false);
        expect(clock.position).toBe(5000);
    });

    it('a-stale-update-inside-the-pause-settle-window-is-no-start-after-a-paused-move', () => {
        const { clock, time } = pausedAt5300();
        clock.notePausedPosition(5000);
        time.heard = 1.05;
        clock.addSample(5330); // where the media stopped: it has not applied the seek yet
        time.heard = 1.3;
        clock.addSample(5000); // now it has
        expect(clock.movedSincePause()).toBe(false);
    });

    it('a-paused-move-ends-the-pause-settle-window', () => {
        // a short move forward: where the media stopped (30 ms after its last update) is past the middle of the move,
        // so that update counts as after it; the paused position stays the target all the same
        const { clock, time } = pausedAt5300();
        clock.notePausedPosition(5350);
        time.heard = 1.05;
        clock.addSample(5330); // where the media stopped: it has not applied the seek yet
        time.heard = 1.15;
        clock.addSample(5350); // now it has
        expect(clock.movedSincePause()).toBe(false);
    });

    it('a-paused-move-still-waited-for-when-the-media-plays-goes-by-the-jump-tolerance', () => {
        // the playing media moves from the target toward and past where it was: the side of the move would drop its
        // fresh updates when they are sparse
        const { clock } = pausedAt5300();
        clock.notePausedPosition(5000);
        expect(clock.isFromBeforeJump(5250)).toBe(true); // paused: nearer where the media was
        clock.setPlaying(true);
        expect(clock.isFromBeforeJump(5250)).toBe(false); // within 500 ms of the target
        expect(clock.isFromBeforeJump(5600)).toBe(true);
    });

    it('two-paused-moves-in-a-row-wait-from-where-the-media-was-before-the-first', () => {
        // the API's move back to the beat's start (5000), then a click a little ahead (5500), before the media showed
        // either: it can still show where it stopped or the first move
        const { clock, time } = pausedAt5300();
        clock.notePausedPosition(5000);
        time.heard = 1.05;
        clock.notePausedPosition(5500);
        expect(clock.isFromBeforeJump(5300)).toBe(true);
        expect(clock.isFromBeforeJump(5000)).toBe(true);
        expect(clock.isFromBeforeJump(5500)).toBe(false);
        time.heard = 1.07;
        clock.addSample(5300);
        clock.addSample(5000);
        expect(clock.position).toBe(5500);
    });

    it('a-paused-move-to-where-the-media-already-is-holds-back-no-update', () => {
        // a move that doesn't move (a click on the beat the cursor is on, a Stop at the song's start while the media is
        // reported there): the first update ends the wait, and the media's own start right after it shows
        const { clock, time } = pausedAt5300();
        clock.notePausedPosition(5300);
        expect(clock.isSeeking).toBe(true);
        time.heard = 1.1;
        clock.addSample(5300);
        expect(clock.isSeeking).toBe(false);
        time.heard = 1.3;
        clock.addSample(5450); // play pressed inside the media
        expect(clock.position).toBe(5450);
        expect(clock.movedSincePause()).toBe(true);
    });

    it('a-paused-move-kept-across-a-play-and-pause-goes-by-its-side-again', () => {
        // Play and Pause before the media showed the move: once paused again the side of the move applies, from where the
        // media was before it, also after the pause notes the move it has not shown yet
        const { clock, time } = pausedAt5300();
        clock.notePausedPosition(5000);
        time.heard = 1.05;
        clock.setPlaying(true);
        expect(clock.isFromBeforeJump(5300)).toBe(false); // playing: within 500 ms of the target
        time.heard = 1.1;
        clock.setPlaying(false);
        expect(clock.isFromBeforeJump(5300)).toBe(true);
        expect(clock.isFromBeforeJump(5000)).toBe(false);
        clock.notePausedPosition(5000);
        expect(clock.isFromBeforeJump(5300)).toBe(true);
        expect(clock.isFromBeforeJump(5320)).toBe(true);
        expect(clock.isFromBeforeJump(5000)).toBe(false);
    });

    it('a-paused-move-before-the-first-update-goes-by-the-jump-tolerance', () => {
        // no update yet: there is no old position to tell the side of the move from
        const time = new FakeHeardTime();
        const clock = new ExternalMediaClock(time, () => 0);
        time.heard = 1;
        clock.notePausedPosition(5000);
        expect(clock.isSeeking).toBe(true);
        expect(clock.isFromBeforeJump(5400)).toBe(false);
        expect(clock.isFromBeforeJump(5600)).toBe(true);
        time.heard = 1.05;
        clock.setPlaying(true);
        time.heard = 1.1;
        clock.setPlaying(false);
        expect(clock.isFromBeforeJump(5400)).toBe(false);
        expect(clock.isFromBeforeJump(5600)).toBe(true);
    });

    it('a-paused-move-given-up-does-not-keep-where-the-media-was', () => {
        // the media did not show the first move within JumpWaitMaxS, across a Play and Pause: the next move goes from
        // where the clock shows the media now, not from where it was before the first
        const { clock, time } = pausedAt5300();
        clock.notePausedPosition(5000);
        time.heard = 1.05;
        clock.setPlaying(true);
        time.heard = 2.5;
        clock.setPlaying(false);
        clock.notePausedPosition(5500);
        expect(clock.isFromBeforeJump(5000)).toBe(true);
        expect(clock.isFromBeforeJump(5300)).toBe(false); // nearer the target than 5000
    });

    it('a-jump-while-playing-keeps-the-jump-tolerance', () => {
        // the playing media moves toward where it was: within 500 ms of the target an update counts, also once the
        // media is paused before it showed the jump
        const time = new FakeHeardTime();
        const clock = new ExternalMediaClock(time, () => 0);
        clock.setPlaying(true);
        feed(clock, time, 0, 1, t => 4300 + Math.round(t * 1000)); // the last update: 5300
        clock.expectJumpTo(5000);
        expect(clock.isFromBeforeJump(5320)).toBe(false); // nearer where the media was, within 500 ms of the target
        expect(clock.isFromBeforeJump(5600)).toBe(true);
        time.heard = 1.03;
        clock.setPlaying(false);
        expect(clock.isFromBeforeJump(5320)).toBe(false);
        expect(clock.isFromBeforeJump(5600)).toBe(true);
    });
});
