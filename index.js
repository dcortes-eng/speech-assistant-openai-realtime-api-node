// index.js — Twilio <-> OpenAI Realtime (G.711 μ-law 8kHz)

import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';

dotenv.config();

/** ── Variables de entorno (Render) */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL   = process.env.OPENAI_MODEL   || 'gpt-4o-realtime-preview-2024-12-17';
const OPENAI_VOICE   = process.env.OPENAI_VOICE   || 'alloy';
const TEMPERATURE    = Number(process.env.OPENAI_TEMPERATURE || 0.7);
const SYSTEM_PROMPT  = process.env.SYSTEM_PROMPT  || 'Eres una asistente de voz útil.';
const PORT           = process.env.PORT || 5050;

if (!OPENAI_API_KEY) {
  console.error('Falta OPENAI_API_KEY en las variables de entorno.');
  process.exit(1);
}

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

/** Healthcheck */
fastify.get('/', async (_req, reply) => {
  reply.send({ ok: true, service: 'Twilio <-> OpenAI Realtime', model: OPENAI_MODEL });
});

/** TwiML (Twilio -> Render) */
fastify.all('/incoming-call', async (request, reply) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
  <Response>
    <Say voice="Google.es-ES-Standard-A">Conectando con el asistente de voz. Puedes hablar después del tono.</Say>
    <Pause length="1"/>
    <Connect>
      <Stream url="wss://${request.headers.host}/media-stream"/>
    </Connect>
  </Response>`;
  reply.type('text/xml').send(twiml);
});

/** WebSocket para Twilio Media Streams */
fastify.register(async (app) => {
  app.get('/media-stream', { websocket: true }, (twilioConn, _req) => {
    console.log('Twilio conectado');

    let streamSid = null;
    let openaiReady = false; // se pone true al enviar session.update

    const openaiUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_MODEL)}`;

    const openaiWs = new WebSocket(openaiUrl, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });

    /** Al abrir el WS con OpenAI, configuramos la sesión */
    openaiWs.on('open', () => {
      console.log('OpenAI WS abierto');

      const sessionUpdate = {
        type: 'session.update',
        session: {
          instructions: SYSTEM_PROMPT,
          // VAD del lado del servidor (cierra el turno automáticamente)
          turn_detection: {
            type: 'server_vad',
            prefix_padding_ms: 150,
            silence_duration_ms: 400
          },
          // Formatos compatibles con Twilio (μ-law 8kHz mono)
          input_audio_format:  { type: 'mulaw', sample_rate_hz: 8000, channels: 1 },
          output_audio_format: { type: 'mulaw', sample_rate_hz: 8000, channels: 1 },
          voice: OPENAI_VOICE
        }
      };

      // Enviamos la configuración: desde ya aceptamos audio
      openaiWs.send(JSON.stringify(sessionUpdate));
      openaiReady = true;
    });

    /** Mensajes de OpenAI -> hacia Twilio */
    openaiWs.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.type === 'error') {
        console.error('[OpenAI ERROR]', JSON.stringify(msg, null, 2));
        return;
      }

      // Opcional: log de eventos (oculta los deltas de audio para no saturar)
      if (msg.type && msg.type !== 'response.output_audio.delta') {
        console.log('[OpenAI]', msg.type);
      }

      // Cuando el VAD detecta que el usuario dejó de hablar, pedimos respuesta
      if (msg.type === 'input_audio_buffer.speech_stopped') {
        openaiWs.send(JSON.stringify({
          type: 'response.create',
          response: { modalities: ['audio'], temperature: TEMPERATURE }
        }));
      }

      // Audio de salida μ-law (base64) hacia Twilio
      if (msg.type === 'response.output_audio.delta' && msg.delta && streamSid) {
        twilioConn.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: msg.delta }
        }));
      }
    });

    openaiWs.on('error', (e) => {
      console.error('OpenAI WS error:', e?.message || e);
    });

    openaiWs.on('close', () => {
      console.log('OpenAI WS cerrado');
      try { twilioConn.close(); } catch {}
    });

    /** Mensajes de Twilio -> hacia OpenAI */
    twilioConn.on('message', (raw) => {
      let data;
      try { data = JSON.parse(raw); } catch { return; }

      switch (data.event) {
        case 'start': {
          streamSid = data.start?.streamSid;
          console.log('Twilio stream start', streamSid);
          break;
        }
        case 'media': {
          // Frames μ-law 8kHz en base64 (≈20ms). No envíes si aún no configuraste sesión.
          if (!openaiReady) return;

          openaiWs.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: data.media.payload
          }));

          // Con server_vad NO enviamos commit manual; el servidor lo hace al detectar silencio.
          break;
        }
        case 'mark': {
          // opcional: manejar marks si los usas
          break;
        }
        case 'stop': {
          console.log('Twilio stream stop');
          try { openaiWs.close(); } catch {}
          break;
        }
        default: {
          // otros eventos informativos
          break;
        }
      }
    });

    /** Cierre del WS de Twilio */
    twilioConn.on('close', () => {
      console.log('Twilio WS cerrado');
      try { openaiWs.close(); } catch {}
    });
  });
});

/** Arranque HTTP (Render requiere 0.0.0.0 y PORT) */
fastify.listen({ port: PORT, host: '0.0.0.0' })
  .then(() => console.log(`🚀 Servicio escuchando en 0.0.0.0:${PORT}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
