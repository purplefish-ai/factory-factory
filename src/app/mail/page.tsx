'use client';

import Link from 'next/link';
import { useState } from 'react';
import { trpc } from '../../frontend/lib/trpc';

export default function MailPage() {
  const [showComposeModal, setShowComposeModal] = useState(false);

  const {
    data: mail,
    isLoading,
    refetch,
  } = trpc.mail.listHumanInbox.useQuery({ includeRead: true }, { refetchInterval: 5000 });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-pulse text-gray-500">Loading mail...</div>
      </div>
    );
  }

  const unreadCount = mail?.filter((m) => !m.isRead).length ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Mail Inbox</h1>
          <p className="text-gray-600 mt-1">
            Communication from agents
            {unreadCount > 0 && <span className="ml-2 text-blue-600">({unreadCount} unread)</span>}
          </p>
        </div>
        <button
          onClick={() => setShowComposeModal(true)}
          className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
            />
          </svg>
          Compose
        </button>
      </div>

      {/* Mail List */}
      <div className="bg-white rounded-lg shadow-sm overflow-hidden">
        {!mail || mail.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            <svg
              className="w-12 h-12 mx-auto text-gray-300 mb-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"
              />
            </svg>
            <p>Your inbox is empty</p>
            <p className="text-sm mt-2">Messages from agents will appear here</p>
          </div>
        ) : (
          <div className="divide-y">
            {mail.map((item) => (
              <Link
                key={item.id}
                href={`/mail/${item.id}`}
                className={`block p-4 hover:bg-gray-50 ${!item.isRead ? 'bg-blue-50' : ''}`}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      {!item.isRead && (
                        <span className="w-2 h-2 bg-blue-600 rounded-full flex-shrink-0"></span>
                      )}
                      <p
                        className={`text-sm truncate ${!item.isRead ? 'font-semibold text-gray-900' : 'text-gray-700'}`}
                      >
                        {item.subject}
                      </p>
                    </div>
                    <p className="text-sm text-gray-500 mt-1">
                      From:{' '}
                      {(item as { fromAgent?: { type: string; id: string } }).fromAgent?.type ||
                        'System'}{' '}
                      {(item as { fromAgent?: { type: string; id: string } }).fromAgent?.id && (
                        <span className="font-mono text-xs">
                          ({(item as { fromAgent?: { id: string } }).fromAgent?.id.slice(0, 8)}...)
                        </span>
                      )}
                    </p>
                    <p className="text-sm text-gray-400 truncate mt-1">
                      {item.body.slice(0, 100)}...
                    </p>
                  </div>
                  <span className="text-xs text-gray-400 flex-shrink-0 ml-4">
                    {new Date(item.createdAt).toLocaleString()}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Compose Modal */}
      {showComposeModal && (
        <ComposeModal
          onClose={() => setShowComposeModal(false)}
          onSent={() => {
            setShowComposeModal(false);
            refetch();
          }}
        />
      )}
    </div>
  );
}

function ComposeModal({ onClose, onSent }: { onClose: () => void; onSent: () => void }) {
  const [toAgentId, setToAgentId] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState('');

  const { data: agents } = trpc.agent.list.useQuery();

  const sendMail = trpc.mail.sendToAgent.useMutation({
    onSuccess: () => {
      onSent();
    },
    onError: (err) => {
      setError(err.message);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!toAgentId) {
      setError('Please select an agent');
      return;
    }
    if (!subject.trim()) {
      setError('Subject is required');
      return;
    }
    if (!body.trim()) {
      setError('Message body is required');
      return;
    }

    sendMail.mutate({ toAgentId, subject, body });
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg">
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="text-lg font-semibold">Compose Message</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded text-sm">
              {error}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">To (Agent)</label>
            <select
              value={toAgentId}
              onChange={(e) => setToAgentId(e.target.value)}
              className="w-full border rounded-lg px-3 py-2"
            >
              <option value="">Select an agent...</option>
              {agents?.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.type} - {agent.id.slice(0, 8)}... ({agent.state})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Subject</label>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="w-full border rounded-lg px-3 py-2"
              placeholder="Message subject"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Message</label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={6}
              className="w-full border rounded-lg px-3 py-2"
              placeholder="Your message to the agent..."
            />
          </div>

          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={sendMail.isPending}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {sendMail.isPending ? 'Sending...' : 'Send'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
