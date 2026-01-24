'use client';

import { Inbox, Send } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Loading } from '@/frontend/components/loading';
import { PageHeader } from '@/frontend/components/page-header';
import { trpc } from '../../../../frontend/lib/trpc';

type MailFilter = { type: 'all' } | { type: 'human' } | { type: 'agent'; agentId: string };

function getMailQueryResult<T>(
  filter: MailFilter,
  allData: T | undefined,
  humanData: T | undefined,
  agentData: T | undefined
): T | undefined {
  switch (filter.type) {
    case 'all':
      return allData;
    case 'human':
      return humanData;
    case 'agent':
      return agentData;
  }
}

function getFilterTitle(filter: MailFilter): string {
  switch (filter.type) {
    case 'all':
      return 'All System Mail';
    case 'human':
      return 'Mail Inbox';
    case 'agent':
      return 'Agent Inbox';
  }
}

function getFilterDescription(filter: MailFilter, agentType: string | undefined): string {
  switch (filter.type) {
    case 'all':
      return 'All mail in the system';
    case 'human':
      return 'Communication from agents';
    case 'agent':
      return `Mail for ${agentType || 'agent'}`;
  }
}

export default function ProjectMailPage() {
  const params = useParams();
  const slug = params.slug as string;

  const [showComposeModal, setShowComposeModal] = useState(false);
  const [filter, setFilter] = useState<MailFilter>({ type: 'human' });

  const { data: project } = trpc.project.getBySlug.useQuery({ slug });
  const { data: agents } = trpc.agent.list.useQuery({}, { enabled: !!project?.id });

  const allMailQuery = trpc.mail.listAll.useQuery(
    { includeRead: true },
    { enabled: filter.type === 'all' && !!project?.id, refetchInterval: 5000 }
  );

  const humanMailQuery = trpc.mail.listHumanInbox.useQuery(
    { includeRead: true },
    { enabled: filter.type === 'human' && !!project?.id, refetchInterval: 5000 }
  );

  const agentMailQuery = trpc.mail.listAgentInbox.useQuery(
    { agentId: filter.type === 'agent' ? filter.agentId : '', includeRead: true },
    { enabled: filter.type === 'agent', refetchInterval: 5000 }
  );

  const mail = getMailQueryResult(
    filter,
    allMailQuery.data,
    humanMailQuery.data,
    agentMailQuery.data
  );
  const isLoading = getMailQueryResult(
    filter,
    allMailQuery.isLoading,
    humanMailQuery.isLoading,
    agentMailQuery.isLoading
  );
  const refetch = getMailQueryResult(
    filter,
    allMailQuery.refetch,
    humanMailQuery.refetch,
    agentMailQuery.refetch
  );

  if (isLoading) {
    return <Loading message="Loading mail..." />;
  }

  const unreadCount = mail?.filter((m) => !m.isRead).length ?? 0;
  const selectedAgent =
    filter.type === 'agent' ? agents?.find((a) => a.id === filter.agentId) : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title={getFilterTitle(filter)}
        description={`${getFilterDescription(filter, selectedAgent?.type)}${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
      >
        <Button onClick={() => setShowComposeModal(true)}>
          <Send className="h-4 w-4 mr-2" />
          Compose
        </Button>
      </PageHeader>

      <Card>
        <CardContent className="pt-6">
          <div className="flex gap-4 items-center flex-wrap">
            <Label>View:</Label>

            <div className="flex gap-2">
              <Button
                variant={filter.type === 'human' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setFilter({ type: 'human' })}
              >
                My Inbox
              </Button>
              <Button
                variant={filter.type === 'all' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setFilter({ type: 'all' })}
              >
                All Mail
              </Button>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">or</span>
              <Select
                value={filter.type === 'agent' ? filter.agentId : ''}
                onValueChange={(value) => {
                  if (value) {
                    setFilter({ type: 'agent', agentId: value });
                  }
                }}
              >
                <SelectTrigger className="w-[200px]">
                  <SelectValue placeholder="Select agent inbox..." />
                </SelectTrigger>
                <SelectContent>
                  {agents?.map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      {agent.type} - {agent.id.slice(0, 8)}...
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {filter.type === 'agent' && (
              <Button variant="ghost" size="sm" onClick={() => setFilter({ type: 'human' })}>
                Clear filter
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        {!mail || mail.length === 0 ? (
          <Empty className="py-12">
            <EmptyMedia variant="icon">
              <Inbox />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>Your inbox is empty</EmptyTitle>
              <EmptyDescription>Messages from agents will appear here</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="divide-y">
            {mail.map((item) => (
              <Link
                key={item.id}
                href={`/projects/${slug}/mail/${item.id}`}
                className={`block p-4 hover:bg-muted/50 transition-colors ${!item.isRead ? 'bg-primary/5' : ''}`}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      {!item.isRead && (
                        <span className="w-2 h-2 bg-primary rounded-full flex-shrink-0" />
                      )}
                      <p className={`text-sm truncate ${!item.isRead ? 'font-semibold' : ''}`}>
                        {item.subject}
                      </p>
                    </div>
                    <p className="text-sm text-muted-foreground mt-1">
                      <MailParticipants
                        item={item as MailWithRelations}
                        showRecipient={filter.type === 'all'}
                      />
                    </p>
                    <p className="text-sm text-muted-foreground/70 truncate mt-1">
                      {item.body.slice(0, 100)}...
                    </p>
                  </div>
                  <span className="text-xs text-muted-foreground flex-shrink-0 ml-4">
                    {new Date(item.createdAt).toLocaleString()}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </Card>

      <Dialog open={showComposeModal} onOpenChange={setShowComposeModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Compose Message</DialogTitle>
          </DialogHeader>
          <ComposeForm
            onSent={() => {
              setShowComposeModal(false);
              refetch?.();
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

type MailWithRelations = {
  id: string;
  fromAgentId: string | null;
  toAgentId: string | null;
  isForHuman: boolean;
  fromAgent?: { type: string; id: string } | null;
  toAgent?: { type: string; id: string } | null;
};

function MailParticipants({
  item,
  showRecipient,
}: {
  item: MailWithRelations;
  showRecipient: boolean;
}) {
  return (
    <>
      From:{' '}
      {item.fromAgent ? (
        <>
          {item.fromAgent.type}{' '}
          <span className="font-mono text-xs">({item.fromAgent.id.slice(0, 8)}...)</span>
        </>
      ) : (
        'Human'
      )}
      {showRecipient && (
        <>
          {' '}
          <span className="text-muted-foreground/50">→</span>{' '}
          {item.isForHuman ? (
            'Human'
          ) : item.toAgent ? (
            <>
              {item.toAgent.type}{' '}
              <span className="font-mono text-xs">({item.toAgent.id.slice(0, 8)}...)</span>
            </>
          ) : (
            'Unknown'
          )}
        </>
      )}
    </>
  );
}

function ComposeForm({ onSent }: { onSent: () => void }) {
  const [toAgentId, setToAgentId] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState('');

  const { data: agents } = trpc.agent.list.useQuery({});

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
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="space-y-2">
        <Label>To (Agent)</Label>
        <Select value={toAgentId} onValueChange={setToAgentId}>
          <SelectTrigger>
            <SelectValue placeholder="Select an agent..." />
          </SelectTrigger>
          <SelectContent>
            {agents?.map((agent) => (
              <SelectItem key={agent.id} value={agent.id}>
                {agent.type} - {agent.id.slice(0, 8)}... ({agent.state})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label>Subject</Label>
        <Input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="Message subject"
        />
      </div>

      <div className="space-y-2">
        <Label>Message</Label>
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={6}
          placeholder="Your message to the agent..."
        />
      </div>

      <div className="flex justify-end gap-3">
        <Button type="submit" disabled={sendMail.isPending}>
          {sendMail.isPending ? 'Sending...' : 'Send'}
        </Button>
      </div>
    </form>
  );
}
