'use client';

import { HelpCircle } from 'lucide-react';
import { useCallback, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import type { AskUserQuestion, UserQuestionRequest } from '@/lib/claude-types';
import { cn } from '@/lib/utils';

// =============================================================================
// Types
// =============================================================================

interface QuestionPromptProps {
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
    <div className="space-y-2">
      {question.header && (
        <h4 className="text-xs font-medium text-muted-foreground">{question.header}</h4>
      )}
      <p className="text-sm font-medium">{question.question}</p>

      <RadioGroup value={selectedValue} onValueChange={onChange} className="space-y-1.5">
        {question.options.map((option) => (
          <label
            key={`${index}-${option.label}`}
            htmlFor={`question-${index}-option-${option.label}`}
            className={cn(
              'flex items-center gap-2.5 p-2 rounded-md border transition-colors cursor-pointer hover:bg-background',
              selectedValue === option.label && 'border-primary bg-primary/5'
            )}
          >
            <RadioGroupItem
              value={option.label}
              id={`question-${index}-option-${option.label}`}
              className="shrink-0"
            />
            <div className="flex-1 min-w-0">
              <span className="text-sm">{option.label}</span>
              {option.description && (
                <p className="text-xs text-muted-foreground truncate">{option.description}</p>
              )}
            </div>
          </label>
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
    <div className="space-y-2">
      {question.header && (
        <h4 className="text-xs font-medium text-muted-foreground">{question.header}</h4>
      )}
      <p className="text-sm font-medium">{question.question}</p>

      <div className="space-y-1.5">
        {question.options.map((option) => {
          const isSelected = selectedValues.includes(option.label);

          return (
            <label
              key={`${index}-${option.label}`}
              htmlFor={`question-${index}-option-${option.label}`}
              className={cn(
                'flex items-center gap-2.5 p-2 rounded-md border transition-colors cursor-pointer hover:bg-background',
                isSelected && 'border-primary bg-primary/5'
              )}
            >
              <Checkbox
                id={`question-${index}-option-${option.label}`}
                checked={isSelected}
                onCheckedChange={(checked) => handleCheckboxChange(option.label, checked === true)}
                className="shrink-0"
              />
              <div className="flex-1 min-w-0">
                <span className="text-sm">{option.label}</span>
                {option.description && (
                  <p className="text-xs text-muted-foreground truncate">{option.description}</p>
                )}
              </div>
            </label>
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
 * Inline prompt for answering AskUserQuestion requests.
 * Appears above the chat input as a compact card.
 */
export function QuestionPrompt({ question, onAnswer }: QuestionPromptProps) {
  // State for answers - keyed by question index
  const [answers, setAnswers] = useState<Record<number, string | string[]>>({});

  // Current request ID for key generation
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
    <div className="border-t bg-muted/50 p-3">
      <div className="flex items-start gap-3">
        <HelpCircle className="h-5 w-5 shrink-0 text-blue-500 mt-0.5" />
        <div className="flex-1 min-w-0 space-y-3">
          {question.questions.map((q, index) => (
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

              {index < question.questions.length - 1 && <div className="border-t my-3" />}
            </div>
          ))}
        </div>
        <div className="shrink-0 self-end">
          <Button size="sm" onClick={handleSubmit} disabled={!isComplete}>
            Submit
          </Button>
        </div>
      </div>
    </div>
  );
}
