// index.js — versión completa lista para Twilio + OpenAI Realtime
import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';

dotenv.config();

// ===== Env =====
const {
  OPENAI_API_KEY,
  REALTIME_MODEL = 'gpt-4o-realtime-preview', // puedes cambiarlo por gpt-5-realtime si lo tienes disponible
  PORT: ENV_PORT
} = process.env;

if (!OPENAI_API_KEY) {
  console.error('Missing OpenAI API key. Please set OPENAI_API_KEY in environment.');
  process.exit(1);
}
const PORT = ENV_PORT || 5050;

// ===== Persona / Voz / Creatividad =====
const SYSTEM_MESSAGE = `
Eres "Luna", una asistente de voz profesional, cálida y resolutiva.
Objetivo: ayudar al usuario con rapidez y amabilidad, hablando en español de México.
Estilo: natural, humano, conversacional (no suenes “robótica”), frases breves, ritmo ágil, y escucha activa.
No interrumpas al usuario; usa backchannels cortos (mm-hm, claro) sólo cuando aporten fluidez.

Si el usuario pide información sensible (pagos, datos personales), confirma y explica el proceso con opciones seguras.
Si no entiendes, pide clarificación en 1 frase.
Nunca inventes datos: si no lo sabes, dilo y propone una alternativa.

### Guía de objeciones (usa de forma flexible, no como guion rígido)
- “No me interesa / sólo estoy mirando”
  → “¡Súper! ¿Qué te gustaría lograr idealmente? Si me das 1 detalle, te doy 1 recomendación rápida.”
- “Está caro”
  → “Entiendo. ¿Qué rango te funciona? Puedo ajustar para mantener lo esencial y bajar costo.”
- “No tengo tiempo”
  → “Ok. Dame 30 segundos y te dejo una propuesta por WhatsApp/Email. ¿Cuál te sirve?”
- “Necesito pensarlo”
  → “Claro. Para pensarlo mejor: ¿hay 1 cosa que si te la aclaro hoy te ayudaría a decidir?”
- “Prefiero hablar con humano”
  → “Por supuesto. Te conecto con una persona. ¿Prefieres llamada o WhatsApp?”

### Reglas de conversación
- Responde en español neutral (es-MX), salvo que el usuario cambie de idioma.
- Beneficios claros, sin tecnicismos.
- Respuestas de 1 a 3 frases; si el tema es complejo, ofrece mandar un resumen por WhatsApp/Email.
`;

const VOICE = 'alloy';       // otras opciones: 'aria', 'verse', etc.
const TEMPERATURE = 0.7;     // 0.2=preciso, 1.0=creativo

// ===== Logs que nos interesan =====
const LOG_EVENT_TYPES = [
  'error',
  'response.content.done',
  'rate_limits.updated',
  'response.done',
  'input_audio_buffer.committed',
  'input_audio_buffer.speech_stopped',
  'input_audio_buffer.speech_started',
  'session.created',
  'session.updated'
];

const SHOW_TIMING_MATH = false;

// ===== Fastify base =====
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Ping de salud
fastify.get('/', async (_req, reply) => {
  reply.send({ ok: true, service: 'Twilio Media Stream + OpenAI Realtime' });
});

// ===== Twilio: webhook de llamada entrante =====
fastify.all('/incoming-call', async (request, reply) => {
  // Nota: usa el mismo host que nos llama Twilio para abrir el WebSocket
  const streamUrl = `wss://${request.headers.host}/media-stream`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="es-MX" voice="Google.es-MX-Standard-A">Conectando con tu asistente de voz. Puedes hablar cuando escuches el tono.</Say>
  <Pause length="1"/>
  <Connect>
    <Stream url="${streamUrl}" />
  </Connect>
</Response>`;

  reply.type('text/xml').send(twiml);
});

// ===== Ruta WebSocket para el Media Stream de Twilio =====
fastify.register(async (fastify) => {
  fastify.get('/media-stream', { websocket: true }, (connection, req) => {
    console.log('Twilio WS conectado');

    // Estado por conexión
    let streamSid = null;
    let latestMediaTimestamp = 0;
    let lastAssistantItem = null;
    let markQueue = [];
    let responseStartTimestampTwilio = null;

    // === Conexión al Realtime de OpenAI ===
    const openAiWs = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}&temperature=${TEMPERATURE}`,
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        }
      }
    );

    // ---- Helpers ----
    const sendMark = () => {
      if (!streamSid) return;
      const markEvent = {
        event: 'mark',
        streamSid,
        mark: { name: 'responsePart' }
      };
      connection.send(JSON.stringify(markEvent));
      markQueue.push('responsePart');
    };

    // Cuando el usuario empieza a hablar, si la IA estaba hablando, truncamos
    const handleSpeechStartedEvent = () => {
      if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
        const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
        if (SHOW_TIMING_MATH) {
          console.log(`Truncation math: ${latestMediaTimestamp} - ${responseStartTimestampTwilio} = ${elapsedTime}ms`);
        }

        if (lastAssistantItem) {
          const truncateEvent = {
            type: 'conversation.item.truncate',
            item_id: lastAssistantItem,
            content_index: 0,
            audio_end_ms: Math.max(0, elapsedTime)
          };
          openAiWs.send(JSON.stringify(truncateEvent));
        }

        // Pedimos a Twilio limpiar búfer de reproducción actual
        connection.send(JSON.stringify({ event: 'clear', streamSid }));

        // Reset
        markQueue = [];
        lastAssistantItem = null;
        responseStartTimestampTwilio = null;
      }
    };

    // Cuando el usuario deja de hablar: COMMIT + RESPONSE
    const handleSpeechStoppedEvent = () => {
      // 1) Cerramos el buffer de audio
      openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      // 2) Pedimos explícitamente la respuesta
      openAiWs.send(JSON.stringify({ type: 'response.create' }));
    };

    // ---- Realtime: al conectar, configuramos sesión ----
    const initializeSession = () => {
      const sessionUpdate = {
        type: 'session.update',
        session: {
          type: 'realtime',
          model: REALTIME_MODEL,
          // Sólo audio
          output_modalities: ['audio'],
          // Config audio (PCMU para Twilio) + VAD en servidor
          audio: {
            input: {
              format: { type: 'audio/pcmu' },
              turn_detection: { type: 'server_vad', silence_duration_ms: 350, threshold: 0.5 }
            },
            output: {
              format: { type: 'audio/pcmu' },
              voice: VOICE
            }
          },
          instructions: SYSTEM_MESSAGE
        }
      };
      openAiWs.send(JSON.stringify(sessionUpdate));

      // Si quisieras que la IA hable primero, descomenta:
      // openAiWs.send(JSON.stringify({
      //   type: 'conversation.item.create',
      //   item: {
      //     type: 'message',
      //     role: 'user',
      //     content: [{ type: 'input_text', text: 'Saluda al usuario en 1 frase y pregúntale en qué le ayudas.' }]
      //   }
      // }));
      // openAiWs.send(JSON.stringify({ type: 'response.create' }));
    };

    // ---- Realtime: eventos ----
    openAiWs.on('open', () => {
      console.log('Conectado a OpenAI Realtime');
      setTimeout(initializeSession, 100);
    });

    openAiWs.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);

        if (LOG_EVENT_TYPES.includes(msg.type)) {
          console.log('[OpenAI]', msg.type);
        }

        // Audio de salida de la IA -> Twilio
        if (msg.type === 'response.output_audio.delta' && msg.delta) {
          // Primer delta: tomamos timestamp de inicio (para truncados posteriores)
          if (!responseStartTimestampTwilio) {
            responseStartTimestampTwilio = latestMediaTimestamp;
          }
          if (msg.item_id) lastAssistantItem = msg.item_id;

          const audioDelta = {
            event: 'media',
            streamSid,
            media: { payload: msg.delta }
          };
          connection.send(JSON.stringify(audioDelta));

          // Enviamos marca para saber fin de fragmento
          sendMark();
        }

        // Usuario empezó a hablar (interrupción)
        if (msg.type === 'input_audio_buffer.speech_started') {
          handleSpeechStartedEvent();
        }

        // Usuario terminó de hablar (silencio detectado)
        if (msg.type === 'input_audio_buffer.speech_stopped') {
          handleSpeechStoppedEvent();
        }

        // FIN de la respuesta de la IA: limpiamos estados mínimos
        if (msg.type === 'response.done') {
          markQueue = [];
          lastAssistantItem = null;
          responseStartTimestampTwilio = null;
        }

      } catch (e) {
        console.error('Error procesando mensaje OpenAI:', e, 'Raw:', raw?.toString?.());
      }
    });

    openAiWs.on('close', () => console.log('OpenAI WS cerrado'));
    openAiWs.on('error', (err) => console.error('OpenAI WS error:', err));

    // ---- Twilio -> nosotros ----
    connection.on('message', (message) => {
      try {
        const data = JSON.parse(message);

        switch (data.event) {
          case 'start':
            streamSid = data.start.streamSid;
            latestMediaTimestamp = 0;
            responseStartTimestampTwilio = null;
            console.log('Twilio stream start:', streamSid);
            break;

          case 'media':
            latestMediaTimestamp = data.media.timestamp;
            if (openAiWs.readyState === WebSocket.OPEN) {
              // Audio entrante -> búfer del modelo
              openAiWs.send(JSON.stringify({
                type: 'input_audio_buffer.append',
                audio: data.media.payload
              }));
            }
            break;

          case 'mark':
            if (markQueue.length > 0) markQueue.shift();
            break;

          default:
            // Otros eventos (e.g., stop)
            break;
        }
      } catch (e) {
        console.error('Error parseando mensaje Twilio:', e, 'Raw:', message?.toString?.());
      }
    });

    connection.on('close', () => {
      if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
      console.log('Twilio WS desconectado');
    });
  });
});

// ===== Lanzar servidor =====
fastify.listen({ port: PORT, host: '0.0.0.0' })
  .then(() => console.log(`🚀 Server running at http://0.0.0.0:${PORT}`))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
