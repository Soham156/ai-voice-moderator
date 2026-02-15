import { useState, useRef, useEffect } from 'react';
import io from 'socket.io-client';
import './App.css';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'https://ai-voice-moderator-backend.onrender.com';
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

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      setIsRecording(true);

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
