/* moonephemeris.js - position and orientation of the Moon, plus the position of the Sun
 * used to light it, in the scene's Earth-centered inertial frame.
 *
 * Frame: satellite positions come from SGP4, which works in TEME (true equator, mean
 * equinox of date), and the Earth is rotated by GMST, so the scene's ECI frame is TEME.
 * Every vector here is returned in TEME, in km, as a plain [x, y, z] array with z toward
 * the north pole. moon.js converts them to scene units and axes, the same way
 * satelliteWorker.js does.
 *
 * Sources, with the error measured against JPL DE421 over 2017-2050:
 *   Moon position    Meeus, Astronomical Algorithms (2nd ed.), ch. 47: the truncated
 *                    ELP-2000/82 series. Median 5 km, worst 27 km (16 arcsec).
 *   Sun position     Meeus ch. 25, low-accuracy method. Worst 0.01 deg.
 *   Nutation         Meeus ch. 22, low-accuracy method (~0.5 arcsec).
 *   Moon orientation IAU WGCCRE rotation model for the Moon (Archinal et al. 2011, same
 *                    constants as NAIF pck00008-pck00011), precessed from J2000 to the frame
 *                    of date with the IAU 1976 angles. Worst 0.005 deg (140 m at the surface)
 *                    from the DE421 Mean Earth/polar axis frame that LRO maps such as the
 *                    LROC color mosaic are made in.
 */

const DEG = Math.PI / 180;
const ARCSEC = DEG / 3600;
const AU_KM = 149597870.7;

// TT - UTC = 32.184 s + 37 leap seconds. Constant since 2017-01-01; add 1 s here if the
// IERS ever announces another leap second. (UT1 - UTC < 0.9 s is ignored, as in gstime.js.)
const TT_MINUS_UTC_SECONDS = 69.184;

// Meeus table 47.A: multiples of D, M, M', F, then the sine coefficient for longitude
// (1e-6 deg) and the cosine coefficient for distance (1e-3 km).
const LONGITUDE_DISTANCE_TERMS = [
    [0, 0, 1, 0, 6288774, -20905355], [2, 0, -1, 0, 1274027, -3699111], [2, 0, 0, 0, 658314, -2955968],
    [0, 0, 2, 0, 213618, -569925], [0, 1, 0, 0, -185116, 48888], [0, 0, 0, 2, -114332, -3149],
    [2, 0, -2, 0, 58793, 246158], [2, -1, -1, 0, 57066, -152138], [2, 0, 1, 0, 53322, -170733],
    [2, -1, 0, 0, 45758, -204586], [0, 1, -1, 0, -40923, -129620], [1, 0, 0, 0, -34720, 108743],
    [0, 1, 1, 0, -30383, 104755], [2, 0, 0, -2, 15327, 10321], [0, 0, 1, 2, -12528, 0],
    [0, 0, 1, -2, 10980, 79661], [4, 0, -1, 0, 10675, -34782], [0, 0, 3, 0, 10034, -23210],
    [4, 0, -2, 0, 8548, -21636], [2, 1, -1, 0, -7888, 24208], [2, 1, 0, 0, -6766, 30824],
    [1, 0, -1, 0, -5163, -8379], [1, 1, 0, 0, 4987, -16675], [2, -1, 1, 0, 4036, -12831],
    [2, 0, 2, 0, 3994, -10445], [4, 0, 0, 0, 3861, -11650], [2, 0, -3, 0, 3665, 14403],
    [0, 1, -2, 0, -2689, -7003], [2, 0, -1, 2, -2602, 0], [2, -1, -2, 0, 2390, 10056],
    [1, 0, 1, 0, -2348, 6322], [2, -2, 0, 0, 2236, -9884], [0, 1, 2, 0, -2120, 5751],
    [0, 2, 0, 0, -2069, 0], [2, -2, -1, 0, 2048, -4950], [2, 0, 1, -2, -1773, 4130],
    [2, 0, 0, 2, -1595, 0], [4, -1, -1, 0, 1215, -3958], [0, 0, 2, 2, -1110, 0],
    [3, 0, -1, 0, -892, 3258], [2, 1, 1, 0, -810, 2616], [4, -1, -2, 0, 759, -1897],
    [0, 2, -1, 0, -713, -2117], [2, 2, -1, 0, -700, 2354], [2, 1, -2, 0, 691, 0],
    [2, -1, 0, -2, 596, 0], [4, 0, 1, 0, 549, -1423], [0, 0, 4, 0, 537, -1117],
    [4, -1, 0, 0, 520, -1571], [1, 0, -2, 0, -487, -1739], [2, 1, 0, -2, -399, 0],
    [0, 0, 2, -2, -381, -4421], [1, 1, 1, 0, 351, 0], [3, 0, -2, 0, -340, 0],
    [4, 0, -3, 0, 330, 0], [2, -1, 2, 0, 327, 0], [0, 2, 1, 0, -323, 1165],
    [1, 1, -1, 0, 299, 0], [2, 0, 3, 0, 294, 0], [2, 0, -1, -2, 0, 8752]
];

// Meeus table 47.B: multiples of D, M, M', F, then the sine coefficient for latitude (1e-6 deg).
const LATITUDE_TERMS = [
    [0, 0, 0, 1, 5128122], [0, 0, 1, 1, 280602], [0, 0, 1, -1, 277693], [2, 0, 0, -1, 173237],
    [2, 0, -1, 1, 55413], [2, 0, -1, -1, 46271], [2, 0, 0, 1, 32573], [0, 0, 2, 1, 17198],
    [2, 0, 1, -1, 9266], [0, 0, 2, -1, 8822], [2, -1, 0, -1, 8216], [2, 0, -2, -1, 4324],
    [2, 0, 1, 1, 4200], [2, 1, 0, -1, -3359], [2, -1, -1, 1, 2463], [2, -1, 0, 1, 2211],
    [2, -1, -1, -1, 2065], [0, 1, -1, -1, -1870], [4, 0, -1, -1, 1828], [0, 1, 0, 1, -1794],
    [0, 0, 0, 3, -1749], [0, 1, -1, 1, -1565], [1, 0, 0, 1, -1491], [0, 1, 1, 1, -1475],
    [0, 1, 1, -1, -1410], [0, 1, 0, -1, -1344], [1, 0, 0, -1, -1335], [0, 0, 3, 1, 1107],
    [4, 0, 0, -1, 1021], [4, 0, -1, 1, 833], [0, 0, 1, -3, 777], [4, 0, -2, 1, 671],
    [2, 0, 0, -3, 607], [2, 0, 2, -1, 596], [2, -1, 1, -1, 491], [2, 0, -2, 1, -451],
    [0, 0, 3, -1, 439], [2, 0, 2, 1, 422], [2, 0, -3, -1, 421], [2, 1, -1, 1, -366],
    [2, 1, 0, 1, -351], [4, 0, 0, 1, 331], [2, -1, 1, 1, 315], [2, -2, 0, -1, 302],
    [0, 0, 1, 3, -283], [2, 1, 1, -1, -229], [1, 1, 0, -1, 223], [1, 1, 0, 1, 223],
    [0, 1, -2, -1, -220], [2, 1, -1, -1, -220], [1, 0, 1, 1, -185], [2, -1, -2, -1, 181],
    [0, 1, 2, 1, -177], [4, 0, -2, -1, 176], [4, -1, -1, -1, 166], [1, 0, 1, -1, -164],
    [4, 0, 1, -1, 132], [1, 0, -1, -1, -119], [4, -1, 0, -1, 115], [2, -2, 0, 1, 107]
];

/* ---------------------------------------------------------------- 3x3 matrix helpers
 * Row-major arrays of 9 numbers. The rotations are "passive" (they rotate the
 * coordinate frame, not the vector), matching the convention used in Meeus and the
 * IAU reports.
 */
function rotX(a) {
    const c = Math.cos(a), s = Math.sin(a);
    return [1, 0, 0, 0, c, s, 0, -s, c];
}

function rotY(a) {
    const c = Math.cos(a), s = Math.sin(a);
    return [c, 0, -s, 0, 1, 0, s, 0, c];
}

function rotZ(a) {
    const c = Math.cos(a), s = Math.sin(a);
    return [c, s, 0, -s, c, 0, 0, 0, 1];
}

function multiply(a, b) {
    const out = new Array(9);
    for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
            out[3 * r + c] = a[3 * r] * b[c] + a[3 * r + 1] * b[3 + c] + a[3 * r + 2] * b[6 + c];
        }
    }
    return out;
}

function transpose(m) {
    return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

function applyMatrix(m, v) {
    return [
        m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
        m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
        m[6] * v[0] + m[7] * v[1] + m[8] * v[2]
    ];
}

/* ---------------------------------------------------------------------- frame of date */

// Days and Julian centuries of Terrestrial Time since J2000.0 (2000-01-01 12:00 TT).
function timeSinceJ2000(date) {
    const days = (date.getTime() / 1000 + TT_MINUS_UTC_SECONDS) / 86400 + 2440587.5 - 2451545.0;
    return { days, centuries: days / 36525 };
}

// Nutation and obliquity (Meeus ch. 22, low accuracy), all in radians.
function nutation(T) {
    const omega = (125.04452 - 1934.136261 * T) * DEG;
    const sunLongitude = (280.4665 + 36000.7698 * T) * DEG;
    const moonLongitude = (218.3165 + 481267.8813 * T) * DEG;

    const dPsi = (-17.20 * Math.sin(omega) - 1.32 * Math.sin(2 * sunLongitude)
        - 0.23 * Math.sin(2 * moonLongitude) + 0.21 * Math.sin(2 * omega)) * ARCSEC;
    const dEps = (9.20 * Math.cos(omega) + 0.57 * Math.cos(2 * sunLongitude)
        + 0.10 * Math.cos(2 * moonLongitude) - 0.09 * Math.cos(2 * omega)) * ARCSEC;

    const meanObliquity = 23.43929111 * DEG
        + (-46.8150 * T - 0.00059 * T * T + 0.001813 * T * T * T) * ARCSEC;
    const trueObliquity = meanObliquity + dEps;

    // Equation of the equinoxes: the angle from the mean to the true equinox along the
    // true equator, i.e. the difference between TEME and true-of-date coordinates.
    const equationOfEquinoxes = dPsi * Math.cos(trueObliquity);

    return { dPsi, meanObliquity, trueObliquity, equationOfEquinoxes };
}

// Ecliptic longitude/latitude of date (mean equinox, radians) and distance -> TEME vector.
function eclipticOfDateToTeme(longitude, latitude, distance, nut) {
    const lon = longitude + nut.dPsi; // refer the longitude to the true equinox
    const cosLat = Math.cos(latitude), sinLat = Math.sin(latitude);
    const cosEps = Math.cos(nut.trueObliquity), sinEps = Math.sin(nut.trueObliquity);

    // true equator and equinox of date
    const x = distance * cosLat * Math.cos(lon);
    const y = distance * (cosLat * Math.sin(lon) * cosEps - sinLat * sinEps);
    const z = distance * (cosLat * Math.sin(lon) * sinEps + sinLat * cosEps);

    // shift the x axis from the true equinox back to the mean equinox (TEME)
    return applyMatrix(rotZ(nut.equationOfEquinoxes), [x, y, z]);
}

// Rotation from ICRF/J2000 to TEME: IAU 1976 precession, then nutation, then the
// equation of the equinoxes.
function icrfToTemeMatrix(T, nut) {
    const zeta = (2306.2181 * T + 0.30188 * T * T + 0.017998 * T * T * T) * ARCSEC;
    const z = (2306.2181 * T + 1.09468 * T * T + 0.018203 * T * T * T) * ARCSEC;
    const theta = (2004.3109 * T - 0.42665 * T * T - 0.041833 * T * T * T) * ARCSEC;
    const precession = multiply(rotZ(-z), multiply(rotY(theta), rotZ(-zeta)));
    const nutationMatrix = multiply(rotX(-nut.trueObliquity),
        multiply(rotZ(-nut.dPsi), rotX(nut.meanObliquity)));
    return multiply(rotZ(nut.equationOfEquinoxes), multiply(nutationMatrix, precession));
}

/* ----------------------------------------------------------------------------- bodies */

// Geocentric position of the Moon's center (Meeus ch. 47) in TEME, km.
function moonPosition(T, nut) {
    const Lp = (218.3164477 + 481267.88123421 * T - 0.0015786 * T * T
        + T * T * T / 538841 - T * T * T * T / 65194000) * DEG;
    const D = (297.8501921 + 445267.1114034 * T - 0.0018819 * T * T
        + T * T * T / 545868 - T * T * T * T / 113065000) * DEG;
    const M = (357.5291092 + 35999.0502909 * T - 0.0001536 * T * T
        + T * T * T / 24490000) * DEG;
    const Mp = (134.9633964 + 477198.8675055 * T + 0.0087414 * T * T
        + T * T * T / 69699 - T * T * T * T / 14712000) * DEG;
    const F = (93.2720950 + 483202.0175233 * T - 0.0036539 * T * T
        - T * T * T / 3526000 + T * T * T * T / 863310000) * DEG;
    const A1 = (119.75 + 131.849 * T) * DEG;
    const A2 = (53.09 + 479264.290 * T) * DEG;
    const A3 = (313.45 + 481266.484 * T) * DEG;
    // terms that involve the Sun's mean anomaly M shrink as Earth's orbit circularizes
    const E = 1 - 0.002516 * T - 0.0000074 * T * T;
    const eFactor = [1, E, E * E];

    let sumL = 3958 * Math.sin(A1) + 1962 * Math.sin(Lp - F) + 318 * Math.sin(A2);
    let sumR = 0;
    for (const [d, m, mp, f, l, r] of LONGITUDE_DISTANCE_TERMS) {
        const arg = d * D + m * M + mp * Mp + f * F;
        const e = eFactor[Math.abs(m)];
        sumL += l * e * Math.sin(arg);
        sumR += r * e * Math.cos(arg);
    }

    let sumB = -2235 * Math.sin(Lp) + 382 * Math.sin(A3) + 175 * Math.sin(A1 - F)
        + 175 * Math.sin(A1 + F) + 127 * Math.sin(Lp - Mp) - 115 * Math.sin(Lp + Mp);
    for (const [d, m, mp, f, b] of LATITUDE_TERMS) {
        sumB += b * eFactor[Math.abs(m)] * Math.sin(d * D + m * M + mp * Mp + f * F);
    }

    const longitude = Lp + sumL * 1e-6 * DEG;
    const latitude = sumB * 1e-6 * DEG;
    const distance = 385000.56 + sumR * 1e-3;
    return eclipticOfDateToTeme(longitude, latitude, distance, nut);
}

// Geocentric position of the Sun (Meeus ch. 25, low accuracy) in TEME, km.
function sunPosition(T, nut) {
    const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
    const M = (357.52911 + 35999.05029 * T - 0.0001537 * T * T) * DEG;
    const e = 0.016708634 - 0.000042037 * T - 0.0000001267 * T * T;
    const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(M)
        + (0.019993 - 0.000101 * T) * Math.sin(2 * M)
        + 0.000289 * Math.sin(3 * M);
    const trueAnomaly = M + C * DEG;
    const distance = AU_KM * 1.000001018 * (1 - e * e) / (1 + e * Math.cos(trueAnomaly));
    return eclipticOfDateToTeme((L0 + C) * DEG, 0, distance, nut);
}

// Rotation that takes Moon body-fixed vectors (x toward 0 deg longitude on the equator,
// y toward 90 deg E, z toward the north pole) into TEME.
function moonOrientation(d, T, nut) {
    const E1 = (125.045 - 0.0529921 * d) * DEG;
    const E2 = (250.089 - 0.1059842 * d) * DEG;
    const E3 = (260.008 + 13.0120009 * d) * DEG;
    const E4 = (176.625 + 13.3407154 * d) * DEG;
    const E5 = (357.529 + 0.9856003 * d) * DEG;
    const E6 = (311.589 + 26.4057084 * d) * DEG;
    const E7 = (134.963 + 13.0649930 * d) * DEG;
    const E8 = (276.617 + 0.3287146 * d) * DEG;
    const E9 = (34.226 + 1.7484877 * d) * DEG;
    const E10 = (15.134 - 0.1589763 * d) * DEG;
    const E11 = (119.743 + 0.0036096 * d) * DEG;
    const E12 = (239.961 + 0.1643573 * d) * DEG;
    const E13 = (25.053 + 12.9590088 * d) * DEG;
    const sin = Math.sin, cos = Math.cos;

    // right ascension and declination of the north pole, and the prime meridian angle
    const poleRa = (269.9949 + 0.0031 * T - 3.8787 * sin(E1) - 0.1204 * sin(E2)
        + 0.0700 * sin(E3) - 0.0172 * sin(E4) + 0.0072 * sin(E6) - 0.0052 * sin(E10)
        + 0.0043 * sin(E13)) * DEG;
    const poleDec = (66.5392 + 0.0130 * T + 1.5419 * cos(E1) + 0.0239 * cos(E2)
        - 0.0278 * cos(E3) + 0.0068 * cos(E4) - 0.0029 * cos(E6) + 0.0009 * cos(E7)
        + 0.0008 * cos(E10) - 0.0009 * cos(E13)) * DEG;
    const W = (38.3213 + 13.17635815 * d - 1.4e-12 * d * d + 3.5610 * sin(E1)
        + 0.1208 * sin(E2) - 0.0642 * sin(E3) + 0.0158 * sin(E4) + 0.0252 * sin(E5)
        - 0.0066 * sin(E6) - 0.0047 * sin(E7) - 0.0046 * sin(E8) + 0.0028 * sin(E9)
        + 0.0052 * sin(E10) + 0.0040 * sin(E11) + 0.0019 * sin(E12) - 0.0044 * sin(E13)) * DEG;

    // ICRF -> body-fixed, then invert and carry into TEME
    const icrfToBody = multiply(rotZ(W), multiply(rotX(Math.PI / 2 - poleDec), rotZ(Math.PI / 2 + poleRa)));
    return multiply(icrfToTemeMatrix(T, nut), transpose(icrfToBody));
}

/**
 * Positions of the Moon and Sun, and the Moon's orientation, at a given time.
 *
 * @param {Date} date - UTC time, e.g. the scene time from viewer.js
 * @returns {{moonPosition: number[], sunPosition: number[], moonToTeme: number[]}}
 *   moonPosition, sunPosition: geocentric [x, y, z] in TEME, km.
 *   moonToTeme: row-major 3x3 rotation from Moon body-fixed axes (x: 0 deg lon, y: 90 deg E,
 *   z: north pole) to TEME. Its columns are those three axes expressed in TEME.
 */
export function getMoonEphemeris(date) {
    const { days, centuries } = timeSinceJ2000(date);
    const nut = nutation(centuries);
    return {
        moonPosition: moonPosition(centuries, nut),
        sunPosition: sunPosition(centuries, nut),
        moonToTeme: moonOrientation(days, centuries, nut)
    };
}