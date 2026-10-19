import { runPlan } from '../src/server/gacha-plan-run.js';
const res = await runPlan({ envKey: 'aa|plight', account: { owned: [] }, maxRows: 12 });
for (const r of res.rows) {
  console.log(r.key.split('~').sort().join(' ~ '), '| score', r.score);
}
