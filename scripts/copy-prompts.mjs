import { cpSync } from 'node:fs';

cpSync('prompts', 'dist/prompts', { recursive: true });
