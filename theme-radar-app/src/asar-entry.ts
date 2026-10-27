import {openSync,closeSync,readSync,fstatSync,statSync} from 'node:fs';
import {resolve} from 'node:path';

/** Bounded, read-only ASAR directory lookup for Electron-hosted CLI paths.
 * Format: https://github.com/electron/asar#format
 * Does not extract files, load executable code, or attest archive integrity.
 */
export function asarEntryExists(path:string){
  const match=/^(.*?\.asar)[\\/](.+)$/i.exec(path);if(!match)return false;
  const parts=match[2].split(/[\\/]/);if(parts.some(p=>!p||p==='.'||p==='..'))return false;
  let fd:number|undefined;
  try{
    fd=openSync(match[1],'r');const size=fstatSync(fd).size,prefix=Buffer.alloc(8);
    if(readSync(fd,prefix,0,8,0)!==8||prefix.readUInt32LE(0)!==4)return false;
    const bytes=prefix.readUInt32LE(4);if(bytes<8||bytes>16*1024*1024||bytes>size-8)return false;
    const header=Buffer.alloc(bytes);if(readSync(fd,header,0,bytes,8)!==bytes||header.readUInt32LE(0)!==bytes-4)return false;
    const length=header.readUInt32LE(4);if(length>bytes-8)return false;
    let entry=JSON.parse(header.subarray(8,8+length).toString('utf8'));
    for(const part of parts){if(!entry?.files||!Object.hasOwn(entry.files,part))return false;entry=entry.files[part];}
    if(!entry||entry.files||entry.link||!Number.isSafeInteger(entry.size)||entry.size<1)return false;
    if(entry.unpacked===true){const info=statSync(resolve(match[1]+'.unpacked',...parts));return info.isFile()&&info.size===entry.size;}
    if(typeof entry.offset!=='string'||!/^\d+$/.test(entry.offset))return false;
    const offset=Number(entry.offset);return Number.isSafeInteger(offset)&&offset+entry.size<=size-8-bytes;
  }catch{return false;}finally{if(fd!==undefined)closeSync(fd);}
}
