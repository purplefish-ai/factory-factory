import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './globals.css';
import { installChunkLoadRecovery } from '@/client/lib/chunk-load-recovery';
import { Router } from './router';

installChunkLoadRecovery();

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element not found');
}

createRoot(rootElement).render(
  <StrictMode>
    <Router />
  </StrictMode>
);
