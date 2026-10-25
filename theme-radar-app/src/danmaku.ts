import {RadarError} from './model.ts';
// DmSegMobileReply.elems=1; DanmakuElem.progress=2 (ms), content=7.
// Only retain time/text. Sender hashes, IDs and other identity fields are discarded.
function invalid():never{throw new RadarError('INVALID_DANMAKU','弹幕分包格式无效；未记为空弹幕');}
function fields(bytes:Uint8Array){
 let offset=0,count=0;const rows:{field:number;wire:number;value:bigint|Uint8Array}[]=[];
 const number=()=>{let n=0n;for(let i=0;i<10;i++){if(offset>=bytes.length)invalid();const v=bytes[offset++];if(i===9&&v>1)invalid();n|=BigInt(v&127)<<BigInt(i*7);if(!(v&128))return n;}return invalid();};
 while(offset<bytes.length){if(++count>100000)invalid();const tag=number(),field=Number(tag>>3n),wire=Number(tag&7n);if(field<1||field>536870911)invalid();let value:bigint|Uint8Array;
  if(wire===0)value=number();else if(wire===2){const len=number();if(len>BigInt(bytes.length-offset))invalid();value=bytes.subarray(offset,offset+Number(len));offset+=Number(len);}else if(wire===1||wire===5){const len=wire===1?8:4;if(offset+len>bytes.length)invalid();value=bytes.subarray(offset,offset+len);offset+=len;}else invalid();
  rows.push({field,wire,value});
 }return rows;
}
export function parseDanmaku(bytes:Uint8Array,limit=100){
 if(!Number.isSafeInteger(limit)||limit<1||limit>100||bytes.length>600000)throw new RadarError('INVALID_BUDGET','弹幕每次最多100条、600KB');
 const rows:{timeSeconds:number;text:string}[]=[];let reported=0;
 for(const field of fields(bytes)){
  if(field.field!==1)continue;if(field.wire!==2)invalid();if(++reported>20000)invalid();
  let progress=0n,text='';const seen=new Set<number>();
  for(const entry of fields(field.value as Uint8Array)){
   if(entry.field!==2&&entry.field!==7)continue;if(seen.has(entry.field))invalid();seen.add(entry.field);
   if(entry.field===2){if(entry.wire!==0||typeof entry.value!=='bigint'||entry.value>86400000n)invalid();progress=entry.value;}
   else {if(entry.wire!==2)invalid();try{text=new TextDecoder('utf-8',{fatal:true}).decode(entry.value as Uint8Array);}catch{invalid();}if(text.length>10000)invalid();}
  }
  if(!text.trim())continue;if(rows.length<limit)rows.push({timeSeconds:Number(progress)/1000,text});
 }
 return {rows,reportedElements:reported,truncated:reported>rows.length};
}
