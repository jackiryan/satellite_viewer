/* simClock.js - the simulation time shared by the main thread and the satellite workers
 *
 * The simulation time is computed from the wall clock rather than accumulated frame by frame:
 *     simulation time = simMs + (Date.now() - wallMs) * speed
 * The anchor (wallMs, simMs, speed) only moves when the speed changes or the time jumps, so the
 * time cannot drift while the tab is hidden, the frame rate drops, or the workers' timers are
 * throttled. The main thread owns the clock and posts its anchor to the workers, which evaluate
 * the same formula, so the satellites stay in step with the Earth.
 */

export function simTimeAt(anchor, wallMs = Date.now()) {
    return anchor.simMs + (wallMs - anchor.wallMs) * anchor.speed;
}

export class SimClock {
    constructor(startDate = new Date()) {
        this.anchor = { wallMs: Date.now(), simMs: startDate.getTime(), speed: 1 };
        this.listeners = [];
    }

    get speed() {
        return this.anchor.speed;
    }

    // The current simulation time as a Date
    now() {
        return new Date(simTimeAt(this.anchor));
    }

    // Called with the new anchor whenever it moves
    onChange(listener) {
        this.listeners.push(listener);
    }

    setSpeed(speed) {
        this.reanchor(simTimeAt(this.anchor), speed);
    }

    // Jump the simulation time by a fixed amount (in milliseconds) without changing the speed
    shift(millis) {
        this.reanchor(simTimeAt(this.anchor) + millis, this.anchor.speed);
    }

    setRealTime() {
        this.reanchor(Date.now(), 1);
    }

    reanchor(simMs, speed) {
        this.anchor = { wallMs: Date.now(), simMs, speed };
        for (const listener of this.listeners) {
            listener(this.anchor);
        }
    }
}
