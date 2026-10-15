import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const sourceOrder = [
  'state-machine.js', 'logger.js', 'storage.js', 'clock.js', 'page-adapter.js', 'target-day-frame-loader.js',
  'submit-observer.js', 'diagnostics.js', 'scheduler.js', 'core.js', 'daily-controller.js', 'ui.js', 'userscript.js'
];
const metadata = `// ==UserScript==
// @name         HEBUT Chaoxing Seat Helper
// @namespace    hebut-chaoxing-seat-helper
// @version      ${version}
// @description  河北工业大学超星图书馆座位预约助手
// @match        https://office.chaoxing.com/front/third/apps/seat/select*
// @match        https://office.chaoxing.com/front/third/apps/seat/index*
// @match        https://office.chaoxing.com/front/third/apps/seat/code*
// @match        https://office.chaoxing.com/front/apps/seatengine/index*
// @match        https://office.chaoxing.com/front/apps/seatengine/select*
// @match        https://office.chaoxing.com/front/apps/seatengine/code*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==`;

const parts = await Promise.all(sourceOrder.map((name) => readFile(join(root, 'src', name), 'utf8')));
const body = parts.join('\n\n')
  .replace(/^import\s+[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '')
  .replace(/^export\s+(?=(class|function|const|let|var))/gm, '');
await mkdir(join(root, 'dist'), { recursive: true });
const output = join(root, 'dist', 'hebut-chaoxing-seat-helper.user.js');
await writeFile(output, `${metadata}\n\n(() => {\n'use strict';\n${body}\n})();\n`, 'utf8');
console.log(`Built ${output}`);
