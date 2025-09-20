// index.js
import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';

dotenv.config();

const { OPENAI_API_KEY } = process.env;
if (!OPENAI_API_KEY) {
  console.error('Missing OpenAI API key. Please set OPENAI_API_KEY in the environment.');
  process.exit(1);
}

// ========================= Persona y parámetros =========================
const SYSTEM_MESSAGE = `
Eres "Luna", una asistente de voz profesional, cálida y resolutiva.
Objetivo: ayudar al usuario con rapidez y amabilidad, hablando en español de México.
Estilo: natural, humano, conversacional (no suenes “robótica”); frases breves, ritmo ágil y escucha activa.
No interrumpas al usuario; usa backchannels cortos (mm-hm, claro) solo si aportan fluidez.
Si el usuario pide información sensible (pagos, datos personales), confirma y explica brevemente el proceso con opciones seguras.
Si no entiendes, pide clarificación en 1 frase. Nunca inventes datos; si no lo sabes, dilo y propone alternativa.

Guía de objeciones (usa de forma flexible, no como guion rígido):
- “No me interesa / solo estoy mirando” → “¡Súper! ¿Qué te gustaría lograr idealmente? Si me dices 1 detalle, te doy 1 recomendación rápida.”
- “Está caro” → “Entiendo. ¿Qué rango te gustaría? Puedo ajustar la opción para mantener lo esencial y bajar costo.”
- “No tengo tiempo” → “Perfecto. Te dejo una propuesta en WhatsApp/Email para que la veas cuando puedas. ¿Cuál prefieres?”
- “Necesito pensarlo” → “Claro. ¿Hay 1 cosa que si te la aclaro hoy te ayudaría a decidir?”
- “Prefiero hablar con humano” → “Por supuesto. Te conecto con una persona. ¿Prefieres llamada o WhatsApp?”

Reglas:
- Siempre responde en español (es-MX), salvo que el usuario cambie de idioma.
- Menciona beneficios en lenguaje llano; evita tecnicismos.
- Respuestas entre 1 y 3 frases; si el tema es complejo, ofrece continuar por WhatsApp/Email con un resumen.
`;

const VOICE = 'alloy';           // voces de Realtime: alloy, aria, verse, etc.
const TEMPERATURE = 0.7;         // 0.2 = preciso, 1.0 = creativo
const PORT = process.env.PORT || 5050;
const MODEL = 'gpt-4o-realtime-preview-2024-12-17';

// Eventos útiles para log
const LOG_EVENT_TYPES = [
  'error',
  'response.content.done',
  'rate_limits.updated',
  'response.done',
  'input_audio_buffer.committed',
  'input_audio_buffer.speech_stopped',
  'input_audio_buffer.speech_started',
  'session.created',
  'session.updated',
];

// ========================= Servidor =========================
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

fastify.get('/', async (_req, reply) => {
  reply.send({ ok: true, message: 'Twilio Media Stream Server is running!' });
});

// Twilio llama a este webhook cuando entra una llamada
fastify.all('/incoming-call', async (request, reply) => {
  // IMPORTANTE: Twilio necesita 8 kHz mulaw (PCMU). Usamos <Stream> para enviar audio a /media-stream
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Google.es-ES-Standard-A">Un momento, conectando con el asistente de voz.</Say>
  <Pause length="1"/>
  <Say voice="Google.es-ES-Standard-A">Listo, puedes empezar a hablar.</Say>
  <Connect>
    <Stream url="wss://${request.headers.host}/media-stream" />
  </Connect>
</Response>`;

  reply.type('text/xml').send(twimlResponse);
});

// ========================= WebSocket media-stream =========================
fastify.register(async (app) => {
  app.get('/media-stream', { websocket: true }, (connection, req) => {
    console.log('Twilio client connected');

    let streamSid = null;
    let latestMediaTimestamp = 0;
    let lastAssistantItem = null;
    let markQueue = [];
    let responseStartTimestampTwilio = null;

    // Conéctate a OpenAI Realtime
    const openAiWs = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`,
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      }
    );

    // ---- Configura la sesión: ¡sin session.type! ----
    const sendSessionUpdate = () => {
      const sessionUpdate = {
        type: 'session.update',
        session: {
          model: MODEL,
          instructions: SYSTEM_MESSAGE,
          voice: VOICE,
          // temperatura (opcional) a nivel de sesión
          temperature: TEMPERATURE,
          // señalamos que queremos hablar y escuchar
          modalities: ['audio'],

          // detección de turnos del lado del servidor
          turn_detection: { type: 'server_vad' },

          // Twilio -> OpenAI: 8kHz mu-law
          input_audio_format: {
            type: 'input_audio_format',
            format: 'mulaw',
            sample_rate_hz: 8000,
          },

          // OpenAI -> Twilio: 8kHz mu-law
          output_audio_format: {
            type: 'output_audio_format',
            format: 'mulaw',
            sample_rate_hz: 8000,
          },
        },
      };

      console.log('Sending session.update to OpenAI');
      openAiWs.send(JSON.stringify(sessionUpdate));
    };

    // Si quieres que la IA hable primero, descomenta esto:
    // const haveAIStart = () => {
    //   openAiWs.send(JSON.stringify({
    //     type: 'conversation.item.create',
    //     item: {
    //       type: 'message',
    //       role: 'user',
    //       content: [{ type: 'input_text', text: 'Da la bienvenida breve y pregunta en qué puedo ayudar.' }]
    //     }
    //   }));
    //   openAiWs.send(JSON.stringify({ type: 'response.create' }));
    // };

    // Marcas para cortar audio en Twilio cuando el usuario habla
    const handleSpeechStartedEvent = () => {
      if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
        const elapsed = latestMediaTimestamp - responseStartTimestampTwilio;

        if (lastAssistantItem) {
          const truncateEvt = {
            type: 'conversation.item.truncate',
            item_id: lastAssistantItem,
            content_index: 0,
            audio_end_ms: Math.max(0, elapsed),
          };
          openAiWs.send(JSON.stringify(truncateEvt));
        }

        // Limpia el audio que Twilio esté reproduciendo
        connection.send(JSON.stringify({ event: 'clear', streamSid }));
        // Resetea estado
        markQueue = [];
        lastAssistantItem = null;
        responseStartTimestampTwilio = null;
      }
    };

    const sendMark = () => {
      if (!streamSid) return;
      const mark = { event: 'mark', streamSid, mark: { name: 'responsePart' } };
      connection.send(JSON.stringify(mark));
      markQueue.push('responsePart');
    };

    // ----------------- OpenAI WS Handlers -----------------
    openAiWs.on('open', () => {
      console.log('Connected to OpenAI Realtime API');
      // Configura sesión
      sendSessionUpdate();
      // haveAIStart(); // <-- opcional
    });

    openAiWs.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch (e) {
        console.error('Error parsing OpenAI message', e);
        return;
      }

      if (LOG_EVENT_TYPES.includes(msg.type)) {
        console.log('[OpenAI]', msg.type);
      }

      // audio out (base64 mulaw)
      if (msg.type === 'response.output_audio.delta' && msg.delta) {
        const audioDelta = {
          event: 'media',
          streamSid,
          media: { payload: msg.delta },
        };
        connection.send(JSON.stringify(audioDelta));

        // primera partícula de un nuevo output
        if (!responseStartTimestampTwilio) {
          responseStartTimestampTwilio = latestMediaTimestamp;
        }
        if (msg.item_id) lastAssistantItem = msg.item_id;

        sendMark();
      }

      // si OpenAI detecta que el usuario empezó a hablar, cortamos el audio del asistente
      if (msg.type === 'input_audio_buffer.speech_started') {
        handleSpeechStartedEvent();
      }

      // Log de errores de OpenAI
      if (msg.type === 'error') {
        console.error('[OpenAI error]', msg);
      }
    });

    openAiWs.on('close', () => {
      console.log('Disconnected from OpenAI');
    });

    openAiWs.on('error', (err) => {
      console.error('OpenAI WS error:', err);
    });

    // ----------------- Twilio WS Handlers -----------------
    connection.on('message', (raw) => {
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        return;
      }

      switch (data.event) {
        case 'start':
          streamSid = data.start.streamSid;
          latestMediaTimestamp = 0;
          responseStartTimestampTwilio = null;
          console.log('Twilio stream started:', streamSid);
          break;

        case 'media':
          // Twilio envía audio PCMU (mulaw) a 8 kHz en base64
          latestMediaTimestamp = data.media.timestamp;
          if (openAiWs.readyState === WebSocket.OPEN) {
            openAiWs.send(
              JSON.stringify({
                type: 'input_audio_buffer.append',
                audio: data.media.payload, // base64 mulaw
              })
            );
          }
          break;

        case 'mark':
          if (markQueue.length) markQueue.shift();
          break;

        case 'stop':
          // final de la llamada
          try {
            openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
          } catch {}
          break;

        default:
          // otros eventos de Twilio
          break;
      }
    });

    connection.on('close', () => {
      console.log('Twilio WS closed');
      try { openAiWs.close(); } catch {}
    });
  });
});

// ========================= Arranque =========================
fastify.listen({ port: PORT, host: '0.0.0.0' })
  .then(() => console.log(`🚀 Server running at http://0.0.0.0:${PORT}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
