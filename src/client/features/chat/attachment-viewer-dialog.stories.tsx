import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import type { MessageAttachment } from '@/lib/chat-protocol';
import { AttachmentViewerDialog } from './attachment-viewer-dialog';

// Sample base64 image (1x1 red pixel PNG)
const SAMPLE_IMAGE_DATA =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

// Sample text content
const SAMPLE_TEXT = `import React from 'react';

interface Props {
  name: string;
  age: number;
}

export function UserCard({ name, age }: Props) {
  return (
    <div className="card">
      <h2>{name}</h2>
      <p>Age: {age}</p>
    </div>
  );
}

export default UserCard;`;

const SAMPLE_LONG_TEXT = `# Backend Integration Guide

## Overview
This document describes how the frontend communicates with the backend.
The app uses tRPC for product features and keeps /health for operational checks.

## Authentication
Session access is scoped by workspace and handled by the app runtime.
Use workspace/session IDs from application state when calling procedures.

## tRPC Procedures

### project.list
Returns projects visible to the user.

### project.create
Creates a project from a local repository path.

### workspace.create
Creates a workspace for manual work or GitHub issue intake.

### workspace.getDiffVsMain
Returns categorized file changes compared to the default branch.

## Operational Endpoints

### GET /health
Basic service status, version, and environment.

### GET /health/all
Aggregated health checks (database + rate limiter).

## Error Shape
tRPC errors expose structured data:

\`\`\`json
{
  "code": "BAD_REQUEST",
  "message": "Human readable error message",
  "data": {
    "path": "workspace.create"
  }
}
\`\`\`

`;

// Sample attachments
const imageAttachment: MessageAttachment = {
  id: 'img-1',
  name: 'screenshot.png',
  type: 'image/png',
  size: 1024 * 50,
  data: SAMPLE_IMAGE_DATA,
  contentType: 'image',
};

const textAttachment: MessageAttachment = {
  id: 'txt-1',
  name: 'user-card.tsx',
  type: 'text/plain',
  size: SAMPLE_TEXT.length,
  data: SAMPLE_TEXT,
  contentType: 'text',
};

const longTextAttachment: MessageAttachment = {
  id: 'txt-2',
  name: 'backend-integration-guide.md',
  type: 'text/plain',
  size: SAMPLE_LONG_TEXT.length,
  data: SAMPLE_LONG_TEXT,
  contentType: 'text',
};

const meta: Meta<typeof AttachmentViewerDialog> = {
  title: 'Chat/AttachmentViewerDialog',
  component: AttachmentViewerDialog,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof meta>;

// Interactive wrapper component for stories
function ViewerWrapper({ attachment }: { attachment: MessageAttachment }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="p-8">
      <Button onClick={() => setOpen(true)}>View {attachment.name}</Button>
      <AttachmentViewerDialog attachment={attachment} open={open} onOpenChange={setOpen} />
    </div>
  );
}

export const ImageViewer: Story = {
  render: () => <ViewerWrapper attachment={imageAttachment} />,
};

export const TextViewer: Story = {
  render: () => <ViewerWrapper attachment={textAttachment} />,
};

export const LongTextViewer: Story = {
  render: () => <ViewerWrapper attachment={longTextAttachment} />,
};

export const AllTypes: Story = {
  render: () => (
    <div className="flex flex-col gap-4 p-8">
      <ViewerWrapper attachment={imageAttachment} />
      <ViewerWrapper attachment={textAttachment} />
      <ViewerWrapper attachment={longTextAttachment} />
    </div>
  ),
};
