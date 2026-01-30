'use client';

import type { inferRouterOutputs } from '@trpc/server';
import { Bug, Code, Compass, MessageSquare, Play } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { AppRouter } from '@/frontend/lib/trpc';
import { cn } from '@/lib/utils';

// =============================================================================
// Types
// =============================================================================

// Infer Workflow type from tRPC router to avoid duplication with backend
type RouterOutputs = inferRouterOutputs<AppRouter>;
type Workflow = RouterOutputs['session']['listWorkflows'][number];

interface WorkflowSelectorProps {
  workflows: Workflow[];
  recommendedWorkflow: string;
  onSelect: (workflowId: string) => void;
  disabled?: boolean;
  /** Warning message to show if workspace is not ready for sessions */
  warningMessage?: string;
}

// =============================================================================
// Helpers
// =============================================================================

function getWorkflowIcon(workflowId: string) {
  switch (workflowId) {
    case 'feature':
      return Code;
    case 'bugfix':
      return Bug;
    case 'explore':
      return Compass;
    case 'followup':
      return MessageSquare;
    default:
      return Code;
  }
}

// =============================================================================
// Component
// =============================================================================

export function WorkflowSelector({
  workflows,
  recommendedWorkflow,
  onSelect,
  disabled = false,
  warningMessage,
}: WorkflowSelectorProps) {
  const [selectedWorkflow, setSelectedWorkflow] = useState(recommendedWorkflow);

  return (
    <div className="flex flex-col items-center justify-center h-full p-8">
      <div className="max-w-2xl w-full space-y-6">
        <div className="text-center space-y-2">
          <h2 className="text-2xl font-semibold">Start a Session</h2>
          <p className="text-muted-foreground">
            Choose a workflow to guide Claude through your task.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {workflows.map((workflow) => {
            const Icon = getWorkflowIcon(workflow.id);
            const isSelected = selectedWorkflow === workflow.id;
            const isRecommended = workflow.id === recommendedWorkflow;

            return (
              <Card
                key={workflow.id}
                className={cn(
                  'cursor-pointer transition-all hover:border-primary/50',
                  isSelected && 'border-primary ring-1 ring-primary',
                  disabled && 'opacity-50 cursor-not-allowed'
                )}
                onClick={() => !disabled && setSelectedWorkflow(workflow.id)}
              >
                <CardHeader className="p-4">
                  <div className="flex items-start gap-3">
                    <div
                      className={cn(
                        'p-2 rounded-md',
                        isSelected ? 'bg-primary text-primary-foreground' : 'bg-muted'
                      )}
                    >
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="flex-1 space-y-1">
                      <CardTitle className="text-base flex items-center gap-2">
                        {workflow.name}
                        {isRecommended && (
                          <span className="text-xs font-normal text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                            Recommended
                          </span>
                        )}
                      </CardTitle>
                      <CardDescription className="text-sm">{workflow.description}</CardDescription>
                    </div>
                  </div>
                </CardHeader>
              </Card>
            );
          })}
        </div>

        {warningMessage && (
          <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 px-4 py-3 rounded-md text-sm">
            {warningMessage}
          </div>
        )}

        <div className="flex justify-center pt-2">
          <Button
            size="lg"
            onClick={() => {
              onSelect(selectedWorkflow);
            }}
            disabled={disabled || !selectedWorkflow}
            className="gap-2"
          >
            <Play className="h-4 w-4" />
            Start Session
          </Button>
        </div>
      </div>
    </div>
  );
}
