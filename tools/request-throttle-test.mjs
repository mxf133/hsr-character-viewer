import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

process.env.DSH_HSR_MIN_INTERVAL_MS = '30';
process.env.DSH_HSR_MAX_BURST = '2';
process.env.DSH_HSR_BURST_WINDOW_MS = '240';

const { request, throttleStats } = await import('../src/mihoyo/http.js');
const starts = [];
globalThis.fetch = async () => {
  starts.push(performance.now());
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};

const call = (cookie, deviceId) => request('https://offline.test/', { cookie, deviceId });

await call('account_id=101; cookie_token=secret-a', 'device-a');
await call('cookie_token=secret-b; account_id=101', 'device-a');
let thirdAccountRequestFinished = false;
const thirdAccountRequest = call('account_id=101; cookie_token=secret-c', 'device-a')
  .then(() => { thirdAccountRequestFinished = true; });

await new Promise((resolve) => setTimeout(resolve, 5));
await call('account_id=202; cookie_token=secret-d', 'device-b');
assert.equal(thirdAccountRequestFinished, false, 'same-account burst must be capped');
await thirdAccountRequest;

await call(undefined, 'device-c');
await call(undefined, 'device-c');
let thirdDeviceRequestFinished = false;
const thirdDeviceRequest = call(undefined, 'device-c')
  .then(() => { thirdDeviceRequestFinished = true; });
await new Promise((resolve) => setTimeout(resolve, 5));
await call(undefined, 'device-d');
assert.equal(thirdDeviceRequestFinished, false, 'same-device burst must be capped independently');
await thirdDeviceRequest;

for (let index = 1; index < starts.length; index += 1) {
  assert.ok(starts[index] - starts[index - 1] >= 24, 'global minimum interval must apply across identities');
}
assert.ok(starts[3] - starts[0] >= 180, 'same account must wait for its burst window');
assert.ok(throttleStats().recentCount > 0 && throttleStats().recentCount <= starts.length);
console.log('请求节流离线测试通过：账号/设备隔离、identity 级 burst、全局最低间隔');
