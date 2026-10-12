// 探针：验证「逐档榜的浮层被 `/api/archive/packs` 的数据补齐之后，跨版本发挥会不会 > 1」。
//
// 背景：`advice-view.js` 的 `enrichTierDetail()` 在「这一条还有没列出来的关卡」时
// （逐档榜只随载荷下发 **1 个** env，而 `envCount` 可能是 5），会用面板那一路的数据
// **整份替换 `unit.envs`**，然后重新调 `frontierTip()` 画因子表。
// 而 `slimCharacterPack()` **不发 `seasonMinCost`** —— `frontierFactorsOf()` 于是退回
// `meta.minCost`（**全窗口**最小值，比「该版本最便宜」更小），金数项变小、base 变小，
// 余数 = score ÷ base 就**超过 1**。
//
//   node tools/_probe-packs-season-factor.mjs [--url=http://127.0.0.1:8371] [--chars=8]
import { frontierFactorsOf } from '../public/scripts/advice.js';

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const BASE = arg('url', 'http://127.0.0.1:8371');
const CHARS = Math.max(1, Number(arg('chars', '8')) || 8);

const conclusion = await (await fetch(`${BASE}/api/archive/conclusion`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    account: { owned: [], eidolons: {}, cones: {} },
    window: 6,
    frontierWeights: { 'aa|plight': 10, 'aa|': 1, 'as|': 1, 'moc|': 1, 'pf|': 1 },
  }),
  signal: AbortSignal.timeout(240000),
})).json();
const metaOf = (id) => (conclusion.frontierEnvs || []).find((m) => m.id === id) || null;

// 挑几个逐档榜里「envs 被截成 1 条」的角色（那正是 `enrichTierDetail` 会触发的条件）。
const tierUnits = Object.values(conclusion.frontierTiers || {}).flat();
const names = [...new Set(tierUnits
  .filter((u) => Number(u.envCount) > (u.envs || []).length)
  .map((u) => u.name))].slice(0, CHARS);
console.log(`载荷 payload=${conclusion.payload}｜逐档榜 ${tierUnits.length} 条`
  + `｜其中被截断（envCount > envs.length）的 ${tierUnits.filter((u) => Number(u.envCount) > (u.envs || []).length).length} 条`
  + `｜抽 ${names.length} 个角色去取面板数据\n`);

let rows = 0; let over = 0; let overBy = 0; const samples = [];
for (const name of names) {
  const res = await fetch(`${BASE}/api/archive/packs?${new URLSearchParams({ char: name })}`,
    { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(120000) });
  const data = await res.json().catch(() => null);
  if (!data || data.ok !== true) { console.log(`  ${name}: 面板取不到`); continue; }
  const hasSeasonMinCost = (data.packs || []).some((p) => (p.envs || [])
    .some((e) => e.seasonMinCost !== undefined && e.seasonMinCost !== null));
  for (const pack of data.packs || []) {
    for (const env of pack.envs || []) {
      rows += 1;
      const f = frontierFactorsOf(env, metaOf(env.id));
      if (Number(f.seasonFactor) > 1 + 1e-9) {
        over += 1;
        overBy = Math.max(overBy, f.seasonFactor);
        if (samples.length < 6) {
          samples.push(`${pack.name} E${pack.eidolon} / ${env.envLabel}: ×${f.seasonFactor.toFixed(3)}`
            + `（score ${Number(f.score).toFixed(2)} ÷ base ${Number(f.base).toFixed(2)}`
            + `，minCost ${f.minCost}/${f.cost}）`);
        }
      }
    }
  }
  console.log(`  ${name}: packs ${(data.packs || []).length}｜`
    + `${envFactsOf(data)}｜该响应里带 seasonMinCost：${hasSeasonMinCost ? '是' : '**否**'}`);
}
console.log(`\n面板数据重算结果：（整包 × 副本）${rows} 行里 **${over} 行 > 1**`
  + `（${rows ? (over / rows * 100).toFixed(0) : 0}%）｜最大 ×${overBy.toFixed(3)}`);
for (const s of samples) console.log(`  ✗ ${s}`);

function envFactsOf(data) {
  const envs = (data.packs || []).flatMap((p) => p.envs || []);
  const keys = new Set(envs.flatMap((e) => Object.keys(e)));
  return `env 字段 ${[...keys].sort().join(',')}`;
}
