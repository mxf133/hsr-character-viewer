// 把当前版本号打到 stdout，专供 start.bat 抓取（`for /f` + `set "VERSION=%%V"`）。
//
// 为什么需要这个独立小脚本，而不是在 start.bat 里写死一个版本号：
//   版本号在本仓库只有一个权威来源 —— src/version.js 的 PROGRAM_VERSION（HANDOFF §4.4
//   「一个数字只在一个地方定义」）。启动横幅里再抄一份，改版本时必然漏改其中之一，
//   于是窗口标题会长期挂着一个旧号而没人发现。所以启动脚本**运行时**去问代码要，
//   而不是把号刻在自己身上。
//
// 为什么输出必须「只有一行、只有版本号本身」：
//   start.bat 用 `for /f "delims=" %%V in ('node bin\version.mjs 2^>nul')` 逐行抓取，
//   并把**第一行**当成版本号。任何前缀（`version: `）、任何提示（`(c) ...`）、任何多出来的
//   空行，都会被原样拼进窗口标题与横幅。所以这里刻意不提供 --verbose / --json 之类的开关：
//   想加输出就会有人加，加了批处理那边就静默变脏。
//   ⚠️ 报错也走 stderr（进程自然抛出的栈就是 stderr），配合 start.bat 里的 `2>nul`，
//   失败时不会污染那一行，批处理会退回 `unknown`。
//
// 为什么不用 `node -e "import('./src/version.js').then(...)"`：
//   批处理里嵌套双引号要写成 `\"` / `""`，还要处理 `!`、`%`、`^` 的转义 —— 实测这种一行式
//   极难一次写对，而且**写错了没有任何测试能拦住它**（它是一个字符串，不是文件）。
//   独立脚本可以被 `node --check` 与 launcher-test.mjs 直接检查，出问题在 CI 就报红。
//
// 用法：node bin/version.mjs   ->  4.6.75
import { PROGRAM_VERSION } from '../src/version.js';

process.stdout.write(`${PROGRAM_VERSION}\n`);
