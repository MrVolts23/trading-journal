import { useCallback, useEffect, useRef, useState } from 'react';

// Push-to-talk on top of the browser's built-in speech recognition (Chrome / Electron ship
// window.webkitSpeechRecognition). Hold the mic to record; every final phrase is handed to
// onFinal so the caller can append it to the textarea. When the browser has no recognizer,
// `supported` is false and the caller hides the mic. Nothing is sent anywhere but the browser API.
function getRecognizer() {
  if (typeof window === 'undefined') return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export default function useSpeech({ onFinal, lang = 'en-US' } = {}) {
  const Recognizer = getRecognizer();
  const supported = !!Recognizer;
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState(null);
  const recRef = useRef(null);
  const onFinalRef = useRef(onFinal);
  useEffect(() => { onFinalRef.current = onFinal; }, [onFinal]);

  const stop = useCallback(() => {
    const rec = recRef.current;
    if (!rec) return;
    try { rec.stop(); } catch { /* already stopped */ }
  }, []);

  const start = useCallback(() => {
    if (!Recognizer || recRef.current) return;
    let rec;
    try { rec = new Recognizer(); } catch { setError('speech recognition is not available'); return; }
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onresult = (ev) => {
      let partial = '';
      for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
        const r = ev.results[i];
        const text = (r[0] && r[0].transcript) || '';
        if (r.isFinal) { if (text.trim() && onFinalRef.current) onFinalRef.current(text.trim()); }
        else partial += text;
      }
      setInterim(partial.trim());
    };
    rec.onerror = (ev) => {
      // "no-speech" and "aborted" are normal when the button is released quickly.
      if (ev && ev.error && ev.error !== 'no-speech' && ev.error !== 'aborted') setError(ev.error === 'not-allowed' ? 'microphone access was refused' : String(ev.error));
    };
    rec.onend = () => { recRef.current = null; setListening(false); setInterim(''); };
    recRef.current = rec;
    setError(null);
    try { rec.start(); setListening(true); } catch (e) { recRef.current = null; setError(e?.message || 'could not start listening'); }
  }, [Recognizer, lang]);

  useEffect(() => () => { const rec = recRef.current; if (rec) { try { rec.abort(); } catch { /* ignore */ } } }, []);

  return { supported, listening, interim, error, start, stop };
}
