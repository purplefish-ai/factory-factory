import { useId } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { AGENT_CADENCE_LABELS, supportsAgentClockTime } from './agent-schedule';
import type { AgentCadence } from './types';

export interface AgentScheduleFieldsProps {
  cadence: AgentCadence;
  scheduledTime: string;
  onCadenceChange: (cadence: AgentCadence) => void;
  onScheduledTimeChange: (time: string) => void;
  disabled?: boolean;
}

export function AgentScheduleFields({
  cadence,
  scheduledTime,
  onCadenceChange,
  onScheduledTimeChange,
  disabled,
}: AgentScheduleFieldsProps) {
  const id = useId();
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-2">
        <Label htmlFor={`${id}-cadence`}>Schedule</Label>
        <Select
          value={cadence}
          onValueChange={(value) => {
            if (value in AGENT_CADENCE_LABELS) {
              onCadenceChange(value as AgentCadence);
            }
          }}
          disabled={disabled}
        >
          <SelectTrigger id={`${id}-cadence`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(AGENT_CADENCE_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {supportsAgentClockTime(cadence) && (
        <div className="space-y-2">
          <Label htmlFor={`${id}-time`}>Run time (optional)</Label>
          <Input
            id={`${id}-time`}
            type="time"
            value={scheduledTime}
            onChange={(event) => onScheduledTimeChange(event.target.value)}
            disabled={disabled}
          />
        </div>
      )}
    </div>
  );
}
