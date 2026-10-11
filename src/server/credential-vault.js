import { spawn } from 'node:child_process';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto';

const DEFAULT_KEY_ENV = 'DSH_HSR_CREDENTIAL_KEY';
const FORMAT = 'dsh-hsr-account-store';
const STORAGE_VERSION = 2;
const AES_ALGORITHM = 'aes-256-gcm';
const AES_SALT_BYTES = 16;
const AES_IV_BYTES = 12;
const AES_KEY_BYTES = 32;
const SCRYPT_OPTIONS = {
  N: 16_384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
};

const DPAPI_ENCRYPT_SCRIPT = [
  '$encoded = [Console]::In.ReadToEnd().Trim()',
  '$bytes = [Convert]::FromBase64String($encoded)',
  'Add-Type -AssemblyName System.Security',
  '$protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Convert]::ToBase64String($protected))',
].join('; ');

const DPAPI_DECRYPT_SCRIPT = [
  '$encoded = [Console]::In.ReadToEnd().Trim()',
  '$bytes = [Convert]::FromBase64String($encoded)',
  'Add-Type -AssemblyName System.Security',
  '$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Convert]::ToBase64String($plain))',
].join('; ');
export class CredentialVaultError extends Error {
  /** @param {string} code @param {string} message @param {unknown} [cause] */
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'CredentialVaultError';
    this.code = code;
  }
}

const isWindows = (value) => value === 'win32';

const toBase64 = (value) => Buffer.from(value).toString('base64');

const fromBase64 = (value, label) => {
  if (typeof value !== 'string' || !value) {
    throw new CredentialVaultError('CREDENTIAL_FORMAT_INVALID', `凭证存储缺少 ${label}`);
  }
  try {
    return Buffer.from(value, 'base64');
  } catch (err) {
    throw new CredentialVaultError('CREDENTIAL_FORMAT_INVALID', `凭证存储的 ${label} 无效`, err);
  }
};

const deriveAesKey = (secret, salt) => scryptSync(
  Buffer.from(secret, 'utf8'),
  salt,
  AES_KEY_BYTES,
  SCRYPT_OPTIONS,
);

const runPowerShell = (command, script, input) => new Promise((resolve, reject) => {
  const child = spawn(command, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let settled = false;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('error', (err) => {
    if (settled) return;
    settled = true;
    reject(new CredentialVaultError(
      'CREDENTIAL_BACKEND_UNAVAILABLE',
      'Windows DPAPI 不可用，无法安全保存账号凭证',
      err,
    ));
  });
  child.once('close', (code) => {
    if (settled) return;
    settled = true;
    if (code !== 0) {
      reject(new CredentialVaultError(
        'CREDENTIAL_CRYPTO_FAILED',
        'Windows DPAPI 加解密失败',
        new Error(stderr.trim() || `PowerShell exited with code ${code}`),
      ));
      return;
    }
    resolve(stdout.trim());
  });
  child.stdin.end(input, 'utf8');
});

const validatePlaintext = (plaintext) => {
  if (typeof plaintext !== 'string') {
    throw new CredentialVaultError('CREDENTIAL_INPUT_INVALID', '凭证存储内容必须是字符串');
  }
};

export class CredentialVault {
  /**
   * @param {{ platform?:string, env?:NodeJS.ProcessEnv, keyEnv?:string,
   *           powershellPath?:string }} [options]
   */
  constructor(options = {}) {
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.keyEnv = options.keyEnv || DEFAULT_KEY_ENV;
    this.powershellPath = options.powershellPath || 'powershell.exe';
  }

  get provider() {
    return isWindows(this.platform) ? 'windows-dpapi' : 'aes-256-gcm';
  }

  get keyConfigured() {
    return isWindows(this.platform) || Boolean(this.env[this.keyEnv]);
  }

  assertAvailable() {
    if (isWindows(this.platform)) return;
    if (!this.env[this.keyEnv]) {
      throw new CredentialVaultError(
        'CREDENTIAL_KEY_MISSING',
        `非 Windows 系统必须设置 ${this.keyEnv}，否则不会持久化账号凭证`,
      );
    }
  }

  async encrypt(plaintext) {
    validatePlaintext(plaintext);
    if (isWindows(this.platform)) return this.#encryptWithDpapi(plaintext);
    this.assertAvailable();

    const salt = randomBytes(AES_SALT_BYTES);
    const iv = randomBytes(AES_IV_BYTES);
    const key = deriveAesKey(this.env[this.keyEnv], salt);
    const cipher = createCipheriv(AES_ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(plaintext, 'utf8')),
      cipher.final(),
    ]);
    return {
      format: FORMAT,
      version: STORAGE_VERSION,
      encryption: {
        provider: 'aes-256-gcm',
        algorithm: AES_ALGORITHM,
        kdf: 'scrypt',
        salt: toBase64(salt),
        iv: toBase64(iv),
        authTag: toBase64(cipher.getAuthTag()),
        ciphertext: toBase64(ciphertext),
      },
    };
  }

  async decrypt(envelope) {
    if (!envelope || envelope.format !== FORMAT || envelope.version !== STORAGE_VERSION) {
      throw new CredentialVaultError('CREDENTIAL_FORMAT_INVALID', '凭证存储格式或版本无效');
    }
    const encryption = envelope.encryption;
    if (!encryption || typeof encryption.provider !== 'string') {
      throw new CredentialVaultError('CREDENTIAL_FORMAT_INVALID', '凭证存储缺少加密信息');
    }
    if (encryption.provider === 'windows-dpapi') {
      if (!isWindows(this.platform)) {
        throw new CredentialVaultError(
          'CREDENTIAL_BACKEND_UNAVAILABLE',
          '该账号存储使用 Windows 当前用户 DPAPI，只能在原 Windows 用户环境中解密',
        );
      }
      return this.#decryptWithDpapi(encryption.ciphertext);
    }
    if (encryption.provider !== 'aes-256-gcm') {
      throw new CredentialVaultError('CREDENTIAL_FORMAT_INVALID', '不支持的凭证加密方式');
    }
    if (encryption.algorithm !== AES_ALGORITHM || encryption.kdf !== 'scrypt') {
      throw new CredentialVaultError('CREDENTIAL_FORMAT_INVALID', '不支持的 AES 凭证格式');
    }
    this.assertAvailable();

    const salt = fromBase64(encryption.salt, 'salt');
    const iv = fromBase64(encryption.iv, 'iv');
    const authTag = fromBase64(encryption.authTag, 'authTag');
    const ciphertext = fromBase64(encryption.ciphertext, 'ciphertext');
    if (salt.length !== AES_SALT_BYTES || iv.length !== AES_IV_BYTES || authTag.length !== 16) {
      throw new CredentialVaultError('CREDENTIAL_FORMAT_INVALID', 'AES 凭证参数长度无效');
    }

    try {
      const key = deriveAesKey(this.env[this.keyEnv], salt);
      const decipher = createDecipheriv(AES_ALGORITHM, key, iv);
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch (err) {
      throw new CredentialVaultError(
        'CREDENTIAL_DECRYPT_FAILED',
        '无法解密账号凭证，可能是密钥错误或文件已损坏',
        err,
      );
    }
  }

  async #encryptWithDpapi(plaintext) {
    const encoded = Buffer.from(plaintext, 'utf8').toString('base64');
    const ciphertext = await runPowerShell(this.powershellPath, DPAPI_ENCRYPT_SCRIPT, encoded);
    if (!ciphertext) {
      throw new CredentialVaultError('CREDENTIAL_CRYPTO_FAILED', 'Windows DPAPI 未返回加密结果');
    }
    return {
      format: FORMAT,
      version: STORAGE_VERSION,
      encryption: {
        provider: 'windows-dpapi',
        algorithm: 'dpapi-current-user',
        ciphertext,
      },
    };
  }

  async #decryptWithDpapi(ciphertext) {
    if (typeof ciphertext !== 'string' || !ciphertext) {
      throw new CredentialVaultError('CREDENTIAL_FORMAT_INVALID', 'Windows DPAPI 密文无效');
    }
    const encoded = await runPowerShell(this.powershellPath, DPAPI_DECRYPT_SCRIPT, ciphertext);
    try {
      return Buffer.from(encoded, 'base64').toString('utf8');
    } catch (err) {
      throw new CredentialVaultError('CREDENTIAL_DECRYPT_FAILED', 'Windows DPAPI 解密结果无效', err);
    }
  }
}

export const credentialVaultConstants = Object.freeze({
  defaultKeyEnv: DEFAULT_KEY_ENV,
  format: FORMAT,
  storageVersion: STORAGE_VERSION,
});
