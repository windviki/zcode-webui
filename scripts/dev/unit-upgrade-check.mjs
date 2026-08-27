// quick unit checks for upgrade.mjs helpers (local dev only)
import { parseVersionsFromPage, platformKey, fetchManifest } from '../../src/upgrade.mjs';

const html1 = String.raw`{"version":"3.9.2","notes":"x"} other {\"version\":\"3.10.0\"}`;
console.log('parse1:', JSON.stringify(parseVersionsFromPage(html1)));
console.log('parse2:', JSON.stringify(parseVersionsFromPage('no versions here')));
console.log('platformKey arm64:', platformKey('arm64'));
try { platformKey('darwin'); console.log('platformKey darwin: NOT REJECTED (bug)'); }
catch (e) { console.log('platformKey darwin rejected ok:', e.message.slice(0, 40)); }
const r = await fetchManifest('9.9.9').then(() => 'UNEXPECTED SUCCESS', (e) => e.message);
console.log('manifest 9.9.9 ->', String(r).slice(0, 70));
