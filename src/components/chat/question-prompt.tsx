import { ChevronLeft, ChevronRight, HelpCircle } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';
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
  otherText: string;
  onOtherTextChange: (value: string) => void;
}

// =============================================================================
// Helper Components
// =============================================================================

const OTHER_OPTION_VALUE = '__other__';

function normalizeOtherText(value: string | undefined): string {
  return value?.trim() ?? '';
}

function isAnswerComplete(
  question: AskUserQuestion,
  answer: string | string[] | undefined,
  otherText: string
): boolean {
  const normalizedOther = normalizeOtherText(otherText);
  if (question.multiSelect) {
    if (!Array.isArray(answer) || answer.length === 0) {
      return false;
    }
    if (answer.includes(OTHER_OPTION_VALUE)) {
      return normalizedOther.length > 0;
    }
    return true;
  }
  if (typeof answer !== 'string' || answer.length === 0) {
    return false;
  }
  if (answer === OTHER_OPTION_VALUE) {
    return normalizedOther.length > 0;
  }
  return true;
}

function formatAnswer(
  question: AskUserQuestion,
  answer: string | string[] | undefined,
  otherText: string
): string | string[] {
  const normalizedOther = normalizeOtherText(otherText);
  if (answer === undefined) {
    return question.multiSelect ? [] : '';
  }
  if (question.multiSelect && Array.isArray(answer)) {
    if (answer.includes(OTHER_OPTION_VALUE) && normalizedOther) {
      return answer.map((value) => (value === OTHER_OPTION_VALUE ? normalizedOther : value));
    }
    return answer;
  }
  if (!question.multiSelect && answer === OTHER_OPTION_VALUE && normalizedOther) {
    return normalizedOther;
  }
  return answer as string;
}

/**
 * Renders a single question with radio buttons (single select).
 */
function SingleSelectQuestion({
  question,
  index,
  value,
  onChange,
  otherText,
  onOtherTextChange,
}: SingleQuestionProps) {
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
        <label
          htmlFor={`question-${index}-option-other`}
          className={cn(
            'flex items-start gap-2.5 p-2 rounded-md border transition-colors cursor-pointer hover:bg-background',
            selectedValue === OTHER_OPTION_VALUE && 'border-primary bg-primary/5'
          )}
        >
          <RadioGroupItem
            value={OTHER_OPTION_VALUE}
            id={`question-${index}-option-other`}
            className="shrink-0 mt-1"
          />
          <div className="flex-1 min-w-0 space-y-1.5">
            <span className="text-sm font-medium">Other</span>
            <Textarea
              value={otherText}
              onFocus={() => {
                if (selectedValue !== OTHER_OPTION_VALUE) {
                  onChange(OTHER_OPTION_VALUE);
                }
              }}
              onClick={() => {
                if (selectedValue !== OTHER_OPTION_VALUE) {
                  onChange(OTHER_OPTION_VALUE);
                }
              }}
              onBlur={() => {
                if (selectedValue === OTHER_OPTION_VALUE && otherText.trim().length === 0) {
                  onChange('');
                }
              }}
              onChange={(event) => {
                const nextValue = event.target.value;
                onOtherTextChange(nextValue);
                if (nextValue.trim().length > 0 && selectedValue !== OTHER_OPTION_VALUE) {
                  onChange(OTHER_OPTION_VALUE);
                }
                if (nextValue.trim().length === 0 && selectedValue === OTHER_OPTION_VALUE) {
                  onChange('');
                }
              }}
              placeholder="Type your response..."
              className="min-h-[56px] text-sm"
            />
          </div>
        </label>
      </RadioGroup>
    </div>
  );
}

/**
 * Renders a single question with checkboxes (multi select).
 */
function MultiSelectQuestion({
  question,
  index,
  value,
  onChange,
  otherText,
  onOtherTextChange,
}: SingleQuestionProps) {
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
        <label
          htmlFor={`question-${index}-option-other`}
          className={cn(
            'flex items-start gap-2.5 p-2 rounded-md border transition-colors cursor-pointer hover:bg-background',
            selectedValues.includes(OTHER_OPTION_VALUE) && 'border-primary bg-primary/5'
          )}
        >
          <Checkbox
            id={`question-${index}-option-other`}
            checked={selectedValues.includes(OTHER_OPTION_VALUE)}
            onCheckedChange={(checked) => {
              const shouldSelect = checked === true;
              if (shouldSelect) {
                onChange([...selectedValues, OTHER_OPTION_VALUE]);
              } else {
                onOtherTextChange('');
                onChange(selectedValues.filter((v) => v !== OTHER_OPTION_VALUE));
              }
            }}
            className="shrink-0 mt-1"
          />
          <div className="flex-1 min-w-0 space-y-1.5">
            <span className="text-sm font-medium">Other</span>
            <Textarea
              value={otherText}
              onFocus={() => {
                if (!selectedValues.includes(OTHER_OPTION_VALUE)) {
                  onChange([...selectedValues, OTHER_OPTION_VALUE]);
                }
              }}
              onClick={() => {
                if (!selectedValues.includes(OTHER_OPTION_VALUE)) {
                  onChange([...selectedValues, OTHER_OPTION_VALUE]);
                }
              }}
              onBlur={() => {
                if (otherText.trim().length === 0 && selectedValues.includes(OTHER_OPTION_VALUE)) {
                  onChange(selectedValues.filter((value) => value !== OTHER_OPTION_VALUE));
                }
              }}
              onChange={(event) => {
                const nextValue = event.target.value;
                onOtherTextChange(nextValue);
                if (nextValue.trim().length > 0 && !selectedValues.includes(OTHER_OPTION_VALUE)) {
                  onChange([...selectedValues, OTHER_OPTION_VALUE]);
                }
                if (nextValue.trim().length === 0 && selectedValues.includes(OTHER_OPTION_VALUE)) {
                  onChange(selectedValues.filter((v) => v !== OTHER_OPTION_VALUE));
                }
              }}
              placeholder="Type your response..."
              className="min-h-[56px] text-sm"
            />
          </div>
        </label>
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
 * Paginates multiple questions to save vertical space.
 */
export function QuestionPrompt({ question, onAnswer }: QuestionPromptProps) {
  // State for answers - keyed by question index
  const [answers, setAnswers] = useState<Record<number, string | string[]>>({});
  // State for current question index (pagination)
  const [currentIndex, setCurrentIndex] = useState(0);
  // Inline freeform responses keyed by question index
  const [otherTexts, setOtherTexts] = useState<Record<number, string>>({});
  // Ref for focusing the question container
  const containerRef = useRef<HTMLDivElement>(null);

  // Current request ID for key generation
  const currentRequestId = question?.requestId;

  // Reset state when question changes (new question arrives)
  useEffect(() => {
    if (!currentRequestId) {
      return;
    }
    setAnswers({});
    setCurrentIndex(0);
    setOtherTexts({});
  }, [currentRequestId]);

  const handleAnswerChange = useCallback((index: number, value: string | string[]) => {
    setAnswers((prev) => ({
      ...prev,
      [index]: value,
    }));
  }, []);

  const handleOtherTextChange = useCallback((index: number, value: string) => {
    setOtherTexts((prev) => ({
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
      formattedAnswers[q.question] = formatAnswer(q, answers[index], otherTexts[index]);
    });

    onAnswer(question.requestId, formattedAnswers);

    // Reset answers and pagination after submit
    setAnswers({});
    setCurrentIndex(0);
    setOtherTexts({});
  }, [question, answers, otherTexts, onAnswer]);

  // Check if all questions have been answered
  const isComplete = question?.questions.every((q, index) =>
    isAnswerComplete(q, answers[index], otherTexts[index] ?? '')
  );

  // Check if current question has been answered
  const isCurrentAnswered = (() => {
    if (!question) {
      return false;
    }
    const q = question.questions[currentIndex];
    return isAnswerComplete(q, answers[currentIndex], otherTexts[currentIndex] ?? '');
  })();

  if (!question) {
    return null;
  }

  const totalQuestions = question.questions.length;
  const currentQuestion = question.questions[currentIndex];
  const isLastQuestion = currentIndex === totalQuestions - 1;
  const isFirstQuestion = currentIndex === 0;

  // For single question, render without pagination
  if (totalQuestions === 1) {
    return (
      // biome-ignore lint/a11y/useSemanticElements: Using role="form" without form element since we handle submission via callback
      <div
        ref={containerRef}
        className="border-b bg-muted/50 p-3"
        role="form"
        aria-label="Question from Claude"
      >
        <div className="flex items-start gap-3">
          <HelpCircle className="h-5 w-5 shrink-0 text-blue-500 mt-0.5" aria-hidden="true" />
          <div className="flex-1 min-w-0 space-y-3">
            {currentQuestion.multiSelect ? (
              <MultiSelectQuestion
                question={currentQuestion}
                index={0}
                value={answers[0] ?? []}
                onChange={(value) => handleAnswerChange(0, value)}
                otherText={otherTexts[0] ?? ''}
                onOtherTextChange={(value) => handleOtherTextChange(0, value)}
              />
            ) : (
              <SingleSelectQuestion
                question={currentQuestion}
                index={0}
                value={answers[0] ?? ''}
                onChange={(value) => handleAnswerChange(0, value)}
                otherText={otherTexts[0] ?? ''}
                onOtherTextChange={(value) => handleOtherTextChange(0, value)}
              />
            )}
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

  // For multiple questions, render with pagination
  return (
    // biome-ignore lint/a11y/useSemanticElements: Using role="form" without form element since we handle submission via callback
    <div
      ref={containerRef}
      className="border-b bg-muted/50 p-3"
      role="form"
      aria-label="Questions from Claude"
    >
      <div className="flex items-start gap-3">
        <HelpCircle className="h-5 w-5 shrink-0 text-blue-500 mt-0.5" aria-hidden="true" />
        <div className="flex-1 min-w-0">
          {/* Progress indicator */}
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-muted-foreground">
              Question {currentIndex + 1} of {totalQuestions}
            </span>
            <div className="flex gap-1">
              {question.questions.map((q, idx) => (
                <button
                  type="button"
                  key={`dot-${currentRequestId}-${q.question}`}
                  onClick={() => setCurrentIndex(idx)}
                  className={cn(
                    'w-2 h-2 rounded-full transition-colors',
                    idx === currentIndex
                      ? 'bg-primary'
                      : answers[idx] !== undefined
                        ? 'bg-primary/50'
                        : 'bg-muted-foreground/30'
                  )}
                  aria-label={`Go to question ${idx + 1}`}
                />
              ))}
            </div>
          </div>

          {/* Current question */}
          {currentQuestion.multiSelect ? (
            <MultiSelectQuestion
              question={currentQuestion}
              index={currentIndex}
              value={answers[currentIndex] ?? []}
              onChange={(value) => handleAnswerChange(currentIndex, value)}
              otherText={otherTexts[currentIndex] ?? ''}
              onOtherTextChange={(value) => handleOtherTextChange(currentIndex, value)}
            />
          ) : (
            <SingleSelectQuestion
              question={currentQuestion}
              index={currentIndex}
              value={answers[currentIndex] ?? ''}
              onChange={(value) => handleAnswerChange(currentIndex, value)}
              otherText={otherTexts[currentIndex] ?? ''}
              onOtherTextChange={(value) => handleOtherTextChange(currentIndex, value)}
            />
          )}
        </div>

        {/* Navigation and submit */}
        <div className="shrink-0 self-end flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setCurrentIndex((i) => i - 1)}
            disabled={isFirstQuestion}
            className="h-8 w-8 p-0"
            aria-label="Previous question"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>

          {isLastQuestion ? (
            <Button size="sm" onClick={handleSubmit} disabled={!isComplete}>
              Submit
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => setCurrentIndex((i) => i + 1)}
              disabled={!isCurrentAnswered}
            >
              Next
            </Button>
          )}

          {!isLastQuestion && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setCurrentIndex((i) => i + 1)}
              className="h-8 w-8 p-0"
              aria-label="Next question"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
