"""Optional ASR preparation. Default is offline status; --download fetches one public model."""
from __future__ import annotations
import argparse, importlib.util, json, os, subprocess, sys, hashlib
from pathlib import Path
from urllib.parse import urlparse

ROOT=Path(__file__).resolve().parents[1]
MODEL=ROOT/'.data/models/faster-whisper-base'
FILES=('config.json','model.bin','tokenizer.json','vocabulary.txt')

def local_proxy(value):
    parsed=urlparse(value)
    try:port=parsed.port
    except ValueError:raise argparse.ArgumentTypeError('invalid proxy port')
    if parsed.scheme!='http' or parsed.hostname not in ('127.0.0.1','localhost','::1') or not port or parsed.username or parsed.password or parsed.path not in ('','/') or parsed.query or parsed.fragment:
        raise argparse.ArgumentTypeError('use a credential-free loopback HTTP CONNECT proxy')
    return value

def download():
    from huggingface_hub import HfApi,snapshot_download
    # Use the Hub API directly: older faster-whisper passes a removed local_dir_use_symlinks argument.
    info=HfApi(token=False).model_info('Systran/faster-whisper-base',files_metadata=True,timeout=15,token=False)
    if not info.sha or len(info.sha)!=40:raise RuntimeError('invalid official revision')
    expected={entry.rfilename:entry for entry in info.siblings if entry.rfilename in FILES}
    if len(expected)!=len(FILES):raise RuntimeError('required model files missing from official metadata')
    MODEL.mkdir(parents=True,exist_ok=True)
    snapshot_download(repo_id='Systran/faster-whisper-base',revision=info.sha,local_dir=str(MODEL),token=False,allow_patterns=list(FILES))
    verified=[]
    for name in FILES:
        file=MODEL/name;data=file.read_bytes();entry=expected[name]
        if len(data)>200*1024*1024:raise RuntimeError('model file exceeds preparation budget')
        sha=hashlib.sha256(data).hexdigest();lfs=entry.lfs
        if lfs:
            expected_sha=lfs.get('sha256') if isinstance(lfs,dict) else lfs.sha256
            if sha!=expected_sha:raise RuntimeError('official LFS SHA256 mismatch')
        elif hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()!=entry.blob_id:
            raise RuntimeError('official Git blob mismatch')
        verified.append({'path':name,'bytes':len(data),'sha256':sha,'officialMetadataMatched':True})
    (MODEL/'SOURCE.json').write_text(json.dumps({'repository':'Systran/faster-whisper-base','revision':info.sha,'files':verified,'modelLoadVerified':False},indent=2),encoding='utf8')

def main():
    parser=argparse.ArgumentParser(description='Optional local ASR model preparation; no audio or credentials are uploaded')
    parser.add_argument('--download',action='store_true',help='download public Systran/faster-whisper-base into this project only')
    parser.add_argument('--proxy',type=local_proxy,help='optional loopback HTTP CONNECT proxy, applied only to the download worker')
    parser.add_argument('--worker',action='store_true',help=argparse.SUPPRESS)
    args=parser.parse_args()
    if args.worker:
        os.environ['HF_HUB_DISABLE_IMPLICIT_TOKEN']='1'
        download()
        return
    dependency=importlib.util.find_spec('faster_whisper') is not None
    result={'dependencyFound':dependency,'modelDirectory':str(MODEL),'missingFiles':[name for name in FILES if not (MODEL/name).is_file()],
            'downloadRequested':args.download,'downloadSource':'https://huggingface.co/Systran/faster-whisper-base',
            'modelLoadVerified':False,'audioTranscriptionVerified':False,'applicationAsrEnabled':False}
    if args.download:
        if not dependency:result['error']='FASTER_WHISPER_NOT_INSTALLED'
        else:
            env=dict(os.environ,HF_HOME=str(ROOT/'.data/models/huggingface'),HF_HUB_DISABLE_IMPLICIT_TOKEN='1',HF_HUB_DISABLE_TELEMETRY='1',HF_HUB_DISABLE_XET='1',HF_HUB_ETAG_TIMEOUT='10',HF_HUB_DOWNLOAD_TIMEOUT='20')
            if args.proxy:env.update(HTTP_PROXY=args.proxy,HTTPS_PROXY=args.proxy,http_proxy=args.proxy,https_proxy=args.proxy)
            try:
                process=subprocess.run([sys.executable,str(Path(__file__).resolve()),'--worker'],env=env,capture_output=True,timeout=240)
                if process.returncode:
                    log=ROOT/'.runtime/asr-model-download.stderr.log';log.parent.mkdir(exist_ok=True);log.write_bytes(process.stderr)
                    result.update(error='MODEL_DOWNLOAD_FAILED',diagnosticLog=str(log))
            except subprocess.TimeoutExpired:result.update(error='MODEL_DOWNLOAD_TIMEOUT',timeoutSeconds=240)
        result['missingFiles']=[name for name in FILES if not (MODEL/name).is_file()]
    result['modelFilesPresent']=not result['missingFiles']
    print(json.dumps(result,ensure_ascii=True,indent=2))
    if args.download and (result.get('error') or result['missingFiles']):sys.exit(2)

if __name__=='__main__':main()
