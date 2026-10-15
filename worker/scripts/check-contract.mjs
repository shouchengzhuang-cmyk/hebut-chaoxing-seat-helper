import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseIndex, parseDetail, parseRecord, parseStatusProfile } from '../src/status.ts';
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function at(body, path) {
  return path.split('.').reduce((value, key) => object(value) && Object.hasOwn(value, key) ? value[key] : undefined, body);
}
// Offline only: no HTTP client, credentials, environment loading or school calls.
export function checkContract(bundle, profile = { states: {} }) {
  if (!object(bundle) || bundle.schemaVersion !== 1 || bundle.provenance !== 'LOCAL_ANONYMIZED_READONLY_CAPTURE' || bundle.identifiersAnonymized !== true || bundle.absoluteDatesAnonymized !== true || !Array.isArray(bundle.samples) || !bundle.samples.length || bundle.samples.length > 10) throw new Error('UNSUPPORTED_DIAGNOSTIC_BUNDLE');
  if (!parseStatusProfile(profile)) throw new Error('INVALID_STATUS_PROFILE');
  const env = { STATUS_PROFILE_VERIFIED: 'true', STATUS_PROFILE_JSON: JSON.stringify(profile) };
  const paths = { current: 'data.curReserves', near: 'data.nearReserves', detail: 'data.seatReserve', ...profile.responsePaths };
  const reports = bundle.samples.map(sample => {
    if (!object(sample) || !['seat', 'seatengine'].includes(sample.apiStyle) || !['index', 'getstatus'].includes(sample.endpoint)) throw new Error('UNSUPPORTED_READONLY_ENDPOINT');
    const body = sample.body;
    const entries = [];
    if (sample.endpoint === 'index') {
      for (const source of ['current', 'near']) {
        const values = at(body, paths[source]);
        if (Array.isArray(values)) values.forEach((value, index) => entries.push({ source, index, value }));
      }
    } else {
      const value = at(body, paths.detail);
      if (value !== undefined) entries.push({ source: 'detail', index: 0, value });
    }
    const evaluate = value => {
      if (sample.httpStatus !== 200) return { state: 'UNKNOWN', reason: 'HTTP_NOT_SUCCESSFUL' };
      const record = parseRecord(value);
      if (value !== undefined && !record) return { state: 'UNKNOWN', reason: 'INVALID_RESERVATION_RECORD' };
      const target = record ? { roomId: record.roomId, seatNum: record.seatNum, startTime: record.startTime, endTime: record.endTime } : { roomId: '1', seatNum: '001', startTime: '08:30', endTime: '22:00' };
      return sample.endpoint === 'index' ? parseIndex(body, env, target, record?.day ?? '2000-01-02') : parseDetail(body, env, target, record?.day ?? '2000-01-02', record?.id ?? '0');
    };
    // Do not emit records, identifiers, dates, raw codes, field paths or arbitrary input text.
    const records = entries.map(({ source, index, value }) => {
      const snapshot = evaluate(value);
      return { source, index, recordValid: Boolean(parseRecord(value)), state: snapshot.state, reason: snapshot.reason };
    });
    const snapshot = evaluate(entries[0]?.value);
    const allRecordsValid = records.every(record => record.recordValid);
    const needsVerification = !records.length || records.some(record => record.state === 'UNKNOWN') || snapshot.state === 'UNKNOWN';
    return { apiStyle: sample.apiStyle, endpoint: sample.endpoint, state: snapshot.state, reason: snapshot.reason, needsVerification, recordCount: records.length, allRecordsValid, records };
  });
  // Partial captures never establish completeness, school meanings, eligibility or compatibility.
  return { offlineOnly: true, productionCompatibilityConfirmed: false, needsVerification: reports.some(report => report.needsVerification), reports };
}
async function main() {
  const [sampleFile, profileFile, extra] = process.argv.slice(2);
  if (!sampleFile || extra) throw new Error('USAGE: node scripts/check-contract.mjs diagnostics.json [profile.json]');
  const bundle = JSON.parse(await readFile(sampleFile, 'utf8'));
  const profile = profileFile ? JSON.parse(await readFile(profileFile, 'utf8')) : { states: {} };
  process.stdout.write(JSON.stringify(checkContract(bundle, profile), null, 2) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { process.stderr.write('Contract check failed: invalid files or unsupported sample; no sample content was printed.\n'); process.exitCode = 1; });
