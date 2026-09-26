import { rmSync } from 'node:fs';

// tsc 不会清理陈旧产物：删掉一个源文件后，dist 里对应的 .js 仍在，
// 而 loader 扫描的正是 dist/。所以构建前必须先清干净。
rmSync('dist', { recursive: true, force: true });
