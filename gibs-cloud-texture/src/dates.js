/* dates.js - UTC calendar dates (YYYY-MM-DD strings) and how long textures for them stay fresh. */

export const DAY_MS = 86_400_000;

// GIBS can keep adding a day's data for a few days after it is first published, so textures
// for recent dates are refreshed; older ones are treated as final.
export const RECENT_DAYS = 4;
const RECENT_MAX_AGE = 60 * 60;            // 1 hour
const FINAL_MAX_AGE = 30 * 24 * 60 * 60;   // 30 days

export function todayUtc(now = Date.now()) {
    return new Date(now).toISOString().slice(0, 10);
}

export function addDays(date, days) {
    return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function ageInDays(date, now = Date.now()) {
    return (now - Date.parse(`${date}T00:00:00Z`)) / DAY_MS;
}

export function isRecent(date, now = Date.now()) {
    return ageInDays(date, now) < RECENT_DAYS;
}

/** Cache lifetime (seconds) for a texture of this date's data. */
export function maxAgeFor(date, now = Date.now()) {
    return isRecent(date, now) ? RECENT_MAX_AGE : FINAL_MAX_AGE;
}
