import { QuestionIcon } from '@phosphor-icons/react/dist/csr/Question';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { PromptCard } from '@/components/ui/prompt-card';
import type { AskUserQuestion, UserQuestionRequest } from '@/lib/chat-protocol';
import { usePromptAutoFocus } from './prompt-auto-focus';
import { formatAnswer, getOtherOptionValue, isAnswerComplete } from './question-prompt-answers';
import { CompanionNote, QuestionField } from './question-prompt-fields';

const QUESTION_FIRST_FOCUSABLE_SELECTOR =
  'input, button, textarea, [tabindex]:not([tabindex="-1"])';

interface QuestionPromptProps {
  question: UserQuestionRequest | null;
  onAnswer: (requestId: string, answers: Record<string, string | string[]>) => void;
}

interface IndexedQuestion {
  index: number;
  question: AskUserQuestion;
}

interface QuestionStep extends IndexedQuestion {
  notes: IndexedQuestion[];
}

function getQuestionSteps(questions: AskUserQuestion[]): QuestionStep[] {
  const steps = questions.map((question, index): QuestionStep => ({ index, question, notes: [] }));
  const parents = new Map(
    steps.flatMap((step) =>
      step.question.id && !step.question.companionNote && step.question.options?.length
        ? [[step.question.id, step] as const]
        : []
    )
  );
  return steps.filter(({ index, question }) => {
    const parent = question.companionNote ? parents.get(question.companionNote.questionId) : null;
    if (!(parent && question.optional) || question.options?.length || question.multiSelect) {
      return true;
    }
    parent.notes.push({ index, question });
    return false;
  });
}

export function QuestionPrompt({ question, onAnswer }: QuestionPromptProps) {
  if (!question?.questions.length) {
    return null;
  }
  return <QuestionPromptForm key={question.requestId} question={question} onAnswer={onAnswer} />;
}

function QuestionPromptForm({
  question,
  onAnswer,
}: QuestionPromptProps & { question: UserQuestionRequest }) {
  const [answers, setAnswers] = useState<Record<number, string | string[]>>({});
  const [texts, setTexts] = useState<Record<number, string>>({});
  const [stepIndex, setStepIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const focusNextTitle = useRef(false);
  usePromptAutoFocus(question.requestId, containerRef, QUESTION_FIRST_FOCUSABLE_SELECTOR);

  const steps = getQuestionSteps(question.questions);
  const currentStep = Math.min(stepIndex, steps.length - 1);
  const step = steps[currentStep];
  if (!step) {
    return null;
  }
  const last = currentStep >= steps.length - 1;

  const isComplete = (field: AskUserQuestion, index: number) =>
    isAnswerComplete(field, answers[index], texts[index] ?? '');
  const canContinue = last
    ? question.questions.every(isComplete)
    : isComplete(step.question, step.index) &&
      step.notes.every((note) => isComplete(note.question, note.index));

  function editText(index: number, value: string) {
    setTexts((previous) => ({ ...previous, [index]: value }));
  }

  function editAnswer(index: number, value: string | string[]) {
    setAnswers((previous) => ({ ...previous, [index]: value }));
  }

  function navigate(index: number) {
    focusNextTitle.current = true;
    setStepIndex(index);
  }

  function submit() {
    const formattedAnswers = Object.fromEntries(
      question.questions.flatMap((field, index) => {
        const value = formatAnswer(field, answers[index], texts[index] ?? '');
        return field.optional && value.length === 0
          ? []
          : [[field.id?.trim() || field.question, value]];
      })
    );
    onAnswer(question.requestId, formattedAnswers);
  }

  return (
    <div ref={containerRef}>
      <PromptCard
        icon={<QuestionIcon className="size-4 text-warning" aria-hidden="true" />}
        role="form"
        label={steps.length > 1 ? 'Agent questions' : 'Agent question'}
        hideIconOnMobile
        iconSlot="question-prompt-icon"
        actionsPlacement="below"
        actions={
          <>
            {currentStep > 0 && (
              <Button size="compact" variant="ghost" onClick={() => navigate(currentStep - 1)}>
                Back
              </Button>
            )}
            <Button
              size="compact"
              disabled={!canContinue}
              onClick={last ? submit : () => navigate(currentStep + 1)}
            >
              {last ? 'Submit' : 'Next'}
            </Button>
          </>
        }
      >
        {steps.length > 1 && (
          <p className="mb-1 text-xs text-muted-foreground" aria-live="polite">
            {currentStep + 1} of {steps.length}
          </p>
        )}
        <div key={step.index} className="space-y-1.5">
          <QuestionField
            question={step.question}
            value={answers[step.index]}
            text={texts[step.index] ?? ''}
            onChange={(value) => editAnswer(step.index, value)}
            onTextChange={(value) => editText(step.index, value)}
            titleRef={(title) => {
              if (title && focusNextTitle.current) {
                focusNextTitle.current = false;
                title.focus();
              }
            }}
          />
          {step.notes.map(({ index, question: note }) => {
            const revealOnValue = note.companionNote?.revealOnValue;
            return (
              <CompanionNote
                key={note.id}
                question={note}
                reveal={revealOnValue !== undefined && answers[step.index] === revealOnValue}
                text={texts[index] ?? ''}
                onChange={(value) => {
                  editText(index, value);
                  editAnswer(index, value.trim() ? getOtherOptionValue(note) : '');
                }}
              />
            );
          })}
        </div>
      </PromptCard>
    </div>
  );
}
