require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { BedrockRuntimeClient, InvokeModelCommand } = require("@aws-sdk/client-bedrock-runtime");
const { TranscribeStreamingClient, StartStreamTranscriptionCommand } = require('@aws-sdk/client-transcribe-streaming');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "http://localhost:5173",
    methods: ["GET", "POST"]
  }
});

console.log("AWS Config:", {
  region: process.env.AWS_REGION || 'us-east-1',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID ? '...' + process.env.AWS_ACCESS_KEY_ID.slice(-4) : 'MISSING'
});

const transcribeClient = new TranscribeStreamingClient({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

const bedrockClient = new BedrockRuntimeClient({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

const { PollyClient, SynthesizeSpeechCommand } = require("@aws-sdk/client-polly");

const pollyClient = new PollyClient({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('start-stream', async ({ sampleRate }) => {
    console.log('Starting stream for', socket.id, 'Sample Rate:', sampleRate);

    const audioQueue = [];
    let queueResolver = null;
    let isStreaming = true;
    let transcriptBuffer = [];

    // Conversation history for context
    let conversationHistory = [];

    const speakResponse = async (text) => {
      try {
        const command = new SynthesizeSpeechCommand({
          Engine: "neural",
          Text: text,
          VoiceId: "Matthew", // US English Male Neural (often perceived as very natural)
          OutputFormat: "mp3"
        });

        const response = await pollyClient.send(command);
        const audioStream = response.AudioStream;
        const audioChunks = [];

        for await (const chunk of audioStream) {
          audioChunks.push(chunk);
        }

        const audioBuffer = Buffer.concat(audioChunks);
        console.log("Sending Audio Response (" + audioBuffer.length + " bytes)");
        socket.emit('audio-response', audioBuffer);

      } catch (error) {
        console.error("Polly Error:", error);
      }
    };



    // Conversation history for context
    // let conversationHistory = []; // This line is already present above, no need to duplicate

    // Conversation history for context
    // Defined outside processTranscriptWithBrain so it persists across stream chunks

    const processTranscriptWithBrain = async (text) => {
      try {
        console.log("Sending to Brain (Amazon Nova Lite):", text);

        const systemPrompt = `You are "AI Voice Moderator", the charismatic AI moderator for the AWS Community Day Ahmedabad 2026.
        
        Event Details:
        - Event: AWS Community Day Ahmedabad 2026
        - Date: February 28, 2026 (8:00 AM - 6:00 PM IST)
        - Venue: Gujarat University Convention and Exhibition Centre, Memnagar, Ahmedabad.
        - Tickets: Regular tickets are ₹1,099. Patron tickets up to ₹25,000. Early bird tickets are sold out.
        - Highlights: Tech talks, Builder Zone, Networking, Swags, Lunch & Hi-tea.
        
        Your Goal:
        - Facilitate the discussion enthusiastically.
        - Promote the event and ticket sales.
        - KEEP RESPONSES VERY SHORT (maximum 2-3 sentences).
        - NEVER output HTML, Markdown, or Code. Speak only in plain text.
        - Do NOT start responses with "Hello" unless greeted.
        - You are helpful, witty, and professional.`;

        // Add user message to history
        conversationHistory.push({ role: "user", content: [{ text }] });

        // Limit history to last 10 turns to avoid token limits
        if (conversationHistory.length > 20) {
          conversationHistory = conversationHistory.slice(conversationHistory.length - 20);
        }

        // Amazon Nova Lite Payload Structure
        const input = {
          modelId: "amazon.nova-lite-v1:0",
          contentType: "application/json",
          accept: "application/json",
          body: JSON.stringify({
            inferenceConfig: {
              max_new_tokens: 150, // Reduced from 300 to force brevity
              temperature: 0.6, // Lower temperature for more stability
              topP: 0.9
            },
            system: [
              { text: systemPrompt }
            ],
            messages: conversationHistory
          })
        };

        const command = new InvokeModelCommand(input);
        const response = await bedrockClient.send(command);

        // Parse response for Nova
        const responseBody = JSON.parse(new TextDecoder().decode(response.body));
        const aiText = responseBody.output.message.content[0].text;

        console.log("Brain Response:", aiText);

        // Add AI response to history
        conversationHistory.push({ role: "assistant", content: [{ text: aiText }] });

        socket.emit('ai-response', { text: aiText });

        // Speak the response
        speakResponse(aiText);

      } catch (error) {
        console.error("Bedrock Error:", error);
      }
    };

    const audioListener = (data) => {
      // Data arrives as ArrayBuffer from client (Int16)
      // We need to ensure it's a Buffer for AWS
      const buffer = Buffer.from(data);

      if (queueResolver) {
        queueResolver(buffer);
        queueResolver = null;
      } else {
        audioQueue.push(buffer);
      }
    };

    const stopListener = () => {
      console.log('Stop stream requested');
      isStreaming = false;
      if (queueResolver) {
        queueResolver(null); // Unblock generator
        queueResolver = null;
      }
    };

    // Attach listeners ONCE
    socket.on('audio-data', audioListener);
    socket.once('stop-stream', stopListener);
    socket.once('disconnect', stopListener);

    try {
      const command = new StartStreamTranscriptionCommand({
        LanguageCode: 'en-US',
        MediaEncoding: 'pcm',
        MediaSampleRateHertz: sampleRate || 16000,
        ShowSpeakerLabel: true, // Enable Diarization
        AudioStream: (async function* () {
          while (isStreaming) {
            let chunk;

            if (audioQueue.length > 0) {
              chunk = audioQueue.shift();
            } else {
              // Wait for data or timeout to send silence
              chunk = await new Promise((resolve) => {
                queueResolver = resolve;
              });
            }

            if (chunk === null) break; // Stop signal received
            if (chunk) {
              yield { AudioEvent: { AudioChunk: chunk } };
            }
          }
        })()
      });

      const response = await transcribeClient.send(command);

      for await (const event of response.TranscriptResultStream) {
        if (event.TranscriptEvent) {
          const results = event.TranscriptEvent.Transcript.Results;
          if (results.length > 0 && results[0].Alternatives.length > 0) {
            const transcript = results[0].Alternatives[0].Transcript;
            const isPartial = results[0].IsPartial;

            // Emit real-time transcript to UI
            socket.emit('transcription-data', { transcript, isPartial });

            if (!isPartial) {
              console.log('Final Transcript:', transcript);
              transcriptBuffer.push(transcript);

              // Simple logic: If we have a full sentence, send to brain
              // In production, we'd use a more sophisticated VAD or silence timeout
              if (transcriptBuffer.length > 0) {
                const fullText = transcriptBuffer.join(' ');
                processTranscriptWithBrain(fullText);
                transcriptBuffer = []; // Clear buffer
              }
            }
          }
        }
      }
    } catch (error) {
      console.error('Transcription error:', error);
      // Don't emit error to client if it's just a stream abort from legitimate stopping
      if (isStreaming) {
        socket.emit('error', 'Transcription failed: ' + error.message);
      }
    } finally {
      // Cleanup
      isStreaming = false;
      socket.off('audio-data', audioListener);
      socket.off('stop-stream', stopListener);
      socket.off('disconnect', stopListener);
      console.log('Stream ended for', socket.id);
    }
  });

  socket.on('stop-stream', () => {
    // Allow manual stop-stream event to just log, logic is in the connection handler
    console.log('Manual stop-stream event from', socket.id);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
