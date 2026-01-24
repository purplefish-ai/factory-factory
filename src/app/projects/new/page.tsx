'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { trpc } from '../../../frontend/lib/trpc';

export default function NewProjectPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [worktreeBasePath, setWorktreeBasePath] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [githubOwner, setGithubOwner] = useState('');
  const [githubRepo, setGithubRepo] = useState('');
  const [error, setError] = useState('');

  const createProject = trpc.project.create.useMutation({
    onSuccess: () => {
      router.push('/projects');
    },
    onError: (err) => {
      setError(err.message);
    },
  });

  // Auto-generate slug from name
  const handleNameChange = (value: string) => {
    setName(value);
    // Generate slug: lowercase, replace spaces with hyphens, remove special chars
    const generatedSlug = value
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '');
    setSlug(generatedSlug);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!name.trim()) {
      setError('Name is required');
      return;
    }

    if (!slug.trim()) {
      setError('Slug is required');
      return;
    }

    if (!repoPath.trim()) {
      setError('Repository path is required');
      return;
    }

    if (!worktreeBasePath.trim()) {
      setError('Worktree base path is required');
      return;
    }

    createProject.mutate({
      name,
      slug,
      repoPath,
      worktreeBasePath,
      defaultBranch: defaultBranch || 'main',
      githubOwner: githubOwner || undefined,
      githubRepo: githubRepo || undefined,
    });
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
          <h1 className="text-2xl font-bold text-gray-900">Create New Project</h1>
          <p className="text-gray-600 mt-1">Add a new repository to manage</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="bg-white rounded-lg shadow-sm p-6 space-y-6">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">
            {error}
          </div>
        )}

        <div>
          <label htmlFor="name" className="block text-sm font-medium text-gray-700 mb-1">
            Name <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            id="name"
            value={name}
            onChange={(e) => handleNameChange(e.target.value)}
            className="w-full border rounded-lg px-4 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            placeholder="My Project"
          />
        </div>

        <div>
          <label htmlFor="slug" className="block text-sm font-medium text-gray-700 mb-1">
            Slug <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            id="slug"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            className="w-full border rounded-lg px-4 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono"
            placeholder="my-project"
          />
          <p className="text-xs text-gray-500 mt-1">
            URL-friendly identifier (lowercase letters, numbers, and hyphens only)
          </p>
        </div>

        <div>
          <label htmlFor="repoPath" className="block text-sm font-medium text-gray-700 mb-1">
            Repository Path <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            id="repoPath"
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
            className="w-full border rounded-lg px-4 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono"
            placeholder="/Users/you/code/my-project"
          />
          <p className="text-xs text-gray-500 mt-1">
            Absolute path to the git repository on your local machine
          </p>
        </div>

        <div>
          <label
            htmlFor="worktreeBasePath"
            className="block text-sm font-medium text-gray-700 mb-1"
          >
            Worktree Base Path <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            id="worktreeBasePath"
            value={worktreeBasePath}
            onChange={(e) => setWorktreeBasePath(e.target.value)}
            className="w-full border rounded-lg px-4 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono"
            placeholder="/tmp/factoryfactory-worktrees/my-project"
          />
          <p className="text-xs text-gray-500 mt-1">
            Directory where git worktrees will be created for this project
          </p>
        </div>

        <div>
          <label htmlFor="defaultBranch" className="block text-sm font-medium text-gray-700 mb-1">
            Default Branch
          </label>
          <input
            type="text"
            id="defaultBranch"
            value={defaultBranch}
            onChange={(e) => setDefaultBranch(e.target.value)}
            className="w-full border rounded-lg px-4 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono"
            placeholder="main"
          />
        </div>

        <div className="border-t pt-6">
          <h3 className="text-sm font-medium text-gray-700 mb-4">GitHub Integration (Optional)</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="githubOwner" className="block text-sm font-medium text-gray-700 mb-1">
                GitHub Owner
              </label>
              <input
                type="text"
                id="githubOwner"
                value={githubOwner}
                onChange={(e) => setGithubOwner(e.target.value)}
                className="w-full border rounded-lg px-4 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                placeholder="your-org"
              />
            </div>
            <div>
              <label htmlFor="githubRepo" className="block text-sm font-medium text-gray-700 mb-1">
                GitHub Repo
              </label>
              <input
                type="text"
                id="githubRepo"
                value={githubRepo}
                onChange={(e) => setGithubRepo(e.target.value)}
                className="w-full border rounded-lg px-4 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                placeholder="my-project"
              />
            </div>
          </div>
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
            {createProject.isPending ? 'Creating...' : 'Create Project'}
          </button>
        </div>
      </form>
    </div>
  );
}
