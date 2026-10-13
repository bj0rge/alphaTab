/**
 * A value per playback speed (a start lead, a media-start latency, a media latency). A speed without a value of
 * its own gets a straight-line guess between the nearest speeds that have one; outside them, the nearest value;
 * with none, 0 (spec §6.4, F-9a).
 * @target web
 * @internal
 */
export class PerSpeedValues {
    private _values: Map<number, number> = new Map<number, number>();

    /**
     * Speeds are keyed to 4 decimals: 1-BPM steps (about 0.007x) stay apart, float noise doesn't.
     */
    public static key(speed: number): number {
        return Math.round(speed * 10000) / 10000;
    }

    public get size(): number {
        return this._values.size;
    }

    public has(speed: number): boolean {
        return this._values.has(PerSpeedValues.key(speed));
    }

    public set(speed: number, value: number): void {
        this._values.set(PerSpeedValues.key(speed), value);
    }

    public delete(speed: number): void {
        this._values.delete(PerSpeedValues.key(speed));
    }

    public get(speed: number): number {
        const key = PerSpeedValues.key(speed);
        const own = this._values.get(key);
        if (own !== undefined) {
            return own;
        }
        if (this._values.size === 0) {
            return 0;
        }
        const speeds = Array.from(this._values.keys()).sort((a, b) => a - b);
        if (key <= speeds[0]) {
            return this._values.get(speeds[0])!;
        }
        const last = speeds[speeds.length - 1];
        if (key >= last) {
            return this._values.get(last)!;
        }
        let i = 0;
        while (speeds[i + 1] < key) {
            i++;
        }
        const a = speeds[i];
        const b = speeds[i + 1];
        const valueA = this._values.get(a)!;
        const valueB = this._values.get(b)!;
        return valueA + ((key - a) / (b - a)) * (valueB - valueA);
    }

    /**
     * The values by speed, rounded to 0.1 (diagnostics).
     */
    public toRecord(): Record<string, number> {
        const record: Record<string, number> = {};
        for (const [speed, value] of this._values) {
            record[String(speed)] = Math.round(value * 10) / 10;
        }
        return record;
    }
}
