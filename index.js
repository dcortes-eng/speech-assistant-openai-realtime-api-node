// index.js
import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';

dotenv.config();

const { OPENAI_API_KEY, PORT: RENDER_PORT } = process.env;
if (!OPENAI_API_KEY) {
  console.error('❌ Falta OPENAI_API_KEY en variables de entorno.');
  process.exit(1);
}

// =========================
// Config de assistant (persona/voz)
// =========================
const SYSTEM_MESSAGE = `
Eres "Luna", una asistente de voz profesional, cálida y resolutiva.
Objetivo: ayudar al usuario con rapidez y amabilidad, hablando en español de México.
Estilo: natural, humano, conversacional; frases breves y ritmo ágil. Escucha activa.
No interrumpas al usuario; usa “mm-hm”, “claro” solo cuando aporte fluidez.

Si el usuario pide info sensible (pagos/datos), confirma y explica opciones seguras.
Si no entiendes, pide clarificación en 1 frase.
Nunca inventes: si no lo sabes, dilo y ofrece alternativa.

Guía de objeciones (flexible):
- “No me interesa / solo veo” → “¡Súper! ¿Qué te gustaría lograr idealmente? Si me dices 1 detalle te doy 1 recomendación rápida.”
- “Está caro” → “Entiendo. ¿Qué rango te gustaría? Ajusto para mantener lo esencial y bajar costo.”
- “No tengo tiempo” → “Ok. Dame 30s y te dejo una propuesta por WhatsApp/Email. ¿Cuál te funciona?”
- “Necesito pensarlo” → “Claro. ¿Hay 1 cosa que si te la aclaro hoy te ayudaría a decidir?”
- “Prefiero humano” → “Por supuesto. Te conecto con una persona. ¿Llamada o WhatsApp?”

Reglas:
- Responde en español (es-MX), salvo que el usuario cambie.
- Beneficios en lenguaje llano.
- 1–3 frases por respuesta; si es complejo, ofrece WhatsApp/Email con resumen.
`;

const VOICE = 'alloy';       // voces disponibles: alloy, aria, verse, etc.
const TEMPERATURE = 0.7;
const PORT = RENDER_PORT || 5050;

// Eventos que queremos ver en logs (útil para depurar)
const LOG_EVENT_TYPES = [
  'error',
  'response.content.done',
  'response.done',
  'response.output_audio.delta',
  'input_audio_buffer.speech_started',
  'input_audio_buffer.speech_stopped',
  'input_audio_buffer.committed',
  'session.created',
  'session.updated'
];

const SHOW_TIMING_MATH = false;

// =========================
// Fastify
// =========================
const fastify = Fastify({ logger: false });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Healthcheck
fastify.get('/', async (_req, reply) => {
  reply.send({ ok: true, service: 'Twilio Media Stream ↔ OpenAI Realtime' });
});

// =========================
// Twilio webhook (TwiML)
// =========================
fastify.all('/incoming-call', async (request, reply) => {
  // Avisa al usuario y abre el media stream hacia /media-stream
  const host = request.headers.host;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="es-MX">Estamos conectándote con el asistente de voz. Cuando escuches el tono, puedes hablar.</Say>
  <Pause length="1"/>
  <Say language="es-MX">Listo, te escucho.</Say>
  <Connect>
    <Stream url="wss://${host}/media-stream" />
  </Connect>
</Response>`;

  reply.type('text/xml').send(twiml);
});

// =========================
// WebSocket Twilio <-> OpenAI Realtime
// =========================
fastify.register(async (f) => {
  f.get('/media-stream', { websocket: true }, (connection /*, req*/) => {
    console.log('🔌 Twilio conectado al /media-stream');

    let streamSid = null;
    let latestMediaTimestamp = 0;
    let lastAssistantItem = null;
    let markQueue = [];
    let responseStartTimestampTwilio = null;

    // Conexión a OpenAI Realtime WebSocket
    const MODEL = 'gpt-4o-realtime-preview-2024-12-17';
    const openAiWs = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}&temperature=${TEMPERATURE}`,
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta': 'realtime=v1', // necesario para Realtime
        },
      }
    );

    // ----- Inicializar sesión en OpenAI -----
    const initializeSession = () => {
      const sessionUpdate = {
        type: 'session.update',
        session: {
          type: 'realtime',
          model: MODEL,
          // Solo audio (entrada/salida)
          output_modalities: ['audio'],
          instructions: SYSTEM_MESSAGE,
          // Formatos de audio compatibles con Twilio (G.711 mu-law)
          audio: {
            input: {
              // Twilio envía G.711 µ-law 8k (base64)
              format: { type: 'audio/pcmu' },
              // Deja que el servidor detecte turnos automáticamente
              turn_detection: { type: 'server_vad' },
            },
            output: {
              // Queremos audio de vuelta en PCMU para reproducir por Twilio
              format: { type: 'audio/pcmu' },
              voice: VOICE,
            },
          },
        },
      };

      console.log('➡️  Enviando session.update:', JSON.stringify(sessionUpdate));
      openAiWs.send(JSON.stringify(sessionUpdate));

      // Si quieres que la IA hable primero, descomenta:
      // sendInitialGreeting();
    };

    const sendInitialGreeting = () => {
      const item = {
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text:
                'Saluda de forma breve y cálida en español (MX) e invita a decir su objetivo en una frase.',
            },
          ],
        },
      };
      openAiWs.send(JSON.stringify(item));
      openAiWs.send(JSON.stringify({ type: 'response.create' }));
    };

    // Interrupción si el usuario habla (barge-in)
    const handleSpeechStartedEvent = () => {
      if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
        const elapsed = latestMediaTimestamp - responseStartTimestampTwilio;
        if (SHOW_TIMING_MATH) {
          console.log(
            `⏱️ Truncation math: ${latestMediaTimestamp} - ${responseStartTimestampTwilio} = ${elapsed}ms`
          );
        }

        if (lastAssistantItem) {
          const truncateEvent = {
            type: 'conversation.item.truncate',
            item_id: lastAssistantItem,
            content_index: 0,
            audio_end_ms: elapsed,
          };
          console.log('✂️  Enviando truncate:', JSON.stringify(truncateEvent));
          openAiWs.send(JSON.stringify(truncateEvent));
        }

        // Limpia el buffer de reproducción en Twilio
        connection.send(
          JSON.stringify({ event: 'clear', streamSid: streamSid })
        );

        // Reset estado
        markQueue = [];
        lastAssistantItem = null;
        responseStartTimestampTwilio = null;
      }
    };

    // Marca para que Twilio sepa cuándo terminó/parte de la respuesta
    const sendMark = () => {
      if (!streamSid) return;
      const markEvent = {
        event: 'mark',
        streamSid,
        mark: { name: 'responsePart' },
      };
      connection.send(JSON.stringify(markEvent));
      markQueue.push('responsePart');
    };

    // ===== OPENAI: eventos =====
    openAiWs.on('open', () => {
      console.log('✅ Conectado a OpenAI Realtime');
      // Pequeño delay para evitar race al primer mensaje
      setTimeout(initializeSession, 100);
    });

    openAiWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data);

        if (LOG_EVENT_TYPES.includes(msg.type)) {
          console.log(`[OpenAI] ${msg.type}`);
        }

        // Audio de salida de la IA
        if (msg.type === 'response.output_audio.delta' && msg.delta) {
          if (!streamSid) return;

          // Media chunk para Twilio
          const payload = {
            event: 'media',
            streamSid,
            media: { payload: msg.delta },
          };
          connection.send(JSON.stringify(payload));

          // Marca tiempo “start” para poder cortar si el usuario habla
          if (!responseStartTimestampTwilio) {
            responseStartTimestampTwilio = latestMediaTimestamp;
          }

          if (msg.item_id) lastAssistantItem = msg.item_id;

          // Enviamos una marca para que Twilio sepa que hay audio en curso
          sendMark();
        }

        // Si OpenAI detecta que el usuario empezó a hablar: interrumpimos
        if (msg.type === 'input_audio_buffer.speech_started') {
          handleSpeechStartedEvent();
        }

        // Log de errores emitidos por el servidor OpenAI
        if (msg.type === 'error') {
          console.error('🟥 [OpenAI error]', JSON.stringify(msg, null, 2));
        }
      } catch (err) {
        console.error('❌ Error procesando msg OpenAI:', err?.message || err);
        console.error('Raw:', data?.toString?.());
      }
    });

    openAiWs.on('close', () => {
      console.log('🔌 OpenAI WS cerrado');
    });

    openAiWs.on('error', (error) => {
      console.error('🛑 Error en OpenAI WS:', error?.message || error);
      if (error?.stack) console.error(error.stack);
    });

    // ===== TWILIO: eventos =====
    connection.on('message', (message) => {
      try {
        const data = JSON.parse(message);

        switch (data.event) {
          case 'start': {
            streamSid = data.start.streamSid;
            console.log('▶️  Stream Twilio inició:', streamSid);
            latestMediaTimestamp = 0;
            responseStartTimestampTwilio = null;
            break;
          }

          case 'media': {
            // Timestamp de Twilio (ms) – útil para truncar
            latestMediaTimestamp = data.media.timestamp;

            // Enviar audio entrante al buffer de entrada
            if (openAiWs.readyState === WebSocket.OPEN) {
              const audioAppend = {
                type: 'input_audio_buffer.append',
                audio: data.media.payload, // base64 PCMU
              };
              openAiWs.send(JSON.stringify(audioAppend));
            }
            break;
          }

          case 'mark': {
            // Consumimos marcas pendientes
            if (markQueue.length > 0) markQueue.shift();
            break;
          }

          default:
            // Otros eventos de Twilio: stop, clear, etc.
            // console.log('Twilio event:', data.event);
            break;
        }
      } catch (err) {
        console.error('❌ Error parseando mensaje Twilio:', err?.message || err);
        console.error('Raw:', message?.toString?.());
      }
    });

    connection.on('close', () => {
      console.log('🧹 Twilio desconectado.');
      try {
        if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
      } catch {}
    });
  });
});

// =========================
// Arranque servidor
// =========================
fastify
  .listen({ port: PORT, host: '0.0.0.0' })
  .then(() => {
    console.log(`🚀 Server running at http://0.0.0.0:${PORT}`);
  })
  .catch((err) => {
    console.error('Server error:', err);
    process.exit(1);
  });
