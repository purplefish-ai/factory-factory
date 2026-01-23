'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { trpc } from '../../../frontend/lib/trpc';
import type { MailWithRelations } from '../../../frontend/lib/types';

export default function MailDetailPage({ params }: { params: { id: string } }) {
  const { id } = params;
  const router = useRouter();
  const [showReply, setShowReply] = useState(false);
  const [replyBody, setReplyBody] = useState('');
  const [error, setError] = useState('');

  const {
    data: mailData,
    isLoading,
    error: fetchError,
  } = trpc.mail.getById.useQuery({ id }, { refetchInterval: false });

  // Cast to include relations
  const mail = mailData as MailWithRelations | undefined;

  const replyMutation = trpc.mail.reply.useMutation({
    onSuccess: () => {
      router.push('/mail');
    },
    onError: (err) => {
      setError(err.message);
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-pulse text-gray-500">Loading mail...</div>
      </div>
    );
  }

  if (fetchError || !mail) {
    return (
      <div className="flex flex-col items-center justify-center h-full">
        <p className="text-red-600 mb-4">Mail not found</p>
        <Link href="/mail" className="text-blue-600 hover:text-blue-800">
          Back to inbox
        </Link>
      </div>
    );
  }

  const handleReply = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!replyBody.trim()) {
      setError('Reply message is required');
      return;
    }

    replyMutation.mutate({ inReplyToMailId: id, body: replyBody });
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link href="/mail" className="text-gray-500 hover:text-gray-700">
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
          <h1 className="text-2xl font-bold text-gray-900">{mail.subject}</h1>
          <p className="text-sm text-gray-500 mt-1">
            {new Date(mail.createdAt).toLocaleString()}
          </p>
        </div>
      </div>

      {/* Mail Content */}
      <div className="bg-white rounded-lg shadow-sm">
        {/* From/To */}
        <div className="p-4 border-b">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">
                <span className="font-medium">From:</span>{' '}
                {mail.fromAgent ? (
                  <Link
                    href={`/agents/${mail.fromAgent.id}`}
                    className="text-blue-600 hover:text-blue-800"
                  >
                    {mail.fromAgent.type} ({mail.fromAgent.id.slice(0, 8)}...)
                  </Link>
                ) : (
                  <span>Human</span>
                )}
              </p>
              {mail.toAgent && (
                <p className="text-sm text-gray-600">
                  <span className="font-medium">To:</span>{' '}
                  <Link
                    href={`/agents/${mail.toAgent.id}`}
                    className="text-blue-600 hover:text-blue-800"
                  >
                    {mail.toAgent.type} ({mail.toAgent.id.slice(0, 8)}...)
                  </Link>
                </p>
              )}
            </div>
            <div className="text-sm text-gray-500">
              {mail.isRead ? (
                <span className="text-green-600">Read</span>
              ) : (
                <span className="text-blue-600 font-medium">Unread</span>
              )}
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="p-6">
          <pre className="whitespace-pre-wrap text-gray-700 font-sans">{mail.body}</pre>
        </div>

        {/* Actions */}
        {mail.fromAgent && (
          <div className="p-4 border-t bg-gray-50">
            {!showReply ? (
              <button
                onClick={() => setShowReply(true)}
                className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"
                  />
                </svg>
                Reply
              </button>
            ) : (
              <form onSubmit={handleReply} className="space-y-4">
                {error && (
                  <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded text-sm">
                    {error}
                  </div>
                )}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Reply to {mail.fromAgent.type}
                  </label>
                  <textarea
                    value={replyBody}
                    onChange={(e) => setReplyBody(e.target.value)}
                    rows={4}
                    className="w-full border rounded-lg px-3 py-2"
                    placeholder="Your reply..."
                    autoFocus
                  />
                </div>
                <div className="flex gap-3">
                  <button
                    type="submit"
                    disabled={replyMutation.isPending}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                  >
                    {replyMutation.isPending ? 'Sending...' : 'Send Reply'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowReply(false);
                      setReplyBody('');
                      setError('');
                    }}
                    className="px-4 py-2 text-gray-700 bg-gray-200 rounded-lg hover:bg-gray-300"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </div>
        )}
      </div>

      {/* Related Agent Info */}
      {mail.fromAgent && (
        <div className="bg-white rounded-lg shadow-sm p-4">
          <h3 className="font-medium mb-2">Sender Agent</h3>
          <div className="flex items-center justify-between">
            <div className="text-sm text-gray-600">
              <p>Type: {mail.fromAgent.type}</p>
              <p>State: {mail.fromAgent.state}</p>
            </div>
            <Link
              href={`/agents/${mail.fromAgent.id}`}
              className="text-blue-600 hover:text-blue-800 text-sm"
            >
              View Agent
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
