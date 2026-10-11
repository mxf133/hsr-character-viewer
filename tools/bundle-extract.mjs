// Extract the real HSR record bundle's endpoint list and how it builds the
// index/avatar requests, so our client can mirror the official page exactly.
const BASE = 'https://webstatic.mihoyo.com/app/community-game-records/rpg/';
const page = await (await fetch(`${BASE}index.html?game_id=6&user_id=76090888`)).text();
const bundle = (page.match(/src="((?:bundle|index)_[a-f0-9]+\.js)"/) || [])[1];
const js = await (await fetch(BASE + bundle)).text();
console.log('bundle:', bundle, js.length, 'chars\n');

const endpoints = [...new Set([...js.matchAll(/["'`](\/hkrpg\/api\/[A-Za-z0-9_/]*)["'`]/g)].map((m) => m[1]))].sort();
console.log('===== 官方页面用到的全部端点 =====');
endpoints.forEach((e) => console.log('  ' + e));

console.log('\n===== 10035 的处理逻辑 =====');
let idx = js.indexOf('10035');
console.log(js.slice(Math.max(0, idx - 500), idx + 400).replace(/\s+/g, ' '));

console.log('\n===== role_id / server 参数构造 =====');
for (const term of ['role_id', 'game_role_id', "server:", 'server=']) {
  const i = js.indexOf(term);
  if (i >= 0) {
    console.log(`\n--- "${term}" @${i} ---`);
    console.log(js.slice(Math.max(0, i - 260), i + 260).replace(/\s+/g, ' '));
  }
}
