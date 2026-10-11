// Device fingerprint (`x-rpc-device_fp`) for the miHoYo record API.
//
// Transcribed from Snap Hutao's `Service/User/UserFingerprintService.cs` and
// `Web/Hoyolab/PublicData/DeviceFp/*.cs`. The important findings:
//
//   * Every signed record request carries `x-rpc-device_fp` (see
//     `HoyolabHttpRequestMessageBuilderExtension.SetUserCookieAndFpHeader`).
//     Omitting it is what makes a hand-rolled client look unlike the real app.
//   * The value is NOT static: it is POSTed to
//     `https://public-data-api.mihoyo.com/device-fp/api/getFp` and the server
//     returns the authoritative `device_fp`.
//   * That getFp call needs no cookie, no DS and no x-rpc headers - only a JSON
//     body with an `ext_fields` blob describing a plausible Android device.
//   * Snap Hutao caches the result for 7 days
//     (`FingerprintLastUpdateTime >= UtcNow - 7 days`), because the seed is
//     rate limited.
//
// The exact `ext_fields` shape matters: the server validates it.

import { randomUUID, randomBytes } from 'node:crypto';

const GET_FP_URL = 'https://public-data-api.mihoyo.com/device-fp/api/getFp';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** `Core.Random.GetLowerHexString(n)` - n lowercase hex characters. */
const lowerHex = (n) => randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);

/** `Core.Random.GetUpperAndNumberString(n)` - uppercase alphanumerics. */
const upperAndNumber = (n) => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  for (let i = 0; i < n; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
};

/**
 * Build the `ext_fields` object. Values are copied verbatim from
 * `UserFingerprintService.TryInitializeAsync`; only `deviceName`, `productName`,
 * `model` and `display` are randomised per call, exactly as upstream does.
 */
export const buildExtFields = () => {
  const device = upperAndNumber(12);
  const product = upperAndNumber(6);
  return {
    proxyStatus: 0,
    isRoot: 0,
    romCapacity: '512',
    deviceName: device,
    productName: product,
    romRemain: '512',
    hostname: 'dg02-pool03-kvm87',
    screenSize: '1440x2905',
    isTablet: 0,
    aaid: '',
    model: device,
    brand: 'XiaoMi',
    hardware: 'qcom',
    deviceType: 'OP5913L1',
    devId: 'REL',
    serialNumber: 'unknown',
    sdCapacity: 512215,
    buildTime: '1693626947000',
    buildUser: 'android-build',
    simState: 5,
    ramRemain: '239814',
    appUpdateTimeDiff: 1702604034482,
    deviceInfo: `XiaoMi\\/${product}\\/OP5913L1:13\\/SKQ1.221119.001\\/`
      + 'T.118e6c7-5aa23-73911:user\\/release-keys',
    vaid: '',
    buildType: 'user',
    sdkVersion: '34',
    ui_mode: 'UI_MODE_TYPE_NORMAL',
    isMockLocation: 0,
    cpuType: 'arm64-v8a',
    isAirMode: 0,
    ringMode: 2,
    chargeStatus: 1,
    manufacturer: 'XiaoMi',
    emulatorStatus: 0,
    appMemory: '512',
    osVersion: '14',
    vendor: 'unknown',
    accelerometer: '1.4883357x7.1712894x6.2847486',
    sdRemain: 239600,
    buildTags: 'release-keys',
    packageName: 'com.mihoyo.hyperion',
    networkType: 'WiFi',
    oaid: '',
    debugStatus: 1,
    ramCapacity: '469679',
    magnetometer: '20.081251x-27.487501x2.1937501',
    display: `${product}_13.1.0.181(CN01)`,
    appInstallTimeDiff: 1688455751496,
    packageVersion: '2.20.1',
    gyroscope: '0.030226856x0.014647375x0.010652636',
    batteryStatus: 100,
    hasKeyboard: 0,
    board: 'taro',
  };
};

/**
 * Assemble the getFp request body (`DeviceFpData`).
 * @param {string} bbsDeviceId the `x-rpc-device_id` GUID for this account
 * @param {string} [existingFp] reuse a previous fp so the device stays stable
 */
export const buildFingerprintBody = (bbsDeviceId, existingFp) => ({
  device_id: lowerHex(16),
  bbs_device_id: bbsDeviceId,
  seed_id: randomUUID(),
  seed_time: String(Date.now()),
  platform: '2',
  device_fp: existingFp || lowerHex(13),
  app_name: 'bbs_cn',
  ext_fields: JSON.stringify(buildExtFields()),
});

/**
 * Ask miHoYo for a device fingerprint.
 *
 * Verified live: returns `{"retcode":0,"message":"OK","data":{"device_fp":
 * "38d81ce7ac48d","code":200,"msg":"ok"}}` - note the value lives under
 * `data.device_fp`, and `data.code` is a *different*, nested status field.
 *
 * @param {string} bbsDeviceId
 * @param {{ existingFp?:string, timeoutMs?:number, appVersion?:string }} [options]
 * @returns {Promise<string|null>} the fingerprint, or null when unavailable
 */
export const fetchDeviceFingerprint = async (bbsDeviceId, options = {}) => {
  const body = buildFingerprintBody(bbsDeviceId, options.existingFp);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000);
  try {
    const response = await fetch(GET_FP_URL, {
      method: 'POST',
      headers: {
        // `HttpClientConfiguration.Default` sets only the Hutao device headers.
        'User-Agent': `Snap Hutao/${options.appVersion || '1.20.3.0'}`,
        'x-hutao-device-id': bbsDeviceId,
        'x-hutao-device-os': 'Windows 11',
        'x-hutao-device-name': 'DESKTOP',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      return null;
    }
    if (json?.retcode !== 0) return null;
    const fp = json?.data?.device_fp;
    return typeof fp === 'string' && fp ? fp : null;
  } catch {
    // A fingerprint is an optimisation, never a hard requirement: the record
    // API still answers without it. Degrade quietly.
    return null;
  } finally {
    clearTimeout(timeout);
  }
};

/**
 * Return a cached fingerprint when it is still fresh.
 * Mirrors Snap Hutao's 7-day window.
 * @param {{ fingerprint?:string, fingerprintAt?:string|number }} account
 */
export const cachedFingerprint = (account) => {
  if (!account?.fingerprint) return null;
  const at = account.fingerprintAt ? new Date(account.fingerprintAt).getTime() : 0;
  if (!at) return account.fingerprint;
  return Date.now() - at < CACHE_TTL_MS ? account.fingerprint : null;
};

export const FINGERPRINT_TTL_MS = CACHE_TTL_MS;
