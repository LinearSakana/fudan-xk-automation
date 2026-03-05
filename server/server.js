'use strict';

const Fastify = require('fastify');
const { Scheduler } = require('./scheduler');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 30522);

function buildServer() {
  const fastify = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
    },
  });

  const scheduler = new Scheduler({
    logger: fastify.log,
    baseUrl: process.env.XK_BASE_URL || 'https://xk.fudan.edu.cn',
    captchaRecordsPath: process.env.CAPTCHA_RECORDS_PATH || '',
  });

  // Minimal CORS support for userscript -> localhost calls.
  fastify.addHook('onRequest', async (request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type');
    if (request.method === 'OPTIONS') {
      return reply.code(204).send();
    }
  });

  fastify.post('/start', async (request, reply) => {
    const payload = request.body || {};
    await scheduler.start(payload);
    return reply.send({ ok: true });
  });

  fastify.post('/stop', async (_request, reply) => {
    await scheduler.stop();
    return reply.send({ ok: true });
  });

  fastify.get('/status', async (_request, reply) => {
    return reply.send(scheduler.getState());
  });

  fastify.setErrorHandler((error, _request, reply) => {
    fastify.log.error({ err: error }, 'request failed');
    const statusCode = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    return reply.status(statusCode).send({ ok: false, error: error.message });
  });

  fastify.addHook('onClose', async () => {
    await scheduler.stop();
  });

  return fastify;
}

async function main() {
  const server = buildServer();
  await server.listen({ host: HOST, port: PORT });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  buildServer,
};
