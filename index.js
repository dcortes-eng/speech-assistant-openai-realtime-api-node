// index.js — Twilio <-> OpenAI Realtime (formato correcto G.711 u-law 8kHz)

import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';

dotenv.config();

// === Variables de entorno (Render) ===
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL   = process.env.OPENAI_MODEL || 'gpt-4o-realtime-preview-2024-12-17';
const OPENAI_VOICE   = process.env.OPENAI_VOICE || 'alloy';
const TEMPERATURE    = Number(process.env.OPENAI_TEMPERATURE || 0.7);
const SYSTEM_PROMPT  = process.env.SYSTEM_PROMPT || 'Eres una asistente de voz útil.';
const PORT           = process.env.PORT || 5050;

if (!OPENAI_API_KEY) {
  console.error('Falta OPENAI_API_KEY en las variables de entorno.');
  process.exit(1);
}

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// ————————————————————————————————————————————————————————————
// Healthcheck
fastify.get('/', async (_req, reply) => {
  reply.send({ ok: true, service: 'Twilio <-> OpenAI Realtime', model: OPENAI_MODEL });
});

// — TwiML webhook (Twilio -> Render)
fastify.all('/incoming-call', async (request, reply) => {
  // Nota: usa una voz neutra solo para el mensaje de enlace.
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

// — Canal WS para audio Twilio
fastify.register(async (app) => {
  app.get('/media-stream', { websocket: true }, (twilioConn, req) => {
    console.log('Twilio conectado');

    let streamSid = null;
    let openaiReady = false;    // hasta que abra el WS
    let lastAssistantItem = null;

    const openaiUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_MODEL)}&temperature=${TEMPERATURE}`;

    const openaiWs = new WebSocket(openaiUrl, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1', // importante en algunas cuentas
      },
    });

    // ——— Al abrir, configuramos la sesión con el formato correcto:
    openaiWs.on('open', () => {
      console.log('OpenAI WS abierto');

      const sessionUpdate = {
        type: 'session.update',
        session: {
          // Realtime session
          instructions: SYSTEM_PROMPT,

          // Turn detection: el servidor decide cuándo “cerrar” el turno del usuario
          turn_detection: { type: 'server_vad' },

          // Formatos *correctos* para Twilio (G.711 μ-law 8kHz mono)
          input_audio_format:  { type: 'g711_ulaw', sample_rate_hz: 8000, channels: 1 },
          output_audio_format: { type: 'g711_ulaw', sample_rate_hz: 8000, channels: 1 },

          // Voz de salida
          voice: OPENAI_VOICE
        },
      };

      openaiWs.send(JSON.stringify(sessionUpdate));
      openaiReady = true;

      // (Opcional) haz que la IA salude primero:
      // openaiWs.send(JSON.stringify({
      //   type: 'response.create',
      //   response: { instructions: 'Hola, soy tu asistente. ¿En qué te ayudo?' }
      // }));
    });

    // ——— Mensajes desde OpenAI -> los reenviamos a Twilio
    openaiWs.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      // Para depurar:
      if (msg.type && msg.type !== 'response.output_audio.delta') {
        console.log('[OpenAI]', msg.type);
      }

      // Audio de salida (μ-law base64)
      if (msg.type === 'response.output_audio.delta' && msg.delta && streamSid) {
        twilioConn.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: msg.delta }   // base64 μ-law
        }));

        // para cortar reproducción en el cliente Twilio entre trozos:
        twilioConn.send(JSON.stringify({
          event: 'mark',
          streamSid,
          mark: { name: 'chunk' }
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

    // ——— Mensajes desde Twilio -> los reenviamos a OpenAI
    twilioConn.on('message', (raw) => {
      let data;
      try { data = JSON.parse(raw); } catch { return; }

      switch (data.event) {
        case 'start':
          streamSid = data.start?.streamSid;
          console.log('Twilio stream start', streamSid);
          break;

        case 'media':
          // Asegurarse de NO enviar nada hasta que OpenAI esté listo.
          if (!openaiReady) return;

          // Twilio envía audio μ-law 8 kHz en base64 (20 ms por frame).
          openaiWs.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: data.media.payload   // base64 μ-law
          }));
          break;

        case 'mark':
          // No hacemos nada especial; solo drena la cola de marks.
          break;

        case 'stop':
          console.log('Twilio stream stop');
          try { openaiWs.close(); } catch {}
          break;

        default:
          // Otros eventos informativos
          break;
      }
    });

    // Cierre del lado Twilio
    twilioConn.on('close', () => {
      console.log('Twilio WS cerrado');
      try { openaiWs.close(); } catch {}
    });
  });
});

fastify.listen({ port: PORT, host: '0.0.0.0' })
  .then(() => console.log(`🚀 Servicio escuchando en 0.0.0.0:${PORT}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
