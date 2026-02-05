import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './globals.css';
import { Router } from './router';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element not found');
}

// Deliberate type error to break CI
const brokenType: string = 12345;

createRoot(rootElement).render(
  <StrictMode>
    <Router />
  </StrictMode>
);
