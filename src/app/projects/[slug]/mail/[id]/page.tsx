'use client';

import { ArrowLeft, Reply } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Loading } from '@/frontend/components/loading';
import { trpc } from '../../../../../frontend/lib/trpc';
import type { MailWithRelations } from '../../../../../frontend/lib/types';

export default function ProjectMailDetailPage() {
  const params = useParams();
  const slug = params.slug as string;
  const id = params.id as string;
  const router = useRouter();
  const [showReply, setShowReply] = useState(false);
  const [replyBody, setReplyBody] = useState('');
  const [error, setError] = useState('');

  const {
    data: mailData,
    isLoading,
    error: fetchError,
  } = trpc.mail.getById.useQuery({ id }, { refetchInterval: false });

  const mail = mailData as MailWithRelations | undefined;

  const replyMutation = trpc.mail.reply.useMutation({
    onSuccess: () => {
      router.push(`/projects/${slug}/mail`);
    },
    onError: (err) => {
      setError(err.message);
    },
  });

  if (isLoading) {
    return <Loading message="Loading mail..." />;
  }

  if (fetchError || !mail) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <p className="text-destructive">Mail not found</p>
        <Button variant="outline" asChild>
          <Link href={`/projects/${slug}/mail`}>Back to inbox</Link>
        </Button>
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
    <div className="max-w-3xl mx-auto space-y-4">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link href={`/projects/${slug}/mail`}>
            <ArrowLeft className="h-5 w-5" />
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{mail.subject}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {new Date(mail.createdAt).toLocaleString()}
          </p>
        </div>
      </div>

      <Card>
        <CardHeader className="border-b">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">
                <span className="font-medium">From:</span>{' '}
                {mail.fromAgent ? (
                  <Link
                    href={`/projects/${slug}/agents/${mail.fromAgent.id}`}
                    className="text-primary hover:underline"
                  >
                    {mail.fromAgent.type} ({mail.fromAgent.id.slice(0, 8)}...)
                  </Link>
                ) : (
                  <span>Human</span>
                )}
              </p>
              {mail.toAgent && (
                <p className="text-sm text-muted-foreground">
                  <span className="font-medium">To:</span>{' '}
                  <Link
                    href={`/projects/${slug}/agents/${mail.toAgent.id}`}
                    className="text-primary hover:underline"
                  >
                    {mail.toAgent.type} ({mail.toAgent.id.slice(0, 8)}...)
                  </Link>
                </p>
              )}
            </div>
            <Badge variant={mail.isRead ? 'secondary' : 'default'}>
              {mail.isRead ? 'Read' : 'Unread'}
            </Badge>
          </div>
        </CardHeader>

        <CardContent className="pt-6">
          <pre className="whitespace-pre-wrap font-sans">{mail.body}</pre>
        </CardContent>

        {mail.fromAgent && (
          <CardFooter className="border-t bg-muted/50">
            {!showReply ? (
              <Button onClick={() => setShowReply(true)}>
                <Reply className="h-4 w-4 mr-2" />
                Reply
              </Button>
            ) : (
              <form onSubmit={handleReply} className="w-full space-y-4">
                {error && (
                  <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}
                <div className="space-y-2">
                  <Label>Reply to {mail.fromAgent.type}</Label>
                  <Textarea
                    value={replyBody}
                    onChange={(e) => setReplyBody(e.target.value)}
                    rows={4}
                    placeholder="Your reply..."
                  />
                </div>
                <div className="flex gap-3">
                  <Button type="submit" disabled={replyMutation.isPending}>
                    {replyMutation.isPending ? 'Sending...' : 'Send Reply'}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setShowReply(false);
                      setReplyBody('');
                      setError('');
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            )}
          </CardFooter>
        )}
      </Card>

      {mail.fromAgent && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Sender Agent</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <div className="text-sm text-muted-foreground space-y-1">
                <p>Type: {mail.fromAgent.type}</p>
                <p>State: {mail.fromAgent.state}</p>
              </div>
              <Button variant="outline" size="sm" asChild>
                <Link href={`/projects/${slug}/agents/${mail.fromAgent.id}`}>View Agent</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
