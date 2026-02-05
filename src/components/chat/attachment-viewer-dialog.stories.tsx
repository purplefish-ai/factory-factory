import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import type { MessageAttachment } from '@/lib/claude-types';
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

const SAMPLE_LONG_TEXT = `# API Documentation

## Overview
This document describes the REST API endpoints for the application.

## Authentication
All API requests require authentication using a Bearer token:

\`\`\`
Authorization: Bearer YOUR_TOKEN_HERE
\`\`\`

## Endpoints

### GET /api/users
Retrieve a list of all users.

**Query Parameters:**
- \`page\` (number): Page number for pagination (default: 1)
- \`limit\` (number): Number of items per page (default: 20)
- \`sort\` (string): Sort field (default: 'createdAt')

**Response:**
\`\`\`json
{
  "users": [
    {
      "id": "123",
      "name": "John Doe",
      "email": "john@example.com",
      "createdAt": "2024-01-01T00:00:00Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 100
  }
}
\`\`\`

### POST /api/users
Create a new user.

**Request Body:**
\`\`\`json
{
  "name": "Jane Smith",
  "email": "jane@example.com",
  "password": "securepassword123"
}
\`\`\`

**Response:**
\`\`\`json
{
  "id": "124",
  "name": "Jane Smith",
  "email": "jane@example.com",
  "createdAt": "2024-01-02T00:00:00Z"
}
\`\`\`

### GET /api/users/:id
Retrieve a specific user by ID.

**Response:**
\`\`\`json
{
  "id": "123",
  "name": "John Doe",
  "email": "john@example.com",
  "createdAt": "2024-01-01T00:00:00Z"
}
\`\`\`

### PUT /api/users/:id
Update a user.

### DELETE /api/users/:id
Delete a user.

## Error Handling
All errors follow this format:

\`\`\`json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable error message"
  }
}
\`\`\`

Common error codes:
- \`UNAUTHORIZED\`: Missing or invalid authentication
- \`NOT_FOUND\`: Resource not found
- \`VALIDATION_ERROR\`: Invalid request data
- \`INTERNAL_ERROR\`: Server error`;

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
  name: 'api-documentation.md',
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
