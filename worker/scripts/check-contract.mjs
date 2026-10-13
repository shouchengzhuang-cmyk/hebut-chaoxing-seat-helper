import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseIndex, parseDetail, parseRecord } from '../src/status.ts';
// Offline only. It does not import an HTTP client, load env credentials or call any endpoint.
export function checkContract(bundle, profile) {
  if (bundle?.schemaVersion !== 1 || bundle.provenance !== 'LOCAL_ANONYMIZED_READONLY_CAPTURE' || bundle.identifiersAnonymized !== true || bundle.absoluteDatesAnonymized !== true || !Array.isArray(bundle.samples) || bundle.samples.length > 10) throw new Error('UNSUPPORTED_DIAGNOSTIC_BUNDLE');
  if (!profile || typeof profile.states !== 'object') throw new Error('PROFILE_REQUIRED');
  const reports = bundle.samples.map(sample => {
    if (!['seat', 'seatengine'].includes(sample.apiStyle) || !['index', 'getstatus'].includes(sample.endpoint)) throw new Error('UNSUPPORTED_READONLY_ENDPOINT');
    const data = sample.body?.data;
    const candidate = data?.seatReserve ?? data?.reserve ?? data?.reservation ?? data?.curReserves?.[0] ?? data?.reserves?.[0] ?? data?.nearReserves?.[0] ?? data?.recentReserves?.[0] ?? (data?.id !== undefined ? data : undefined);
    const record = parseRecord(candidate);
    const target = record ? { roomId: record.roomId, seatNum: record.seatNum, startTime: record.startTime, endTime: record.endTime } : { roomId: '1', seatNum: '001', startTime: '08:30', endTime: '22:00' };
    const env = { STATUS_PROFILE_VERIFIED: 'true', STATUS_PROFILE_JSON: JSON.stringify(profile) };
    const day = record?.day ?? '2000-01-02';
    const snapshot = sample.httpStatus !== 200 ? { state: 'UNKNOWN', reason: 'HTTP_NOT_SUCCESSFUL' } : sample.endpoint === 'index'
      ? parseIndex(sample.body ?? {}, env, target, day) : parseDetail(sample.body ?? {}, env, target, day, String(candidate?.id ?? '0'));
    return { apiStyle: sample.apiStyle, endpoint: sample.endpoint, state: snapshot.state, reason: snapshot.reason, needsVerification: snapshot.state === 'UNKNOWN' };
  });
  // Parseability does not establish school state meanings, eligibility, reachability or production compatibility.
  return { offlineOnly: true, productionCompatibilityConfirmed: false, reports };
}
async function main() {
  const [sampleFile, profileFile, extra] = process.argv.slice(2);
  if (!sampleFile || !profileFile || extra) throw new Error('USAGE: node scripts/check-contract.mjs diagnostics.json profile.json');
  const bundle = JSON.parse(await readFile(sampleFile, 'utf8')), profile = JSON.parse(await readFile(profileFile, 'utf8'));
  process.stdout.write(JSON.stringify(checkContract(bundle, profile), null, 2) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { process.stderr.write('Contract check failed: invalid files or unsupported sample; no sample content was printed.\n'); process.exitCode = 1; });
