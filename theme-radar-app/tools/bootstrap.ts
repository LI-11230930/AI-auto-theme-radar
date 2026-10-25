import {APP_ROOT} from '../src/config.ts';
import {configureLocal} from '../src/setup.ts';
const mode=process.argv[2]||'serve';
if(!['serve','configure'].includes(mode))throw Error('Usage: node tools/bootstrap.ts [serve|configure]');
const [major,minor]=process.versions.node.split('.').map(Number);
if(major!==24||minor<14)throw Error('Node 24.14+ (24.x) required');
console.log(JSON.stringify({configuration:configureLocal(APP_ROOT)}));
await import('./generate-integrations.ts');
if(mode==='serve'){
 const {startOperator}=await import('../src/operator.ts');
 await startOperator();
}
