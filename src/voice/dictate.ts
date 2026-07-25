import { invoke } from '@tauri-apps/api/tauri';
import { getSetting } from '../api/powerFeatures';

export type VoiceEngine = 'whisper' | 'browser' | 'auto';

interface BrowserSpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: ((ev: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((ev: { error: string }) => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionCtor = new () => BrowserSpeechRecognition;

function getSpeechRecognition(): SpeechRecognitionCtor | null {
  const w = window as Window & {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export async function resolveVoiceEngine(preferred?: VoiceEngine | null): Promise<'whisper' | 'browser'> {
  const setting = (preferred || (await getSetting('cw.voice_engine').catch(() => null)) || 'auto') as VoiceEngine;
  if (setting === 'browser') return 'browser';
  if (setting === 'whisper') return 'whisper';
  try {
    const providers = await invoke<string[]>('get_api_key_providers');
    if (providers.includes('openai')) return 'whisper';
  } catch {
    /* ignore */
  }
  return 'browser';
}

/** Record microphone audio until stop() is called; returns WebM/OGG blob. */
export async function recordMicrophone(): Promise<{
  stop: () => Promise<Blob>;
  stream: MediaStream;
}> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
    },
  });
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : MediaRecorder.isTypeSupported('audio/webm')
      ? 'audio/webm'
      : '';
  const chunks: BlobPart[] = [];
  const recorder = mime
    ? new MediaRecorder(stream, { mimeType: mime })
    : new MediaRecorder(stream);
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  recorder.start(250);

  const stop = () => new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      if (blob.size < 800) {
        reject(new Error('Recording too short or silent. Try again.'));
        return;
      }
      resolve(blob);
    };
    recorder.onerror = () => {
      stream.getTracks().forEach(t => t.stop());
      reject(new Error('Microphone recording failed.'));
    };
    try {
      recorder.stop();
    } catch (err) {
      stream.getTracks().forEach(t => t.stop());
      reject(err);
    }
  });

  return { stop, stream };
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function transcribeWithWhisper(blob: Blob, language = 'en'): Promise<string> {
  const maxBytes = 24 * 1024 * 1024;
  if (blob.size > maxBytes) {
    throw new Error('Recording too long for Whisper (max ~24MB). Record a shorter clip.');
  }
  const base64 = await blobToBase64(blob);
  const mime = blob.type || 'audio/webm';
  const text = await invoke<string>('cw_whisper_transcribe', {
    audioBase64: base64,
    mime,
    language,
  });
  return (text || '').trim();
}

export function browserSpeechAvailable(): boolean {
  return !!getSpeechRecognition();
}

/** Continuous Web Speech recognition; call stop() to finish. */
export function startBrowserDictation(opts?: {
  lang?: string;
  onInterim?: (text: string) => void;
}): {
  stop: () => Promise<string>;
} {
  const Ctor = getSpeechRecognition();
  if (!Ctor) {
    throw new Error('Browser speech recognition is not available in this WebView.');
  }
  const rec = new Ctor();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = opts?.lang || navigator.language || 'en-US';

  let finalText = '';
  let interim = '';
  let settled = false;

  rec.onresult = (event) => {
    interim = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const piece = event.results[i][0]?.transcript || '';
      if (event.results[i].isFinal) finalText = `${finalText} ${piece}`.trim();
      else interim += piece;
    }
    opts?.onInterim?.([finalText, interim].filter(Boolean).join(' ').trim());
  };

  const stop = () => new Promise<string>((resolve, reject) => {
    if (settled) {
      resolve(finalText.trim());
      return;
    }
    settled = true;
    rec.onerror = () => {
      /* resolve what we have */
    };
    rec.onend = () => {
      const out = [finalText, interim].filter(Boolean).join(' ').trim();
      if (!out) reject(new Error('No speech detected. Check the microphone and try again.'));
      else resolve(out);
    };
    try {
      rec.stop();
    } catch {
      const out = [finalText, interim].filter(Boolean).join(' ').trim();
      if (!out) reject(new Error('No speech detected.'));
      else resolve(out);
    }
  });

  rec.onerror = (e) => {
    if (e.error === 'aborted' || e.error === 'no-speech') return;
    console.warn('SpeechRecognition error:', e.error);
  };

  rec.start();
  return { stop };
}

export function cleanupTranscript(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .replace(/\b(um|uh|erm)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
