import {RadarError} from './model.ts';
/** A single user-exported pixel sample; never equivalent to a subtitle track. */
export function validateOcrFrame(input:any,clock=Date.now()){
 const fields='bvid,duration,height,imagePng,observedAt,page,region,schema,time,width';
 const fail=()=>{throw new RadarError('INVALID_OCR_FRAME','画面测试文件格式或范围无效；未归档或调用模型');};
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!==fields||input.schema!=='theme-radar-visible-frame-v1'||!/^BV[0-9a-zA-Z]{10}$/.test(input.bvid)||input.page!==1||input.region!=='video-bottom-45pct'||!Number.isFinite(input.duration)||input.duration<=0||input.duration>43200||!Number.isFinite(input.time)||input.time<0||input.time>input.duration||!Number.isSafeInteger(input.width)||input.width<80||input.width>1600||!Number.isSafeInteger(input.height)||input.height<30||input.height>900)fail();
 const date=typeof input.observedAt==='string'?Date.parse(input.observedAt):NaN;if(!Number.isFinite(date)||date>clock+60000||!/(Z|[+-]\d\d:\d\d)$/.test(input.observedAt))fail();
 if(typeof input.imagePng!=='string'||input.imagePng.length>2800000||!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(input.imagePng))fail();
 const data=input.imagePng.slice('data:image/png;base64,'.length),png=Buffer.from(data,'base64');
 if(png.toString('base64')!==data||png.length<33||png.length>2097152||png.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||png.readUInt32BE(8)!==13||png.subarray(12,16).toString()!=='IHDR'||png.readUInt32BE(16)!==input.width||png.readUInt32BE(20)!==input.height)fail();
 const {imagePng:discard,...metadata}=input;return {metadata,png,scope:'single_visible_frame_ocr_probe',archiveWritten:false,modelRead:false,emailSent:false};
}
