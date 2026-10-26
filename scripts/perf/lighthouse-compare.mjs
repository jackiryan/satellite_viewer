#!/usr/bin/env node
/* Runs Lighthouse (performance only) against one or two URLs several times each, alternating
 * between them, and prints the median of each metric side by side, plus the satellite viewer's
 * own load milestones (the sv:* User Timing marks from src/perfMarks.js). One run is noisy;
 * medians of 5 or more are worth comparing.
 *
 *   node scripts/perf/lighthouse-compare.mjs [options] <urlA> [urlB]
 *
 * Options:
 *   --runs N       runs per URL (default 5)
 *   --retina       emulate a 784 x 913 window at 2x (the window in the original report)
 *                  instead of Lighthouse's desktop preset (1350 x 940 at 1x)
 *   --headed       show the browser window instead of running headless
 *   --out DIR      where to keep the JSON reports (default perf-results/<date-time>); open them
 *                  at https://googlechrome.github.io/lighthouse/viewer/ to see the full report
 *
 * Uses Lighthouse 13 through npx (nothing to install) and the Chrome on this machine (set
 * CHROME_PATH to use another). Example, comparing the deployed site with a local build:
 *   npx vite build && npx vite preview --port 4174 --strictPort &
 *   node scripts/perf/lighthouse-compare.mjs https://jackiepi.xyz/satellites.html http://localhost:4174/satellites.html
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const option = (name, fallback) => {
    const i = args.indexOf(name);
    if (i === -1) return fallback;
    const value = args[i + 1];
    args.splice(i, 2);
    return value;
};
const flag = (name) => {
    const i = args.indexOf(name);
    if (i === -1) return false;
    args.splice(i, 1);
    return true;
};
const runs = Number(option('--runs', '5'));
const outDir = option('--out', path.join('perf-results', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)));
const retina = flag('--retina');
const headed = flag('--headed');
const urls = args;
if (urls.length < 1 || urls.length > 2 || !Number.isFinite(runs) || runs < 1) {
    console.error('usage: node scripts/perf/lighthouse-compare.mjs [--runs N] [--retina] [--headed] [--out DIR] <urlA> [urlB]');
    process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

const lighthouseArgs = [
    '-y', 'lighthouse@13', '--only-categories=performance', '--preset=desktop', '--output=json', '--quiet',
    `--chrome-flags=${headed ? '' : '--headless=new'}`
];
if (retina) {
    lighthouseArgs.push('--screenEmulation.mobile=false', '--screenEmulation.width=784',
        '--screenEmulation.height=913', '--screenEmulation.deviceScaleFactor=2');
}

const metrics = [
    ['Performance score', (r) => r.categories.performance.score * 100, ''],
    ['First Contentful Paint', (r) => r.audits['first-contentful-paint'].numericValue, 'ms'],
    ['Largest Contentful Paint', (r) => r.audits['largest-contentful-paint'].numericValue, 'ms'],
    ['Speed Index', (r) => r.audits['speed-index'].numericValue, 'ms'],
    ['Total Blocking Time', (r) => r.audits['total-blocking-time'].numericValue, 'ms'],
    ['Time to Interactive', (r) => r.audits.interactive?.numericValue, 'ms'],
    ['Cumulative Layout Shift', (r) => r.audits['cumulative-layout-shift'].numericValue, ''],
    ['Speed Index (observed)', (r) => r.audits.metrics.details.items[0].observedSpeedIndex, 'ms'],
    ['Total bytes', (r) => r.audits['total-byte-weight'].numericValue / 1024, 'KiB'],
    ['Requests', (r) => r.audits['network-requests'].details.items.length, ''],
    ['Main-thread work', (r) => r.audits['mainthread-work-breakdown'].numericValue, 'ms']
];
const marks = ['sv:first-frame', 'sv:earth-textured', 'sv:stars-visible', 'sv:satellites-visible',
    'sv:clouds-visible', 'sv:scene-complete'];
for (const name of marks) {
    metrics.push([name, (r) => r.audits['user-timings']?.details?.items
        ?.find((item) => item.name === name && item.timingType === 'Mark')?.startTime, 'ms']);
}

const values = urls.map(() => metrics.map(() => []));
for (let run = 1; run <= runs; run++) {
    urls.forEach((url, u) => {
        const label = urls.length === 2 ? 'AB'[u] : 'A';
        const file = path.join(outDir, `${label}-${run}.json`);
        process.stdout.write(`run ${run}/${runs} ${label} ${url} ... `);
        try {
            execFileSync('npx', [...lighthouseArgs, `--output-path=${file}`, url], { stdio: ['ignore', 'ignore', 'inherit'] });
            const report = JSON.parse(fs.readFileSync(file, 'utf8'));
            metrics.forEach(([, get], m) => {
                const v = get(report);
                if (Number.isFinite(v)) values[u][m].push(v);
            });
            console.log(`score ${Math.round(report.categories.performance.score * 100)}`);
        } catch (error) {
            console.log(`failed: ${error.message}`);
        }
    });
}

const median = (list) => {
    if (list.length === 0) return NaN;
    const s = [...list].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const format = (v, unit) => (Number.isFinite(v) ? (unit === '' && v < 1 ? v.toFixed(3) : Math.round(v).toLocaleString('en-US')) + (unit ? ` ${unit}` : '') : '-');

const header = urls.length === 2 ? '| Median | A | B | B - A |\n|---|---:|---:|---:|' : '| Median | A |\n|---|---:|';
const rows = metrics.map(([name, , unit], m) => {
    const a = median(values[0][m]);
    if (urls.length === 1) return `| ${name} | ${format(a, unit)} |`;
    const b = median(values[1][m]);
    const diff = b - a;
    const sign = diff > 0 ? '+' : '';
    return `| ${name} | ${format(a, unit)} | ${format(b, unit)} | ${Number.isFinite(diff) ? sign + format(diff, unit) : '-'} |`;
});
const summary = [
    `Lighthouse ${retina ? '784x913 @2x' : 'desktop preset'}, ${runs} run(s) per URL`,
    ...urls.map((url, u) => `${urls.length === 2 ? 'AB'[u] : 'A'}: ${url}`),
    '',
    header,
    ...rows,
    '',
    'sv:* marks are milliseconds after navigation start, measured on this machine (not simulated).'
].join('\n');
fs.writeFileSync(path.join(outDir, 'summary.md'), summary + '\n');
console.log('\n' + summary + `\n\nReports and summary.md are in ${outDir}`);
