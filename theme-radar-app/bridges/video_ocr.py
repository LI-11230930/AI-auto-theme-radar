"""Sample a bounded local video. Windows OCR reads pixels, never instructions."""
import json,math,os,struct,subprocess,sys,time,zlib
from pathlib import Path

def png(path,array):
    height,width,_=array.shape
    def chunk(kind,data):
        return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
    raw=b''.join(b'\0'+row.tobytes() for row in array)
    path.write_bytes(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',width,height,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(raw))+chunk(b'IEND',b''))

def main():
    data=json.loads(sys.stdin.read(16385));file=Path(data['videoPath']);duration=data['sourceDuration'];tool=Path(data['ocrTool'])
    if os.name!='nt' or not file.is_absolute() or not file.is_file() or file.is_symlink() or not 0<file.stat().st_size<=32*1024*1024 or not isinstance(duration,(int,float)) or not math.isfinite(duration) or not 0<duration<=600 or not tool.is_file():
        return {'ok':False,'code':'OCR_INPUT_INVALID'}
    import av
    interval=max(2,math.ceil(duration/100));times=[float(t) for t in range(1,math.ceil(duration),interval)] or [0.0]
    seen=set();segments=[];start=time.monotonic();attempted=0
    with av.open(str(file)) as container:
        video=next((s for s in container.streams if s.type=='video'),None)
        if video is None:return {'ok':False,'code':'OCR_NO_VIDEO'}
        for moment in times:
            if time.monotonic()-start>210:break
            container.seek(int(moment*1000000),backward=True)
            for frame in container.decode(video=0):
                if frame.time is None or frame.time<moment:continue
                if frame.width>8000 or frame.height>8000 or frame.width*frame.height>16000000:return {'ok':False,'code':'OCR_FRAME_LIMIT'}
                frame=frame.reformat(width=min(frame.width,1280),height=max(1,round(frame.height*min(frame.width,1280)/frame.width)),format='rgb24')
                array=frame.to_ndarray();image=file.parent/'frame.png';png(image,array);attempted+=1
                result=subprocess.run(['C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe','-NoProfile','-NonInteractive','-File',str(tool),'-ImagePath',str(image)],capture_output=True,timeout=20,creationflags=0x08000000)
                value=json.loads(result.stdout.decode('utf-8-sig'))
                if not value.get('ok'):return {'ok':False,'code':value.get('code','OCR_FAILED')}
                lines=[]
                for line in value.get('lines',[]):
                    text=line.get('text','').strip();identity=''.join(text.split()).casefold()
                    if len(identity)>=4 and identity not in seen:seen.add(identity);lines.append(text)
                if lines:segments.append({'time':moment,'text':'\n'.join(lines)})
                break
    return {'ok':True,'engine':'Windows.Media.Ocr','segments':segments,'attempted':attempted,'expected':len(times),'interval':interval,'sourceDuration':duration,'text':'\n'.join(s['text'] for s in segments)}

if __name__=='__main__':
    try:result=main()
    except Exception:result={'ok':False,'code':'OCR_FAILED'}
    sys.stdout.write(json.dumps(result,ensure_ascii=False))
