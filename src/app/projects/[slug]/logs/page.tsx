'use client';

import { ChevronDown, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Loading } from '@/frontend/components/loading';
import { PageHeader } from '@/frontend/components/page-header';
import { trpc } from '../../../../frontend/lib/trpc';
import type { DecisionLogWithRelations } from '../../../../frontend/lib/types';

export default function ProjectLogsPage() {
  const params = useParams();
  const slug = params.slug as string;

  const [agentFilter, setAgentFilter] = useState<string>('all');
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);

  const { data: project } = trpc.project.getBySlug.useQuery({ slug });

  const { data: logsData, isLoading } = trpc.decisionLog.listRecent.useQuery(
    { limit: 100 },
    { enabled: !!project?.id, refetchInterval: 5000 }
  );

  const logs = logsData as DecisionLogWithRelations[] | undefined;

  const { data: agents } = trpc.agent.list.useQuery({}, { enabled: !!project?.id });

  const filteredLogs = logs?.filter((log) => {
    if (agentFilter === 'all') {
      return true;
    }
    return log.agentId === agentFilter;
  });

  if (isLoading) {
    return <Loading message="Loading logs..." />;
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Decision Logs" description="Audit trail of all agent decisions" />

      <Card>
        <CardContent className="pt-6">
          <div className="flex gap-4 items-center">
            <label className="text-sm font-medium">Filter by agent:</label>
            <Select value={agentFilter} onValueChange={setAgentFilter}>
              <SelectTrigger className="w-[200px]">
                <SelectValue placeholder="All Agents" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Agents</SelectItem>
                {agents?.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    {agent.type} - {agent.id.slice(0, 8)}...
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {agentFilter !== 'all' && (
              <Button variant="ghost" size="sm" onClick={() => setAgentFilter('all')}>
                Clear filter
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        {!filteredLogs || filteredLogs.length === 0 ? (
          <Empty className="py-12">
            <EmptyHeader>
              <EmptyTitle>No decision logs found</EmptyTitle>
              <EmptyDescription>
                {agentFilter !== 'all'
                  ? 'Try clearing the filter to see all logs.'
                  : 'Logs will appear here as agents make decisions.'}
              </EmptyDescription>
            </EmptyHeader>
            {agentFilter !== 'all' && (
              <Button variant="outline" onClick={() => setAgentFilter('all')}>
                Clear filter
              </Button>
            )}
          </Empty>
        ) : (
          <div className="divide-y">
            {filteredLogs.map((log) => (
              <div key={log.id} className="p-4 hover:bg-muted/50 transition-colors">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      {log.agent && (
                        <Link href={`/projects/${slug}/agents/${log.agentId}`}>
                          <Badge variant="secondary" className="hover:bg-secondary/80">
                            {log.agent.type}
                          </Badge>
                        </Link>
                      )}
                      <span className="text-xs text-muted-foreground">
                        {new Date(log.timestamp).toLocaleString()}
                      </span>
                    </div>
                    <p className="font-medium">{log.decision}</p>
                    <p className="text-sm text-muted-foreground mt-1">{log.reasoning}</p>
                    {log.context && (
                      <Collapsible
                        open={expandedLogId === log.id}
                        onOpenChange={(open) => setExpandedLogId(open ? log.id : null)}
                        className="mt-2"
                      >
                        <CollapsibleTrigger asChild>
                          <Button variant="ghost" size="sm" className="h-auto p-0 text-xs">
                            {expandedLogId === log.id ? (
                              <>
                                <ChevronDown className="h-3 w-3 mr-1" />
                                Hide context
                              </>
                            ) : (
                              <>
                                <ChevronRight className="h-3 w-3 mr-1" />
                                Show context
                              </>
                            )}
                          </Button>
                        </CollapsibleTrigger>
                        <CollapsibleContent>
                          <pre className="mt-2 text-xs bg-muted p-3 rounded overflow-x-auto max-h-64">
                            {log.context}
                          </pre>
                        </CollapsibleContent>
                      </Collapsible>
                    )}
                  </div>
                  <Button variant="ghost" size="sm" asChild>
                    <Link href={`/projects/${slug}/agents/${log.agentId}`}>View Agent</Link>
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
