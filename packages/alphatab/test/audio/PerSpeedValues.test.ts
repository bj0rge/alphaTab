/**
 * @target web
 */
import { describe, expect, it } from 'vitest';
import { PerSpeedValues } from '@coderline/alphatab/platform/javascript/PerSpeedValues';

describe('PerSpeedValuesTests', () => {
    it('nothing-learned-is-0', () => {
        expect(new PerSpeedValues().get(0.8)).toBe(0);
    });

    it('a-speed-own-value-wins', () => {
        const values = new PerSpeedValues();
        values.set(0.5, -36);
        values.set(1, 5.7);
        expect(values.get(0.5)).toBe(-36);
    });

    it('straight-line-between-learned-speeds', () => {
        // spike 11 §2: learned start leads 0.5x -36, 0.75x -25.4, 1x +5.7 ms
        const values = new PerSpeedValues();
        values.set(0.5, -36);
        values.set(0.75, -25.4);
        values.set(1, 5.7);
        expect(values.get(0.625)).toBeCloseTo(-30.7, 6);
        expect(values.get(0.875)).toBeCloseTo(-9.85, 6);
    });

    it('nearest-value-outside-the-learned-speeds', () => {
        const values = new PerSpeedValues();
        values.set(0.5, -36);
        values.set(1, 5.7);
        expect(values.get(0.25)).toBe(-36);
        expect(values.get(1.5)).toBe(5.7);
    });

    it('guess-stays-within-spike-5-error-for-probe-values', () => {
        // spec §6.4: probe values 1x 0, 0.5x 60, 0.75x 27, 1.25x -4, 1.5x -4 ms; measured at unprobed speeds
        const values = new PerSpeedValues();
        values.set(1, 0);
        values.set(0.5, 60);
        values.set(0.75, 27);
        values.set(1.25, -4);
        values.set(1.5, -4);
        const measured: [number, number][] = [
            [0.6, 54],
            [0.83, 20],
            [0.9, 18],
            [1.1, -4]
        ];
        for (const [speed, latency] of measured) {
            expect(Math.abs(values.get(speed) - latency)).toBeLessThanOrEqual(7.3);
        }
    });

    it('speed-keys-ignore-float-noise', () => {
        const values = new PerSpeedValues();
        values.set(0.1 + 0.2, 5);
        expect(values.has(0.3)).toBe(true);
        expect(values.get(0.3)).toBe(5);
        values.delete(0.3);
        expect(values.size).toBe(0);
    });
});
