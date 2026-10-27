import {APP_ROOT,configFilePath} from '../src/config.ts';
import {configureLocal} from '../src/setup.ts';
import {RadarError,publicError} from '../src/model.ts';
async function bootstrap(){
const mode=process.argv[2]||'serve';
if(!['serve','configure'].includes(mode))throw new RadarError('INVALID_INPUT','Usage: node tools/bootstrap.ts [serve|configure]');
const [major,minor]=process.versions.node.split('.').map(Number);
if(major!==24||minor<14)throw new RadarError('INVALID_RUNTIME','Node 24.14+ (24.x) required');
console.log(JSON.stringify({configuration:configureLocal(APP_ROOT,configFilePath())}));
await import('./generate-integrations.ts');
if(mode==='serve'){
 const {startOperator}=await import('../src/operator.ts');
 await startOperator();
}
}
bootstrap().catch(error=>{console.error(JSON.stringify({ok:false,...publicError(error)}));process.exitCode=1;});
