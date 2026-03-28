import { Sovereign } from './sovereign';

const sovereign = new Sovereign();

sovereign.start().catch((err) => {
  console.error('[SOVEREIGN] Fatal error:', err);
  process.exit(1);
});

// Graceful shutdown
const shutdown = async () => {
  await sovereign.stop();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
