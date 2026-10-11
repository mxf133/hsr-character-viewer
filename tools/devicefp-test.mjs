// Verify the `x-rpc-device_fp` plumbing without touching the live API:
// intercept global fetch and inspect the headers each client produces.
import assert from 'node:assert/strict';

const captured = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  captured.push({ url: String(url), headers: { ...(init.headers || {}) }, body: init.body });
  return new Response(JSON.stringify({ retcode: 0, message: 'OK', data: {} }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};

const { buildExtFields, buildFingerprintBody, fetchDeviceFingerprint } = await import('../src/mihoyo/devicefp.js');
const sr = await import('../src/mihoyo/starrail.js');
const { GAMES } = await import('../src/mihoyo/constants.js');

let passed = 0;
const check = (label, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${label}`); } catch (err) { console.log(`  FAIL ${label}: ${err.message}`); process.exitCode = 1; }
};

console.log('\n▶ 设备指纹模块 (devicefp.js)');
const ext = buildExtFields();
check('ext_fields 关键字段齐全', () => {
  for (const key of ['deviceName', 'productName', 'deviceInfo', 'packageName', 'board', 'sdkVersion']) {
    assert.ok(key in ext, `missing ${key}`);
  }
  assert.equal(typeof ext.deviceInfo, 'string');
  assert.match(ext.deviceInfo, /^XiaoMi\\\//);
});
check('getFp 请求体字段名与 Snap Hutao 一致', () => {
  const body = buildFingerprintBody('device-guid-36');
  assert.deepEqual(Object.keys(body).sort(), [
    'app_name', 'bbs_device_id', 'device_fp', 'device_id', 'ext_fields',
    'platform', 'seed_id', 'seed_time',
  ]);
  assert.equal(body.app_name, 'bbs_cn');
  assert.equal(body.platform, '2');
  assert.equal(body.device_id.length, 16);
  assert.equal(body.device_fp.length, 13);
  assert.equal(typeof body.ext_fields, 'string');
  assert.ok(JSON.parse(body.ext_fields).deviceName);
});

console.log('\n▶ 指纹读取路径');
captured.length = 0;
globalThis.fetch = async (url, init = {}) => {
  captured.push({ url: String(url), headers: { ...(init.headers || {}) }, body: init.body });
  return new Response(JSON.stringify({
    retcode: 0, message: 'OK', data: { device_fp: 'abc123def4567', code: 200, msg: 'ok' },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};
const fp = await fetchDeviceFingerprint('device-guid-36');
check('从 data.device_fp 取值（不是顶层 device_fp）', () => {
  assert.equal(fp, 'abc123def4567');
  assert.equal(captured.length, 1);
  assert.match(captured[0].url, /public-data-api\.mihoyo\.com\/device-fp\/api\/getFp$/);
});

// `cachedFingerprint` enforces the 7-day window.
const { cachedFingerprint, FINGERPRINT_TTL_MS } = await import('../src/mihoyo/devicefp.js');
check('7 天内复用缓存指纹', () => {
  assert.equal(cachedFingerprint({ fingerprint: 'f', fingerprintAt: new Date().toISOString() }), 'f');
});
check('超过 7 天不再复用', () => {
  const old = new Date(Date.now() - FINGERPRINT_TTL_MS - 1000).toISOString();
  assert.equal(cachedFingerprint({ fingerprint: 'f', fingerprintAt: old }), null);
});
check('没有指纹时返回 null', () => {
  assert.equal(cachedFingerprint({}), null);
  assert.equal(cachedFingerprint(null), null);
});

console.log('\n▶ 记录请求是否带上 x-rpc-device_fp');
const OPTS = {
  cookie: { cookie_token: 'c', ltoken: 'l' },
  deviceId: 'device-guid-36',
  deviceFp: 'FP-VALUE-123',
  accountId: '76090888',
};

captured.length = 0;
await sr.getPlayerIndex('100000000', 'prod_gf_cn', OPTS).catch(() => {});
check('星铁 index 带指纹', () => {
  const call = captured.find((c) => c.url.includes('/hkrpg/api/index'));
  assert.ok(call, 'no hsr index call captured');
  assert.equal(call.headers['x-rpc-device_fp'], 'FP-VALUE-123');
});

captured.length = 0;
await sr.getStarRailCard('76090888', OPTS).catch(() => {});
check('公开卡片请求带指纹', () => {
  const call = captured.find((c) => c.url.includes('getGameRecordCard'));
  assert.ok(call, 'no card call captured');
  assert.equal(call.headers['x-rpc-device_fp'], 'FP-VALUE-123');
});

console.log('\n▶ 缺少指纹时不发送空 header');
captured.length = 0;
await sr.getRoleBasicInfo('100000000', 'prod_gf_cn', { cookie: { cookie_token: 'c' } }).catch(() => {});
check('未提供指纹则不带该 header', () => {
  const call = captured.find((c) => c.url.includes('role/basicInfo'));
  assert.ok(call, 'no call captured');
  assert.equal('x-rpc-device_fp' in call.headers, false);
});

console.log('\n▶ 游戏注册表完整性');
check('星铁注册了 gameBiz 与 recordPrefix', () => {
  assert.equal(GAMES.hsr.gameBiz, 'hkrpg_cn');
  assert.equal(GAMES.hsr.recordPrefix, 'hkrpg');
});

globalThis.fetch = realFetch;
console.log(`\n设备指纹接线测试: ${passed} passed`);
