'use client';

import { HelpCircle } from 'lucide-react';
import { useCallback, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import type { AskUserQuestion, UserQuestionRequest } from '@/lib/claude-types';
import { cn } from '@/lib/utils';

// =============================================================================
// Types
// =============================================================================

interface QuestionModalProps {
  question: UserQuestionRequest | null;
  onAnswer: (requestId: string, answers: Record<string, string | string[]>) => void;
}

interface SingleQuestionProps {
  question: AskUserQuestion;
  index: number;
  value: string | string[];
  onChange: (value: string | string[]) => void;
}

// =============================================================================
// Helper Components
// =============================================================================

/**
 * Renders a single question with radio buttons (single select).
 */
function SingleSelectQuestion({ question, index, value, onChange }: SingleQuestionProps) {
  const selectedValue = typeof value === 'string' ? value : '';

  return (
    <div className="space-y-3">
      {question.header && (
        <h4 className="text-sm font-medium text-muted-foreground">{question.header}</h4>
      )}
      <p className="text-sm font-medium">{question.question}</p>

      <RadioGroup value={selectedValue} onValueChange={onChange} className="space-y-2">
        {question.options.map((option) => (
          <div
            key={`${index}-${option.label}`}
            className={cn(
              'flex items-start space-x-3 rounded-md border p-3 transition-colors',
              selectedValue === option.label && 'border-primary bg-primary/5'
            )}
          >
            <RadioGroupItem
              value={option.label}
              id={`question-${index}-option-${option.label}`}
              className="mt-0.5"
            />
            <div className="flex-1 space-y-1">
              <Label
                htmlFor={`question-${index}-option-${option.label}`}
                className="text-sm font-medium cursor-pointer"
              >
                {option.label}
              </Label>
              {option.description && (
                <p className="text-xs text-muted-foreground">{option.description}</p>
              )}
            </div>
          </div>
        ))}
      </RadioGroup>
    </div>
  );
}

/**
 * Renders a single question with checkboxes (multi select).
 */
function MultiSelectQuestion({ question, index, value, onChange }: SingleQuestionProps) {
  const selectedValues = Array.isArray(value) ? value : [];

  const handleCheckboxChange = useCallback(
    (optionLabel: string, checked: boolean) => {
      if (checked) {
        onChange([...selectedValues, optionLabel]);
      } else {
        onChange(selectedValues.filter((v) => v !== optionLabel));
      }
    },
    [selectedValues, onChange]
  );

  return (
    <div className="space-y-3">
      {question.header && (
        <h4 className="text-sm font-medium text-muted-foreground">{question.header}</h4>
      )}
      <p className="text-sm font-medium">{question.question}</p>

      <div className="space-y-2">
        {question.options.map((option) => {
          const isSelected = selectedValues.includes(option.label);

          return (
            <div
              key={`${index}-${option.label}`}
              className={cn(
                'flex items-start space-x-3 rounded-md border p-3 transition-colors',
                isSelected && 'border-primary bg-primary/5'
              )}
            >
              <Checkbox
                id={`question-${index}-option-${option.label}`}
                checked={isSelected}
                onCheckedChange={(checked) => handleCheckboxChange(option.label, checked === true)}
                className="mt-0.5"
              />
              <div className="flex-1 space-y-1">
                <Label
                  htmlFor={`question-${index}-option-${option.label}`}
                  className="text-sm font-medium cursor-pointer"
                >
                  {option.label}
                </Label>
                {option.description && (
                  <p className="text-xs text-muted-foreground">{option.description}</p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// =============================================================================
// Main Component
// =============================================================================

/**
 * Modal dialog for answering AskUserQuestion requests (Phase 11).
 */
export function QuestionModal({ question, onAnswer }: QuestionModalProps) {
  // State for answers - keyed by question index
  const [answers, setAnswers] = useState<Record<number, string | string[]>>({});

  // Reset answers when question changes
  const currentRequestId = question?.requestId;

  const handleAnswerChange = useCallback((index: number, value: string | string[]) => {
    setAnswers((prev) => ({
      ...prev,
      [index]: value,
    }));
  }, []);

  const handleSubmit = useCallback(() => {
    if (!question) {
      return;
    }

    // Convert indexed answers to the format expected by the hook
    // The hook expects answers keyed by question text
    const formattedAnswers: Record<string, string | string[]> = {};

    question.questions.forEach((q, index) => {
      const answer = answers[index];
      if (answer !== undefined) {
        formattedAnswers[q.question] = answer;
      } else {
        // Default to empty string/array based on multiSelect
        formattedAnswers[q.question] = q.multiSelect ? [] : '';
      }
    });

    onAnswer(question.requestId, formattedAnswers);

    // Reset answers after submit
    setAnswers({});
  }, [question, answers, onAnswer]);

  // Check if all questions have been answered
  const isComplete = question?.questions.every((q, index) => {
    const answer = answers[index];
    if (q.multiSelect) {
      return Array.isArray(answer) && answer.length > 0;
    }
    return typeof answer === 'string' && answer.length > 0;
  });

  if (!question) {
    return null;
  }

  return (
    <Dialog
      open={!!question}
      onOpenChange={() => {
        /* Modal cannot be dismissed */
      }}
    >
      <DialogContent className="sm:max-w-[500px] max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <HelpCircle className="h-5 w-5 text-blue-500" />
            <DialogTitle>Question from Claude</DialogTitle>
          </div>
          <DialogDescription>
            Please answer the following question{question.questions.length > 1 ? 's' : ''} to
            continue.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {question.questions.map((q, index) => (
            // Using question text as key since questions don't have unique IDs
            <div key={`${currentRequestId}-${q.question}`}>
              {q.multiSelect ? (
                <MultiSelectQuestion
                  question={q}
                  index={index}
                  value={answers[index] ?? []}
                  onChange={(value) => handleAnswerChange(index, value)}
                />
              ) : (
                <SingleSelectQuestion
                  question={q}
                  index={index}
                  value={answers[index] ?? ''}
                  onChange={(value) => handleAnswerChange(index, value)}
                />
              )}

              {index < question.questions.length - 1 && <div className="border-t my-4" />}
            </div>
          ))}
        </div>

        <DialogFooter>
          <Button onClick={handleSubmit} disabled={!isComplete}>
            Submit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
