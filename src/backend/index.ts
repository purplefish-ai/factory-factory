import express from 'express';
import { serve } from 'inngest/express';
import { inngest } from './inngest/client';

const app = express();
const PORT = process.env.BACKEND_PORT || 3001;

app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'factoryfactory-backend',
  });
});

app.use(
  '/api/inngest',
  serve({
    client: inngest,
    functions: [],
  })
);

app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Inngest endpoint: http://localhost:${PORT}/api/inngest`);
});
