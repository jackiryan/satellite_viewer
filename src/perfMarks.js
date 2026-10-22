/* perfMarks.js - User Timing marks for the page load milestones of the satellite viewer.
 * They appear in Lighthouse ("User Timing marks and measures"), in the Performance panel's
 * Timings track, and in performance.getEntriesByType('mark'), so a load can be measured by
 * when the scene actually looks finished rather than by when the clock text first paints:
 *   sv:first-frame         first frame drawn (placeholder globe, blank sky)
 *   sv:earth-textured      first frame with the textured globe
 *   sv:stars-visible       first frame with the star field
 *   sv:satellites-visible  first frame with a satellite group on screen
 *   sv:clouds-visible      first frame with the clouds
 *   sv:scene-complete      all of the above
 */
const seen = new Set();

export function markOnce(name) {
    if (seen.has(name)) {
        return false;
    }
    seen.add(name);
    performance.mark(name);
    return true;
}

// Called after each frame is rendered with what the frame contained
export function markFrame({ earthTextured, starsVisible, satellitesVisible, cloudsVisible }) {
    if (seen.has('sv:scene-complete')) {
        return;
    }
    markOnce('sv:first-frame');
    if (earthTextured) markOnce('sv:earth-textured');
    if (starsVisible) markOnce('sv:stars-visible');
    if (satellitesVisible) markOnce('sv:satellites-visible');
    if (cloudsVisible) markOnce('sv:clouds-visible');
    if (earthTextured && starsVisible && satellitesVisible && cloudsVisible) {
        markOnce('sv:scene-complete');
    }
}
