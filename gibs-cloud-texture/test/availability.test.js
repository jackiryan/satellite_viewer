import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { clearAvailabilityMemo, domainsUrl, latestAvailable, parseTimeDomain, resolveDate } from '../src/availability.js';
import { domainsXml, fakeGibs } from './helpers.js';

beforeEach(clearAvailabilityMemo);

const config = { gibsBaseUrl: 'https://gibs.test', layer: 'LAYER', tileMatrixSet: '1km' };

test('parses the time domain of a DescribeDomains document', () => {
    // as returned by GIBS for this layer
    const xml = `<?xml version="1.0" encoding="UTF-8"?><Domains xmlns:ows="http://www.opengis.net/ows/1.1">
      <SpaceDomain><BoundingBox crs="urn:ogc:def:crs:OGC:2:84">-180,-90,180,90</BoundingBox></SpaceDomain>
      <DimensionDomain><ows:Identifier>time</ows:Identifier>
      <Domain>2024-04-17/2024-09-21/P1D,2024-09-23/2026-10-17/P1D,2026-10-19</Domain><Size>3</Size></DimensionDomain></Domains>`;
    assert.deepEqual(parseTimeDomain(xml), [['2024-04-17', '2024-09-21'], ['2024-09-23', '2026-10-17'], ['2026-10-19', '2026-10-19']]);
    assert.equal(parseTimeDomain('<Domains></Domains>'), null);
    assert.equal(domainsUrl(config, '2026-10-01', '2026-10-11'),
        'https://gibs.test/1.0.0/LAYER/default/1km/all/2026-10-01--2026-10-11.xml');
});

test('finds the newest published date on or before a date', () => {
    const ranges = [['2023-09-27', '2023-09-30'], ['2023-12-06', '2024-04-15'], ['2024-09-23', '2026-10-17']];
    assert.equal(latestAvailable(ranges, '2026-10-17'), '2026-10-17');
    assert.equal(latestAvailable(ranges, '2026-10-18'), '2026-10-17');
    assert.equal(latestAvailable(ranges, '2026-01-01'), '2026-01-01');
    assert.equal(latestAvailable(ranges, '2023-11-15'), '2023-09-30'); // a gap in the record
    assert.equal(latestAvailable(ranges, '2020-01-01'), null);
});

test('only recent dates are checked, and the list is remembered for a while', async () => {
    const now = Date.parse('2026-10-19T00:30:00Z');
    const gibs = fakeGibs(() => null);
    gibs.published = [['2018-02-17', '2026-10-16']];
    assert.deepEqual(await resolveDate(config, '2026-10-17', { fetchImpl: gibs, now }), { date: '2026-10-16', fallback: true });
    assert.deepEqual(await resolveDate(config, '2026-10-17', { fetchImpl: gibs, now }), { date: '2026-10-16', fallback: true });
    assert.equal(gibs.requests.length, 1);
    assert.deepEqual(await resolveDate(config, '2026-09-01', { fetchImpl: gibs, now }), { date: '2026-09-01', fallback: false });
    assert.equal(gibs.requests.length, 1);
    // nothing published in the last ten days: use the date as asked and let GIBS decide
    gibs.published = [['2018-02-17', '2026-09-01']];
    clearAvailabilityMemo();
    assert.deepEqual(await resolveDate(config, '2026-10-17', { fetchImpl: gibs, now }), { date: '2026-10-17', fallback: false });
    assert.match(domainsXml([['a', 'b']]), /<Domain>a\/b\/P1D<\/Domain>/);
});
