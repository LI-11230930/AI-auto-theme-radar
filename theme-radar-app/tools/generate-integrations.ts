import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {APP_ROOT} from '../src/config.ts';
const folder=resolve(APP_ROOT,'integrations');mkdirSync(folder,{recursive:true});
const server={command:process.execPath,args:[resolve(APP_ROOT,'src/mcp.ts')],env:{THEME_RADAR_CONFIG:resolve(APP_ROOT,'config.local.json')}};
for(const host of ['DSH','WorkBuddy','TRAE','common'])writeFileSync(resolve(folder,host+'.mcp.json'),JSON.stringify({mcpServers:{'theme-radar':server}},null,2)+'\n');
writeFileSync(resolve(folder,'Codex.config.toml'),'# 合并片段；不要覆盖已有配置。\n[mcp_servers.theme-radar]\ncommand = '+JSON.stringify(server.command)+'\nargs = '+JSON.stringify(server.args)+'\n\n[mcp_servers.theme-radar.env]\nTHEME_RADAR_CONFIG = '+JSON.stringify(server.env.THEME_RADAR_CONFIG)+'\n');
writeFileSync(resolve(folder,'DSH.cordis.yml'),'- insert:\n    - id: theme-radar-mcp\n      name: "@deepseek-ai/dsh-mcp-client"\n      config:\n        serverName: theme-radar\n        transport: stdio\n        command: '+JSON.stringify(server.command)+'\n        args: '+JSON.stringify(server.args)+'\n        env:\n          THEME_RADAR_CONFIG: '+JSON.stringify(server.env.THEME_RADAR_CONFIG)+'\n        failOnStartupError: true\n');
console.log(JSON.stringify({folder,installed:false,note:'仅生成本机路径配置片段；宿主UI导入和真实MCP调用待人工验证。'}));
