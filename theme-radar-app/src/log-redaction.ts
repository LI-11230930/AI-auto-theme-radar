/** Best-effort credential filtering for diagnostics, not a safe content export. */
const secretKey=(key:string)=>/(?:passwords?|passwd|pwd|tokens?|secrets?|authorization|cookies?|sessdata|bilijct|apikey|privatekey|credentials?)$/.test(key.replace(/[-_\s]/g,'').toLowerCase());

export function redactLogText(text:string){
 return text
  .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,'[redacted]')
  .replace(/\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g,'[redacted]')
  .replace(/\b((?:Bearer|Basic)\s+)[^\s,;"'<>{}\[\]]+/gi,'$1[redacted]')
  .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s]+@/gi,'$1[redacted]@')
  .replace(/\b((?:Set-)?Cookie\s*:\s*)[^\r\n]*/gi,'$1[redacted]')
  .replace(/(\b(?:SESSDATA|bili_jct|password|passwd|pwd|access_token|refresh_token|id_token|xsec_token|authorization|api[_-]?key|client[_-]?secret|token)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&"'}\]]+)/gi,'$1[redacted]');
}

/** JSON serialization retains ordinary IDs/counts, filters nested secret fields. */
export function serializeLogData(data:Record<string,unknown>){
 return JSON.stringify(data,(key,value)=>secretKey(key)?'[redacted]':typeof value==='string'?redactLogText(value):value);
}
