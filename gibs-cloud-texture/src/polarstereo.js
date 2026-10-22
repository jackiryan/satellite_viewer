/* polarstereo.js - the ellipsoidal polar stereographic projection (Snyder, Map Projections:
 * A Working Manual, 1987, pp. 154-163), as used by the NSIDC sea ice grids:
 *
 *   EPSG:3411  NSIDC Sea Ice Polar Stereographic North   Hughes 1980, true scale at 70 N, lon_0 -45
 *   EPSG:3412  NSIDC Sea Ice Polar Stereographic South   Hughes 1980, true scale at 70 S, lon_0 0
 *   EPSG:3413 / EPSG:3976: the same with the WGS 84 ellipsoid
 *
 * A grid's projection is taken from its GeoKeys, either as one of those EPSG codes or as a
 * user-defined polar stereographic projection with its parameters spelled out.
 */
import { GEOKEY } from './geotiff.js';

const DEG = Math.PI / 180;

export const ELLIPSOIDS = {
    hughes1980: { a: 6378273, b: 6356889.449 },
    wgs84: { a: 6378137, b: 6378137 * (1 - 1 / 298.257223563) }
};

export const EPSG_PROJECTIONS = {
    3411: { north: true, latTs: 70, lon0: -45, ellipsoid: ELLIPSOIDS.hughes1980 },
    3412: { north: false, latTs: -70, lon0: 0, ellipsoid: ELLIPSOIDS.hughes1980 },
    3413: { north: true, latTs: 70, lon0: -45, ellipsoid: ELLIPSOIDS.wgs84 },
    3976: { north: false, latTs: -70, lon0: 0, ellipsoid: ELLIPSOIDS.wgs84 }
};

// EPSG codes for ellipsoids (GeogEllipsoidGeoKey) and geographic CRSs (GeographicTypeGeoKey)
const ELLIPSOID_CODES = { 7058: ELLIPSOIDS.hughes1980, 7030: ELLIPSOIDS.wgs84 };
const GEOGRAPHIC_CODES = { 4054: ELLIPSOIDS.hughes1980, 4326: ELLIPSOIDS.wgs84, 4030: ELLIPSOIDS.wgs84 };
const CT_POLAR_STEREOGRAPHIC = 15;
const USER_DEFINED = 32767;
const LINEAR_UNIT_METRE = 9001;

export class ProjectionError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ProjectionError';
    }
}

/**
 * A polar stereographic projection centered on the north or south pole.
 *
 * @param {object} p
 * @param {boolean} p.north     north or south polar aspect
 * @param {number} p.latTs      latitude of true scale, degrees (+/-90 for "variant A", where
 *                              k0 is the scale at the pole)
 * @param {number} p.lon0       longitude pointing straight down from the pole (north) or up
 *                              (south) on the map, degrees
 * @param {{a: number, b: number}} p.ellipsoid
 * @param {number} [p.k0=1]
 * @param {number} [p.falseEasting=0]
 * @param {number} [p.falseNorthing=0]
 */
export function polarStereographic({ north, latTs, lon0, ellipsoid, k0 = 1, falseEasting = 0, falseNorthing = 0, name }) {
    const { a, b } = ellipsoid;
    const e = Math.sqrt(1 - (b * b) / (a * a));
    // work in the north polar aspect: the south one mirrors latitude (Snyder p. 161)
    const t = (lat) => {
        const sin = Math.sin(lat);
        return Math.tan(Math.PI / 4 - lat / 2) / ((1 - e * sin) / (1 + e * sin)) ** (e / 2);
    };
    const phiC = Math.abs(latTs) * DEG;
    let scale; // rho = scale * t(lat)
    if (Math.abs(Math.abs(latTs) - 90) < 1e-10) {
        scale = (2 * a * k0) / Math.sqrt((1 + e) ** (1 + e) * (1 - e) ** (1 - e));
    } else {
        const mC = Math.cos(phiC) / Math.sqrt(1 - e * e * Math.sin(phiC) ** 2);
        scale = (a * mC * k0) / t(phiC);
    }
    const hemisphere = north ? 1 : -1;
    return {
        name: name ?? `polar stereographic ${north ? 'north' : 'south'} (lat_ts ${latTs}, lon_0 ${lon0})`,
        north,
        lon0: lon0 * DEG,
        falseEasting,
        falseNorthing,
        // y = falseNorthing + ySign * rho * cos(lon - lon0)
        ySign: north ? -1 : 1,
        /** Distance from the pole in metres, for a latitude in radians in this hemisphere. */
        rho: (lat) => scale * t(hemisphere * lat),
        /** Project a longitude and latitude (degrees) to map x, y (metres). */
        forward(lonDeg, latDeg) {
            const rho = this.rho(latDeg * DEG);
            const dl = lonDeg * DEG - this.lon0;
            return [falseEasting + rho * Math.sin(dl), falseNorthing + this.ySign * rho * Math.cos(dl)];
        }
    };
}

/**
 * The projection described by a GeoTIFF's GeoKeys, or null if they don't describe one (the
 * caller then decides on a default). Throws ProjectionError for anything other than a polar
 * stereographic projection in metres.
 */
export function projectionFromGeoKeys(keys) {
    const code = keys[GEOKEY.ProjectedCSType];
    if (code in EPSG_PROJECTIONS) return polarStereographic({ ...EPSG_PROJECTIONS[code], name: `EPSG:${code}` });

    const unit = keys[3076]; // ProjLinearUnitsGeoKey
    if (unit !== undefined && unit !== LINEAR_UNIT_METRE) throw new ProjectionError(`unsupported linear unit ${unit}`);
    if (code !== undefined && code !== USER_DEFINED) {
        throw new ProjectionError(`EPSG:${code} is not one of the polar stereographic grids this Worker handles`);
    }
    const transform = keys[GEOKEY.ProjCoordTrans];
    if (transform === undefined) return null;
    if (transform !== CT_POLAR_STEREOGRAPHIC) {
        throw new ProjectionError(`coordinate transformation ${transform} is not polar stereographic`);
    }
    const latTs = keys[GEOKEY.ProjStdParallel1] ?? keys[GEOKEY.ProjNatOriginLat];
    const lon0 = keys[GEOKEY.ProjStraightVertPoleLong] ?? 0;
    const ellipsoid = ellipsoidFromGeoKeys(keys);
    if (typeof latTs !== 'number' || !ellipsoid) return null;
    return polarStereographic({
        north: latTs > 0,
        latTs,
        lon0,
        ellipsoid,
        k0: keys[GEOKEY.ProjScaleAtNatOrigin] ?? 1,
        falseEasting: keys[GEOKEY.ProjFalseEasting] ?? 0,
        falseNorthing: keys[GEOKEY.ProjFalseNorthing] ?? 0,
        name: keys[3073] || keys[1026] || undefined // PCSCitationGeoKey or GTCitationGeoKey
    });
}

function ellipsoidFromGeoKeys(keys) {
    const a = keys[GEOKEY.GeogSemiMajorAxis];
    if (typeof a === 'number') {
        const b = keys[GEOKEY.GeogSemiMinorAxis];
        if (typeof b === 'number') return { a, b };
        const invF = keys[GEOKEY.GeogInvFlattening];
        if (typeof invF === 'number') return { a, b: invF === 0 ? a : a * (1 - 1 / invF) };
    }
    return ELLIPSOID_CODES[keys[GEOKEY.GeogEllipsoid]] ?? GEOGRAPHIC_CODES[keys[GEOKEY.GeographicType]] ?? null;
}
