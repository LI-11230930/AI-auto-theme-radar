import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const cwd=fileURLToPath(new URL('../theme-radar-app/',import.meta.url));
const result=spawnSync(process.execPath,['--test','tests/*.test.ts'],{cwd,stdio:'inherit'});
if(result.error){console.error(result.error.message);process.exitCode=1;}
else process.exitCode=result.status??1;
