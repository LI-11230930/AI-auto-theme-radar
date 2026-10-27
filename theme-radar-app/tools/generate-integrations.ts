import {APP_ROOT} from '../src/config.ts';
import {writeIntegrations} from '../src/integration-config.ts';
console.log(JSON.stringify(writeIntegrations(APP_ROOT)));
