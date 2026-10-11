import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AccountStore } from '../src/server/store.js';
import { CredentialVault } from '../src/server/credential-vault.js';

const KEY_ENV = 'DSH_HSR_CREDENTIAL_KEY';

const expectCode = async (promise, code) => {
  await assert.rejects(promise, (error) => error?.code === code);
};

const main = async () => {
  const root = await mkdtemp(join(tmpdir(), 'hsr-credential-vault-'));
  try {
    const vault = new CredentialVault({
      platform: 'linux',
      env: { [KEY_ENV]: 'test-key' },
    });
    const plaintext = 'cookie_token=test-secret; account_id=123';
    const encrypted = await vault.encrypt(plaintext);
    assert.equal(encrypted.encryption.provider, 'aes-256-gcm');
    assert.equal(await vault.decrypt(encrypted), plaintext);

    const tampered = structuredClone(encrypted);
    const ciphertext = Buffer.from(tampered.encryption.ciphertext, 'base64');
    ciphertext[0] ^= 1;
    tampered.encryption.ciphertext = ciphertext.toString('base64');
    await expectCode(vault.decrypt(tampered), 'CREDENTIAL_DECRYPT_FAILED');

    const file = join(root, 'accounts.json');
    const legacy = {
      version: 1,
      accounts: [{
        id: 'account-1',
        accountId: '123',
        cookie: { cookie_token: 'legacy-secret', account_id: '123' },
        fingerprint: 'legacy-fingerprint',
        roles: [],
      }],
    };
    await writeFile(file, JSON.stringify(legacy), 'utf8');
    const store = new AccountStore({ file, vault });
    await store.load();
    const account = await store.getAccount('account-1');
    assert.equal(account.cookie.cookie_token, 'legacy-secret');
    const migrated = await readFile(file, 'utf8');
    assert.ok(!migrated.includes('legacy-secret'));
    assert.ok(!migrated.includes('legacy-fingerprint'));
    assert.equal(JSON.parse(migrated).encryption.provider, 'aes-256-gcm');

    const reopened = new AccountStore({ file, vault });
    await reopened.load();
    assert.deepEqual((await reopened.getAccount('account-1')).cookie, account.cookie);

    const noKeyFile = join(root, 'no-key.json');
    await writeFile(noKeyFile, JSON.stringify(legacy), 'utf8');
    const noKeyStore = new AccountStore({
      file: noKeyFile,
      vault: new CredentialVault({ platform: 'linux', env: {} }),
    });
    await expectCode(noKeyStore.load(), 'CREDENTIAL_KEY_MISSING');
    assert.ok((await readFile(noKeyFile, 'utf8')).includes('legacy-secret'));

    if (process.platform === 'win32') {
      const dpapi = new CredentialVault({ platform: 'win32' });
      const protectedValue = await dpapi.encrypt(plaintext);
      assert.equal(protectedValue.encryption.provider, 'windows-dpapi');
      assert.equal(await dpapi.decrypt(protectedValue), plaintext);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

await main();
console.log('credential vault tests passed');
