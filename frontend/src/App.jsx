import { useState, useRef, useEffect } from 'react';
import io from 'socket.io-client';
import './App.css';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:8080';
const socket = io(BACKEND_URL);

function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [transcription, setTranscription] = useState('');
  const [partialTranscript, setPartialTranscript] = useState('');
  const audioContextRef = useRef(null);
  const streamRef = useRef(null);
  const processorRef = useRef(null);
  const sourceRef = useRef(null);
  const audioQueueRef = useRef([]);
  const isPlayingRef = useRef(false);

  useEffect(() => {
    socket.on('connect', () => {
      console.log('Connected to backend');
    });

    socket.on('transcription-data', (data) => {
      if (data.isPartial) {
        setPartialTranscript(data.transcript);
      } else {
        setTranscription((prev) => prev + ' ' + data.transcript);
        setPartialTranscript('');
      }
    });

    // Audio Queue System


    const playNextAudio = () => {
      if (isPlayingRef.current || audioQueueRef.current.length === 0) {
        return;
      }

      isPlayingRef.current = true;
      const audioBuffer = audioQueueRef.current.shift();
      const blob = new Blob([audioBuffer], { type: 'audio/mp3' });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);

      audio.onended = () => {
        isPlayingRef.current = false;
        playNextAudio(); // Process next item
      };

      audio.play().catch(e => {
        console.error("Error playing audio:", e);
        isPlayingRef.current = false;
        playNextAudio(); // Try next if current fails
      });
    };

    socket.on('audio-response', (audioBuffer) => {
      console.log("Received Audio Response, adding to queue");
      audioQueueRef.current.push(audioBuffer);
      playNextAudio();
    });

    socket.on('error', (err) => {
      console.error('Socket error:', err);
      stopRecording();
    });

    return () => {
      socket.off('connect');
      socket.off('transcription-data');
      socket.off('audio-response'); // Add this line
      socket.off('error');
    };
  }, []);

  // Session Timer
  const sessionTimeoutRef = useRef(null);
  const SESSION_LIMIT = 2 * 60 * 1000; // 2 minutes
  const COOLDOWN_PERIOD = 12 * 60 * 60 * 1000; // 12 hours

  const startRecording = async () => {
    // Check for cooldown
    const lastSessionEnd = localStorage.getItem('lastSessionEnd');
    if (lastSessionEnd) {
      const timePassed = Date.now() - parseInt(lastSessionEnd, 10);
      if (timePassed < COOLDOWN_PERIOD) {
        const hoursRemaining = ((COOLDOWN_PERIOD - timePassed) / (1000 * 60 * 60)).toFixed(1);
        alert(`Limit reached! You can start a new session in ${hoursRemaining} hours.`);
        return;
      }
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      setIsRecording(true);

      // Start 2-minute timer
      sessionTimeoutRef.current = setTimeout(() => {
        stopRecording();
        localStorage.setItem('lastSessionEnd', Date.now().toString());
        alert("This is a testing version and session is kept 2 min.");
      }, SESSION_LIMIT);

      // Use default sample rate (usually 44.1k or 48k)
      audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();

      const audioContext = audioContextRef.current;
      sourceRef.current = audioContext.createMediaStreamSource(stream);

      // bufferSize: 4096, inputChannels: 1, outputChannels: 1
      processorRef.current = audioContext.createScriptProcessor(4096, 1, 1);

      processorRef.current.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        // Downsample to 16kHz
        const downsampledData = downsampleBuffer(inputData, audioContext.sampleRate, 16000);

        // DEBUG: Calculate Volume (RMS)
        let sum = 0;
        for (let i = 0; i < downsampledData.length; i++) {
          sum += downsampledData[i] * downsampledData[i];
        }
        const rms = Math.sqrt(sum / downsampledData.length);
        if (rms > 0.05) { // Only log if speaking
          console.log('Mic Volume (RMS):', rms.toFixed(4));
        }

        // Convert float32 to int16
        const pcmData = convertFloat32ToInt16(downsampledData);
        socket.emit('audio-data', pcmData);
      };

      sourceRef.current.connect(processorRef.current);
      processorRef.current.connect(audioContext.destination); // Necessary for script processor to run

      // Always send "16000" to backend because we are converting it here
      socket.emit('start-stream', { sampleRate: 16000 });
    } catch (err) {
      console.error('Error accessing microphone:', err);
    }
  };

  const stopRecording = () => {
    // Clear timer if stopped manually
    if (sessionTimeoutRef.current) {
      clearTimeout(sessionTimeoutRef.current);
      sessionTimeoutRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    socket.emit('stop-stream');
    setIsRecording(false);
  };

  const downsampleBuffer = (buffer, sampleRate, outSampleRate) => {
    if (outSampleRate === sampleRate) {
      return buffer;
    }
    if (outSampleRate > sampleRate) {
      throw "downsampling rate show be smaller than original sample rate";
    }
    var sampleRateRatio = sampleRate / outSampleRate;
    var newLength = Math.round(buffer.length / sampleRateRatio);
    var result = new Float32Array(newLength);
    var offsetResult = 0;
    var offsetBuffer = 0;
    while (offsetResult < result.length) {
      var nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
      // Use average value of skipped samples
      var accum = 0, count = 0;
      for (var i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
        accum += buffer[i];
        count++;
      }
      result[offsetResult] = accum / count;
      offsetResult++;
      offsetBuffer = nextOffsetBuffer;
    }
    return result;
  };

  const convertFloat32ToInt16 = (buffer) => {
    let l = buffer.length;
    const buf = new Int16Array(l);
    while (l--) {
      buf[l] = Math.min(1, buffer[l]) * 0x7FFF;
    }
    return buf.buffer;
  };

  return (
    <>
      <h1>AI Voice Moderator</h1>

      <div className="guidelines-box">
        <h3>Session Instructions</h3>
        <ul>
          <li><strong>Microphone:</strong> Please ensure you have granted microphone permissions.</li>
          <li><strong>Speaking:</strong> Speak clearly and wait for the AI to finish responding.</li>
          <li><strong>Issues?</strong> If it doesn't work, try reloading the page or checking your browser settings.</li>
        </ul>
      </div>

      <div className="card">
        {!isRecording ? (
          <button onClick={startRecording} className="start-btn">
            Start Session
          </button>
        ) : (
          <button onClick={stopRecording} className="stop-btn">
            Stop Session
          </button>
        )}
        <div className="transcription-box">
          <p className="final-text">{transcription}</p>
          <p className="partial-text">{partialTranscript}</p>
        </div>
      </div>
    </>
  );
}

export default App;
