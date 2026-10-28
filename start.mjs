#!/usr/bin/env node
// 一键启动：双击 ReproLab.cmd 走的就是这一条；也可以 `node start.mjs [端口]`。
//
// 行为：
//   端口没起 → 后台起静态服务器（日志写 serve.log），等它真的能连上，再打开浏览器；
//   端口已起 → 直接打开浏览器，不会起第二个（不会看到 EADDRINUSE）。
// 退出码：0 起好了/本来就在跑；1 起不来（看 serve.log）。
import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.REPROLAB_PORT || process.argv[2] || 5173);
const pageUrl = `http://127.0.0.1:${PORT}`;

/** 端口上有没有人监听（400ms 内连得上就算在跑） */
function probe(port) {
  return new Promise((res) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    const done = (v) => {
      try { sock.destroy(); } catch { /* 已经断了就算了 */ }
      res(v);
    };
    sock.setTimeout(400);
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.once('timeout', () => done(false));
  });
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '""', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch (err) {
    console.log(`浏览器没打开，手动访问：${url}（${err.message}）`);
  }
}

if (await probe(PORT)) {
  console.log(`ReproLab 已经在跑：${pageUrl}　直接开浏览器。`);
  openBrowser(pageUrl);
  process.exit(0);
}

// 日志跟着服务一起走，出问题有据可查；.gitignore 已忽略 *.log
const logPath = join(root, 'serve.log');
const log = openSync(logPath, 'a');
const child = spawn(process.execPath, [join(root, 'serve.mjs'), String(PORT)], {
  cwd: root,
  detached: true,
  stdio: ['ignore', log, log],
  windowsHide: true,
});
child.unref();

let up = false;
for (let i = 0; i < 40 && !up; i += 1) {
  await new Promise((r) => setTimeout(r, 120));
  up = await probe(PORT);
}

if (!up) {
  console.error(`启动失败：${PORT} 端口没起来，看看 ${logPath}`);
  process.exit(1);
}

console.log(`ReproLab 已启动：${pageUrl}　（日志：serve.log，关掉窗口不影响服务）`);
openBrowser(pageUrl);
