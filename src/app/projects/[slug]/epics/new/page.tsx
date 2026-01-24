'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { trpc } from '../../../../../frontend/lib/trpc';

export default function NewEpicPage() {
  const params = useParams();
  const router = useRouter();
  const slug = params.slug as string;

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [design, setDesign] = useState('');
  const [error, setError] = useState('');

  const { data: project } = trpc.project.getBySlug.useQuery({ slug });

  const createEpic = trpc.epic.create.useMutation({
    onSuccess: (epic) => {
      router.push(`/projects/${slug}/epics/${epic.id}`);
    },
    onError: (err) => {
      setError(err.message);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!project?.id) {
      setError('Project not found');
      return;
    }

    if (!title.trim()) {
      setError('Title is required');
      return;
    }

    createEpic.mutate({ title, description, design });
  };

  if (!project) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-pulse text-gray-500">Loading...</div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center gap-4">
        <Link href={`/projects/${slug}/epics`} className="text-gray-500 hover:text-gray-700">
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M10 19l-7-7m0 0l7-7m-7 7h18"
            />
          </svg>
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Create New Epic</h1>
          <p className="text-gray-600 mt-1">{project.name}</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="bg-white rounded-lg shadow-sm p-6 space-y-6">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">
            {error}
          </div>
        )}

        <div>
          <label htmlFor="title" className="block text-sm font-medium text-gray-700 mb-1">
            Title <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            id="title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full border rounded-lg px-4 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            placeholder="E.g., Add user authentication system"
            autoFocus
          />
        </div>

        <div>
          <label htmlFor="description" className="block text-sm font-medium text-gray-700 mb-1">
            Description
          </label>
          <textarea
            id="description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="w-full border rounded-lg px-4 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            placeholder="Brief description of what this epic accomplishes"
          />
        </div>

        <div>
          <label htmlFor="design" className="block text-sm font-medium text-gray-700 mb-1">
            Design Document (Markdown)
          </label>
          <p className="text-xs text-gray-500 mb-2">
            Detailed technical design for the supervisor agent to follow
          </p>
          <textarea
            id="design"
            value={design}
            onChange={(e) => setDesign(e.target.value)}
            rows={15}
            className="w-full border rounded-lg px-4 py-2 font-mono text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            placeholder={`## Overview
Describe the feature at a high level...

## Requirements
- Requirement 1
- Requirement 2

## Technical Design
Describe the implementation approach...

## Tasks
1. Create database schema
2. Implement API endpoints
3. Build frontend components
4. Write tests`}
          />
        </div>

        <div className="flex justify-end gap-4">
          <Link
            href={`/projects/${slug}/epics`}
            className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
          >
            Cancel
          </Link>
          <button
            type="submit"
            disabled={createEpic.isPending}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {createEpic.isPending ? 'Creating...' : 'Create Epic'}
          </button>
        </div>
      </form>
    </div>
  );
}
