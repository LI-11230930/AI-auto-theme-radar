"""Bounded offline faster-whisper bridge. Input and output are UTF-8 JSON only."""
import json
import math
import os
from pathlib import Path
import sys
import hashlib
import re

os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'


def main():
    data = json.loads(sys.stdin.read(65537))
    source_duration = data.get('sourceDuration')
    if isinstance(source_duration, bool) or not isinstance(source_duration, (int, float)) or not math.isfinite(source_duration) or not 0 < source_duration <= 600:
        return {'ok': False, 'code': 'ASR_INVALID_INPUT'}
    audio, model = Path(data.get('audioPath', '')), Path(data.get('modelDir', ''))
    if not audio.is_absolute() or not model.is_absolute() or audio.is_symlink() or model.is_symlink() or not audio.is_file() or not model.is_dir() or not 0 < audio.stat().st_size <= 32 * 1024 * 1024:
        return {'ok': False, 'code': 'ASR_INVALID_INPUT'}
    if not all((model / name).is_file() and not (model / name).is_symlink() for name in ('model.bin', 'config.json', 'tokenizer.json')):
        return {'ok': False, 'code': 'ASR_UNAVAILABLE'}
    provenance = model / 'SOURCE.json'
    if not provenance.is_file() or provenance.is_symlink() or provenance.stat().st_size > 16384:
        return {'ok': False, 'code': 'ASR_UNAVAILABLE'}
    manifest = json.loads(provenance.read_text(encoding='utf8'))
    if manifest.get('repository') != 'Systran/faster-whisper-base' or not re.fullmatch(r'[a-f0-9]{40}', manifest.get('revision', '')):
        return {'ok': False, 'code': 'ASR_UNAVAILABLE'}
    entries = {entry.get('path'): entry for entry in manifest.get('files', []) if isinstance(entry, dict)}
    for name in ('config.json', 'model.bin', 'tokenizer.json', 'vocabulary.txt'):
        expected, file = entries.get(name, {}), model / name
        if not file.is_file() or file.is_symlink() or not 0 < file.stat().st_size <= 200 * 1024 * 1024 or file.stat().st_size != expected.get('bytes'):
            return {'ok': False, 'code': 'ASR_UNAVAILABLE'}
        digest = hashlib.sha256()
        with file.open('rb') as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(block)
        if digest.hexdigest() != expected.get('sha256'):
            return {'ok': False, 'code': 'ASR_UNAVAILABLE'}
    # These libraries receive local paths only. No URLs or model identifiers resolve remotely.
    from faster_whisper import WhisperModel
    import av
    import numpy as np
    # Bound decoded samples while reading, before constructing a waveform. A small
    # compressed file can otherwise decode to hours despite a short metadata claim.
    chunks, samples = [], 0
    with av.open(str(audio), mode='r') as container:
        resampler = av.AudioResampler(format='s16', layout='mono', rate=16000)
        for frame in container.decode(audio=0):
            for decoded in resampler.resample(frame):
                values = decoded.to_ndarray().flatten()
                samples += len(values)
                if samples > 600 * 16000:
                    return {'ok': False, 'code': 'ASR_DURATION_MISMATCH'}
                chunks.append(values)
        for decoded in resampler.resample(None):
            values = decoded.to_ndarray().flatten()
            samples += len(values)
            if samples > 600 * 16000:
                return {'ok': False, 'code': 'ASR_DURATION_MISMATCH'}
            chunks.append(values)
    if not samples:
        return {'ok': False, 'code': 'ASR_EMPTY'}
    waveform = np.concatenate(chunks).astype(np.float32) / 32768.0
    actual_duration = len(waveform) / 16000
    if not 0 < actual_duration <= 600 or abs(actual_duration - source_duration) > 3:
        return {'ok': False, 'code': 'ASR_DURATION_MISMATCH'}
    engine = WhisperModel(str(model), device='cpu', compute_type='int8', cpu_threads=4, num_workers=1, local_files_only=True)
    iterator, _info = engine.transcribe(waveform, language='zh', beam_size=1, vad_filter=True, condition_on_previous_text=False,
                                      initial_prompt='以下是简体中文的语音转写。')
    segments, characters, end = [], 0, 0
    for row in iterator:
        text = row.text.strip()
        if not text:
            continue
        start, stop = float(row.start), float(row.end)
        if not math.isfinite(start) or not math.isfinite(stop) or start < end or stop <= start or stop > actual_duration:
            return {'ok': False, 'code': 'ASR_FAILED'}
        characters += len(text) + (1 if segments else 0)
        if len(segments) >= 1000 or characters > 40000:
            return {'ok': False, 'code': 'ASR_OUTPUT_LIMIT'}
        segments.append({'from': start, 'to': stop, 'content': text})
        end = stop
    if not segments:
        return {'ok': False, 'code': 'ASR_EMPTY'}
    return {'ok': True, 'text': '\n'.join(s['content'] for s in segments), 'segments': segments, 'duration': actual_duration,
            'model': 'faster-whisper-base', 'language': 'zh', 'range': {'from': 0, 'to': actual_duration}, 'coverage': 'complete'}


if __name__ == '__main__':
    try:
        result = main()
    except ImportError:
        result = {'ok': False, 'code': 'ASR_UNAVAILABLE'}
    except Exception:
        result = {'ok': False, 'code': 'ASR_FAILED'}
    sys.stdout.write(json.dumps(result, ensure_ascii=False))
