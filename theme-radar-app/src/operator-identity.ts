import {resolve} from 'node:path';
import {hash} from './model.ts';

/** Match a worker to the caller's local ledger without exposing its path. */
export function operatorIdentity(config:any){const file=resolve(config.dataDir,'radar.sqlite');return hash('theme-radar-ledger-v1:'+(process.platform==='win32'?file.toLowerCase():file));}
