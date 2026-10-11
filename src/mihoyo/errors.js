// Error type that carries the miHoYo retcode so the API layer can map it to a
// friendly, actionable message for the GUI.

export class MihoyoError extends Error {
  /**
   * @param {string} message human-readable (Chinese) message
   * @param {{ code?:string|number, retcode?:number, status?:number, cause?:unknown }} [info]
   */
  constructor(message, info = {}) {
    super(message);
    this.name = 'MihoyoError';
    this.code = info.code ?? 'MIHOYO_ERROR';
    this.retcode = info.retcode;
    this.status = info.status;
    if (info.cause) this.cause = info.cause;
  }
}

/**
 * Turn a miHoYo JSON envelope into either its `data` payload or a thrown error.
 * @param {{ status:number, json:any, text:string }} response
 * @param {string} action description used in error messages
 */
export const unwrap = (response, action) => {
  const { status, json, text } = response;
  if (!json || typeof json !== 'object') {
    throw new MihoyoError(
      `${action}失败：服务返回了非 JSON 响应（HTTP ${status}）`,
      { code: 'BAD_RESPONSE', status },
    );
  }
  if (json.retcode === 0) return json.data;

  const retcode = json.retcode;
  const message = json.message || '未知错误';
  const hint = hintForRetcode(retcode);
  throw new MihoyoError(
    `${action}失败：${message}${hint ? `（${hint}）` : ''}`,
    { code: retcode, retcode, status },
  );
};

/** Human hints for the retcodes this app can realistically hit. */
export const hintForRetcode = (retcode) => {
  switch (retcode) {
    case -100: return '登录状态已失效，请重新扫码';
    case 10001: return '未登录或 Cookie 不完整，请重新扫码';
    case -10001: return '请求签名无效，可能是客户端版本或 salt 需要更新';
    case 1008: return '角色与账号不匹配：请用角色列表里的游戏 UID（不是米游社账号 ID）';
    case -3001: return '请求头缺少参数';
    case -3005: return '请求参数不合法';
    case -3501: return '二维码已失效，请刷新后重新扫描';
    case -3505: return '已取消扫码，请重新生成二维码';
    // 10101 is "查看他人战绩次数过多" - a rate limit on looking up OTHER people's
    // records, not a statement that the account has no bound role.
    case 10101: return '查看他人战绩次数过多，请休息一会儿再试';
    case 10102: return '该 UID 的战绩未公开，或不属于当前账号';
    case 10103: return '该账号已被封禁，无法查看战绩';
    case 10104: return '角色信息未公开，请在游戏内开启「展示角色详情」';
    // 10035 is undocumented: the code is declared in the official Star Rail
    // record page bundle (as the constant `m`) but SHIPS NO MESSAGE for it, and
    // it does not appear in Snap Hutao's KnownReturnCode either.
    //
    // ROOT CAUSE, confirmed on a real account: the account was flagged
    // "账号可能存在异常" server-side. Opening the official Star Rail record page
    // inside the miHoYo app (MuMu emulator, adb + uiautomator dump) showed the
    // app itself refusing to render data and presenting:
    //     战绩 |《崩坏：星穹铁道》
    //     检测到账号可能存在异常，需要通过验证
    //     请在下图依次点击：
    // After the user completed that challenge once, EVERY record endpoint
    // returned retcode 0 on the same cookie - index (66 avatars), avatar/basic
    // (66), avatar/info (66 details), challenge (36 stars), note (stamina).
    // So 10035 means "anomaly verification required", not "not public".
    //
    // Established by elimination (all with the same cookie, where role/basicInfo
    // returns 0): not a missing header (x-rpc-page / device_name / sys_version /
    // platform / app_id / language / app version / salt all made no difference),
    // not the region parameter, not the web privacy switches, not intermittent.
    case 10035: return '该账号被米游社标记为「可能存在异常」，需要先完成一次验证。'
      + '请用米游社 App 打开官方星铁战绩页，按提示完成「依次点击」验证；'
      + '验证通过后回到本页点「刷新数据」即可正常读取';
    case 10041: return '触发米游社风控：操作过于频繁，请等待一段时间后再试（不要反复重试）';
    // 1034 is the code Snap Hutao handles via `RetryIf1034Async` + Geetest: the
    // account must complete a challenge before the record API will serve data.
    case 1034: return '需要先通过米游社验证：请打开一次官方战绩页并完成验证，再回到本页刷新';
    // 5003 is NOT "the record is not public". Snap Hutao's KnownReturnCode
    // documents it as "实时便笺: 当前账号存在风险，暂无数据" - a risk-control flag.
    // It is account-wide and temporary; only waiting clears it.
    case 5003: return '账号被米游社风控标记（当前账号存在风险，暂无数据）。这是临时状态，'
      + '通常几小时后自动解除；期间请勿反复重试，否则会延长风控';
    default: return '';
  }
};

/** Convenience wrapper: throw unless retcode is 0, then return data. */
export const ensureOk = (response, action) => unwrap(response, action);
