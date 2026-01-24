'use client';

import Link from 'next/link';
import { trpc } from '../../frontend/lib/trpc';

export default function ProjectsPage() {
  const {
    data: projects,
    isLoading,
    refetch,
  } = trpc.project.list.useQuery({ isArchived: false }, { refetchInterval: 10_000 });

  const archiveMutation = trpc.project.archive.useMutation({
    onSuccess: () => {
      refetch();
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-pulse text-gray-500">Loading projects...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Projects</h1>
          <p className="text-gray-600 mt-1">Manage your repositories</p>
        </div>
        <Link
          href="/projects/new"
          className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          New Project
        </Link>
      </div>

      {/* Project List */}
      <div className="bg-white rounded-lg shadow-sm overflow-hidden">
        {!projects || projects.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            <p>No projects found.</p>
            <Link
              href="/projects/new"
              className="text-blue-600 hover:text-blue-800 mt-2 inline-block"
            >
              Create your first project
            </Link>
          </div>
        ) : (
          <table className="w-full">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Name
                </th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Repository Path
                </th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Default Branch
                </th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Epics
                </th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {projects.map((project) => (
                <tr key={project.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4">
                    <div>
                      <div className="font-medium text-gray-900">{project.name}</div>
                      <div className="text-sm text-gray-500">{project.slug}</div>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <code className="text-sm text-gray-600 bg-gray-100 px-2 py-1 rounded">
                      {project.repoPath}
                    </code>
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-500">{project.defaultBranch}</td>
                  <td className="px-6 py-4 text-sm text-gray-500">
                    {'_count' in project ? (project._count as { epics: number }).epics : '-'}
                  </td>
                  <td className="px-6 py-4">
                    <button
                      onClick={() => {
                        if (confirm('Are you sure you want to archive this project?')) {
                          archiveMutation.mutate({ id: project.id });
                        }
                      }}
                      className="text-red-600 hover:text-red-800 text-sm"
                      disabled={archiveMutation.isPending}
                    >
                      {archiveMutation.isPending ? 'Archiving...' : 'Archive'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
