'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { trpc } from '../../../frontend/lib/trpc';

export default function NewProjectPage() {
  const router = useRouter();
  const [repoPath, setRepoPath] = useState('');
  const [error, setError] = useState('');

  const createProject = trpc.project.create.useMutation({
    onSuccess: () => {
      router.push('/projects');
    },
    onError: (err) => {
      setError(err.message);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!repoPath.trim()) {
      setError('Repository path is required');
      return;
    }

    createProject.mutate({ repoPath });
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/projects" className="text-gray-500 hover:text-gray-700">
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
          <h1 className="text-2xl font-bold text-gray-900">Add Project</h1>
          <p className="text-gray-600 mt-1">Add a repository to manage with FactoryFactory</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="bg-white rounded-lg shadow-sm p-6 space-y-6">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">
            {error}
          </div>
        )}

        <div>
          <label htmlFor="repoPath" className="block text-sm font-medium text-gray-700 mb-1">
            Repository Path
          </label>
          <input
            type="text"
            id="repoPath"
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
            className="w-full border rounded-lg px-4 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono"
            placeholder="/Users/you/code/my-project"
            autoFocus
          />
          <p className="text-xs text-gray-500 mt-2">
            Path to a git repository on your local machine. The project name will be derived from
            the directory name.
          </p>
        </div>

        <div className="flex justify-end gap-4">
          <Link
            href="/projects"
            className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
          >
            Cancel
          </Link>
          <button
            type="submit"
            disabled={createProject.isPending}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {createProject.isPending ? 'Adding...' : 'Add Project'}
          </button>
        </div>
      </form>
    </div>
  );
}
