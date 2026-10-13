// Account + role persistence.
//
// Cookie material stays on the server: the browser only ever receives account
// ids, nicknames, role lists and record payloads. The store is a small JSON file
// under ./data so the app survives restarts.

import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { isGameEnabled } from '../mihoyo/constants.js';
import { CredentialVault, credentialVaultConstants } from './credential-vault.js';

const DEFAULT_FILE = resolve(
  process.cwd(),
  'data',
  process.env.DSH_HSR_DATA_FILE || 'accounts.json',
);

const isEncryptedStore = (value) => value
  && value.format === credentialVaultConstants.format
  && value.version === credentialVaultConstants.storageVersion
  && value.encryption;

const parseAccounts = (value) => {
  if (!Array.isArray(value?.accounts)) return [];
  return value.accounts.filter((account) => account?.id);
};

const writeSecureFile = async (file, content) => {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(tmp, 'wx', 0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;

    try {
      await rename(tmp, file);
    } catch (err) {
      if (process.platform !== 'win32' || !['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(err.code)) {
        throw err;
      }
      // Windows rename does not replace an existing destination consistently.
      // The destination is overwritten only with the already-encrypted payload.
      await writeFile(file, content, { encoding: 'utf8', mode: 0o600, flag: 'w' });
      await chmod(file, 0o600);
      await unlink(tmp);
      return;
    }
    await chmod(file, 0o600);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await unlink(tmp).catch(() => {});
  }
};

export class AccountStore {
  /** @param {{ file?:string, vault?:CredentialVault }} [options] */
  constructor(options = {}) {
    this.file = options.file || DEFAULT_FILE;
    this.vault = options.vault || new CredentialVault();
    /** @type {Map<string, any>} */
    this.accounts = new Map();
    this.loaded = false;
    this.loadPromise = null;
    this.writeChain = Promise.resolve();
  }

  async load() {
    if (this.loaded) return;
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.#load();
    try {
      await this.loadPromise;
      this.loaded = true;
    } finally {
      this.loadPromise = null;
    }
  }

  async #load() {
    let raw;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw new Error(`无法读取账号存储 ${this.file}`, { cause: err });
    }
    if (process.platform !== 'win32') await chmod(this.file, 0o600);

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.warn(`[store] 无法解析 ${this.file}: ${err.message}`);
      return;
    }

    let legacy = false;
    if (isEncryptedStore(parsed)) {
      const plaintext = await this.vault.decrypt(parsed);
      try {
        parsed = JSON.parse(plaintext);
      } catch (err) {
        throw new Error('解密后的账号存储不是有效 JSON', { cause: err });
      }
    } else if (Array.isArray(parsed?.accounts)) {
      legacy = true;
    } else {
      console.warn(`[store] ${this.file} 不是可识别的账号存储格式`);
      return;
    }

    this.accounts.clear();
    for (const account of parseAccounts(parsed)) this.accounts.set(account.id, account);

    if (legacy) {
      // Persist before exposing the migrated accounts. If encryption is not
      // available, startup fails instead of leaving credentials in plaintext.
      await this.persist();
    }
  }

  async persist() {
    const payload = JSON.stringify({
      version: 1,
      savedAt: new Date().toISOString(),
      accounts: [...this.accounts.values()],
    });
    const encrypted = await this.vault.encrypt(payload);
    await writeSecureFile(this.file, `${JSON.stringify(encrypted)}\n`);
  }

  // Serialize writes so concurrent requests cannot interleave file writes.
  save() {
    const next = this.writeChain
      .catch(() => {})
      .then(() => this.persist());
    this.writeChain = next.catch((err) => {
      console.warn(`[store] 保存失败: ${err.message}`);
      throw err;
    });
    return this.writeChain;
  }

  /**
   * Create or update the account behind a login.
   * @param {{ accountId:string, nickname?:string, cookie:Record<string,string>,
   *           deviceId?:string, source?:string }} input
   */
  async upsertAccount(input) {
    await this.load();
    let account = [...this.accounts.values()].find((a) => a.accountId === input.accountId);
    if (!account) {
      account = {
        id: randomUUID(),
        accountId: input.accountId,
        createdAt: new Date().toISOString(),
        roles: [],
      };
    }
    account.nickname = input.nickname || account.nickname || null;
    account.cookie = input.cookie;
    account.deviceId = input.deviceId || account.deviceId || randomUUID();
    account.source = input.source || account.source || 'qr';
    account.lastLoginAt = new Date().toISOString();
    this.accounts.set(account.id, account);
    await this.save();
    return account;
  }

  async getAccount(id) {
    await this.load();
    return this.accounts.get(id) || null;
  }

  /**
   * 直接塞一个**已经组装好的账号**（虚拟账号走这条）。
   *
   * 为什么不用 `upsertAccount()`：那个是登录流程用的，它会按 `accountId` 复用既有账号、
   * 写 `cookie` / `lastLoginAt`，而虚拟账号① 没有 cookie、② 必须自带 `snapshots`。
   *
   * ⚠️ **只增不改也不删**：用户 2026-10-12 明确要求「我原先的自己的账号（光明火柴）别删了」——
   * 这个方法绝不能碰已有账号；id 撞了就报错，让调用方换个 id。
   */
  async addAccount(account) {
    await this.load();
    if (!account?.id) throw new Error('账号缺少 id');
    if (this.accounts.has(account.id)) throw new Error(`账号 id 已存在：${account.id}`);
    this.accounts.set(account.id, account);
    await this.save();
    return account;
  }

  async listAccounts() {
    await this.load();
    return [...this.accounts.values()];
  }

  /**
   * **替换**一个虚拟账号的角色名单（用户 2026-10-13 第 3 条：「用户可给这个虚拟账号
   * 自定义添加角色」）。
   *
   * 为什么必须是「替换」而不是走 `setSnapshot()`：那个方法有一条**保留最长名单**的
   * 合并规则（`prevChars.length > nextChars.length` 时用旧的那份），那是为真实账号的
   * 「刷新失败别把已知角色擦掉」设计的。用户在这里**就是要增删**，走那条路会把
   * 「删掉两个角色」的编辑静默回滚成原样（形状完全一致，只是少了两行 —— 不报错）。
   *
   * ⚠️ **只允许虚拟账号**：真实账号的快照来自米游社，本地改写会让界面显示一份服务器上
   * 并不存在的角色表。这里显式挡掉，不靠调用方自觉。
   * ⚠️ 仍然**不新增也不删除账号**（`addAccount` 那条硬约束不变）。
   *
   * @param {string} accountId 账号 id（必须是虚拟账号）
   * @param {string} uid 角色 uid
   * @param {{snapshot:object, roster:{chars:object, cones:object}}} payload
   */
  async setVirtualRoster(accountId, uid, payload = {}) {
    await this.load();
    const account = this.accounts.get(accountId);
    if (!account) return null;
    if (account.source !== 'virtual') {
      throw new Error('只有虚拟账号可以自定义角色名单');
    }
    const key = String(uid);
    account.snapshots = account.snapshots || {};
    // 整份替换（不是合并）：用户删掉的角色必须真的消失。
    account.snapshots[key] = { ...(payload.snapshot || {}), uid: key, source: 'virtual' };
    // 记下这份名单原文：界面下次打开编辑器要按它预填（快照只有最终状态，反推不回来）。
    account.virtualRoster = {
      chars: { ...(payload.roster?.chars || {}) },
      cones: { ...(payload.roster?.cones || {}) },
      // 光锥 → 挂在谁身上：用户在编辑器里是**逐个角色**配锥的，非专属锥的主人推不出来。
      coneOwners: { ...(payload.roster?.coneOwners || {}) },
      updatedAt: new Date().toISOString(),
    };
    await this.save();
    return account;
  }

  async removeAccount(id) {
    await this.load();
    const existed = this.accounts.delete(id);
    if (existed) await this.save();
    return existed;
  }

  /** Replace the cached role list for an account. */
  async setRoles(accountId, roles) {
    const account = await this.getAccount(accountId);
    if (!account) return null;
    account.roles = roles.map((role) => ({
      uid: String(role.game_uid ?? role.uid),
      nickname: role.nickname ?? null,
      level: role.level ?? null,
      region: role.region ?? null,
      regionName: role.region_name ?? null,
      gameBiz: role.game_biz ?? null,
      // Game key is retained to filter role data from older account files.
      game: role.game ?? null,
    }));
    account.rolesUpdatedAt = new Date().toISOString();
    await this.save();
    return account.roles;
  }

  /**
   * Cache a snapshot so a reload - or a miHoYo risk-control block - still shows
   * the characters we already know about.
   *
   * Snap Hutao behaves the same way: `AvatarInfoRepositoryOperation` returns the
   * rows it already has in its SQLite database whenever the record API answers a
   * non-zero retcode. Without this, a transient 5003/10041 looks identical to
   * "this account has no characters".
   *
   * Roster data is merged rather than replaced, so a partial failure never
   * erases a previously complete character list.
   */
  async setSnapshot(accountId, uid, snapshot) {
    const account = await this.getAccount(accountId);
    if (!account) return;
    account.snapshots = account.snapshots || {};
    const key = String(uid);
    const previous = account.snapshots[key];
    const incoming = { ...snapshot, uid: key };
    const carriedSections = new Set();

    if (previous) {
      // Keep the longest character list we have ever seen.
      const prevChars = Array.isArray(previous.characters) ? previous.characters : [];
      const nextChars = Array.isArray(incoming.characters) ? incoming.characters : [];
      if (prevChars.length > nextChars.length) {
        incoming.characters = prevChars;
        incoming.charactersStale = true;
        carriedSections.add('characters');
      }
      const prevDetails = Array.isArray(previous.details) ? previous.details : [];
      const nextDetails = Array.isArray(incoming.details) ? incoming.details : [];
      if (prevDetails.length > nextDetails.length) {
        incoming.details = prevDetails;
        incoming.detailsStale = true;
        carriedSections.add('details');
      }
      // Carry forward sections this attempt could not reach.
      for (const field of ['index', 'basicInfo', 'avatars', 'dailyNote', 'abyss', 'challenge', 'rogue', 'card']) {
        if (incoming[field] === null || incoming[field] === undefined) {
          if (previous[field] !== undefined) {
            incoming[field] = previous[field];
            carriedSections.add(field);
          }
        }
      }
    }

    const sectionFields = ['index', 'basicInfo', 'avatars', 'characters', 'challenge', 'rogue', 'card'];
    const sectionFreshness = {};
    for (const field of sectionFields) {
      const prior = previous?.sectionFreshness?.[field];
      const value = incoming[field];
      const hasValue = value !== null && value !== undefined
        && (!Array.isArray(value) || value.length > 0);
      const stale = carriedSections.has(field)
        || (field === 'characters' && incoming.charactersStale)
        || (field === 'details' && incoming.detailsStale);
      const warning = (incoming.warnings || []).find((entry) => {
        const label = String(entry?.section || '');
        return field === 'index' ? label.includes('总览')
          : field === 'basicInfo' ? label.includes('基本信息')
            : ['avatars', 'characters', 'details'].includes(field) ? label.includes('角色详情')
              : field === 'challenge' ? label.includes('忘却之庭')
                : field === 'rogue' ? label.includes('模拟宇宙')
                  : field === 'card' ? label.includes('公开卡片') : false;
      });
      const status = stale ? 'stale' : warning ? (hasValue ? 'partial' : 'failed') : hasValue ? 'fresh' : 'failed';
      sectionFreshness[field] = {
        status,
        fetchedAt: stale ? (prior?.fetchedAt || previous?.fetchedAt || null) : incoming.fetchedAt,
        lastSuccessfulFetchAt: stale
          ? (prior?.lastSuccessfulFetchAt || prior?.fetchedAt || previous?.fetchedAt || null)
          : hasValue && !warning ? incoming.fetchedAt : (prior?.lastSuccessfulFetchAt || null),
        staleReason: stale ? '本次未能更新，沿用上次成功数据。' : warning?.message || null,
      };
    }
    incoming.sectionFreshness = sectionFreshness;

    account.snapshots[key] = incoming;
    await this.save();
    return incoming;
  }

  /** Persist the miHoYo device fingerprint (`x-rpc-device_fp`) for an account. */
  async setFingerprint(accountId, fingerprint) {
    const account = await this.getAccount(accountId);
    if (!account || !fingerprint) return null;
    account.fingerprint = fingerprint;
    account.fingerprintAt = new Date().toISOString();
    await this.save();
    return fingerprint;
  }

  async getSnapshot(accountId, uid) {
    const account = await this.getAccount(accountId);
    return account?.snapshots?.[String(uid)] || null;
  }

  /**
   * Cache the 高难副本战斗记录（四个副本的队伍/回合/积分）。
   *
   * 和快照分开存：快照是「角色信息」分页要的东西，战斗记录是几十 KB 的独立
   * 结构，而且刷新时机不同（战斗记录要按副本轮换来看，不必每次读角色都重抓）。
   * 存下来的意义和快照一样：界面首屏直接读缓存，只有点「刷新米游社战绩」才真发请求，
   * 不至于每次翻页都去打米游社。
   */
  async setBattleRecords(accountId, uid, records) {
    const account = await this.getAccount(accountId);
    if (!account) return null;
    account.battleRecords = account.battleRecords || {};
    const key = String(uid);
    const incoming = { ...records, uid: key };
    // 某一节抓失败时不要把它上一份数据抹掉：四个端点各自独立，能拿到几个算几个。
    const previous = account.battleRecords[key];
    if (previous) {
      for (const field of Object.keys(incoming)) {
        if (field === 'raw') continue;
        if (incoming[field] === null || incoming[field] === undefined) {
          if (previous[field] !== undefined) incoming[field] = previous[field];
        }
      }
      incoming.partial = Boolean(records.partial);
      incoming.previousFetchedAt = previous.fetchedAt || null;
    }
    incoming.raw = { ...(previous?.raw || {}), ...(records.raw || {}) };
    const errors = new Set((records.errors || []).map((entry) => entry.endpoint));
    const sectionFreshness = {};
    for (const section of ['challenge', 'story', 'boss', 'peak', 'brief']) {
      const failed = errors.has(section) || (section === 'peak' && errors.has('peak3'));
      const hasValue = incoming.raw[section] !== undefined && incoming.raw[section] !== null;
      const prior = previous?.sectionFreshness?.[section];
      const status = failed ? (hasValue ? 'stale' : 'failed') : hasValue ? 'fresh' : 'failed';
      sectionFreshness[section] = {
        status,
        fetchedAt: failed ? (prior?.fetchedAt || previous?.fetchedAt || null) : incoming.fetchedAt,
        lastSuccessfulFetchAt: failed
          ? (prior?.lastSuccessfulFetchAt || prior?.fetchedAt || previous?.fetchedAt || null)
          : hasValue ? incoming.fetchedAt : (prior?.lastSuccessfulFetchAt || null),
        staleReason: failed ? '本次接口未能更新，显示上次成功数据。' : null,
      };
    }
    incoming.sectionFreshness = sectionFreshness;
    account.battleRecords[key] = incoming;
    await this.save();
    return incoming;
  }

  async getBattleRecords(accountId, uid) {
    const account = await this.getAccount(accountId);
    return account?.battleRecords?.[String(uid)] || null;
  }

  /** Browser-safe projection: never contains cookie material. */
  static toPublic(account) {
    if (!account) return null;
    return {
      id: account.id,
      accountId: account.accountId,
      nickname: account.nickname,
      source: account.source,
      createdAt: account.createdAt,
      lastLoginAt: account.lastLoginAt,
      rolesUpdatedAt: account.rolesUpdatedAt || null,
      // Roles of a switched-off game are dropped here as well as at refresh
      // time, so an account stored before the game was disabled does not keep
      // showing stale entries the GUI has no button for.
      roles: (account.roles || []).filter((role) => isGameEnabled(role.game || 'hsr')),
      snapshotUids: Object.keys(account.snapshots || {}),
      // The fingerprint VALUE must never reach the browser; only its presence.
      hasFingerprint: Boolean(account.fingerprint),
      // 虚拟账号的两个只读标记（用户 2026-10-13 第 3 条）：界面靠 `source === 'virtual'`
      // 决定「角色列表末尾要不要出现『＋ 添加角色』」，靠 `virtualPreset` 说明它是按
      // 哪套预设造的。⚠️ **不下发 `virtualRoster`**：名单原文可能上百个键，而编辑器
      // 打开时走 `GET /api/virtual-accounts/:id/roster` 单独取（那份也顺手把
      // 「同命途光锥有哪些」一起给全）；混进账号列表会让每次 `/api/config` 都白白变大。
      virtualPreset: account.source === 'virtual' ? (account.virtualPreset || null) : undefined,
      hasVirtualRoster: account.source === 'virtual' ? Boolean(account.virtualRoster) : undefined,
    };
  }
}
