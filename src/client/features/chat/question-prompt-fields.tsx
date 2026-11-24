import { type Ref, useId, useRef, useState } from 'react';
import { withOccurrenceKeys } from '@/client/lib/list-keys';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';
import type { AskUserQuestion } from '@/lib/chat-protocol';
import { cn } from '@/lib/utils';
import {
  getAnswerError,
  getArrayAnswerError,
  getOtherOptionValue,
} from './question-prompt-answers';

interface QuestionFieldProps {
  question: AskUserQuestion;
  value: string | string[] | undefined;
  text: string;
  onChange: (value: string | string[]) => void;
  onTextChange: (text: string) => void;
}

interface AnswerTextProps {
  value: string;
  onChange: (text: string) => void;
  error: string | null;
  label?: string;
  labelledBy?: string;
  inputRef?: Ref<HTMLTextAreaElement>;
}

function AnswerText({ value, onChange, error, label, labelledBy, inputRef }: AnswerTextProps) {
  const errorId = useId();
  return (
    <div className="min-w-0 space-y-1">
      <Textarea
        ref={inputRef}
        aria-label={label}
        aria-labelledby={labelledBy}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Type your response…"
        className="min-h-9 px-2 py-1.5 md:text-sm"
      />
      {error && (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function QuestionOptions({
  question,
  value,
  text,
  onChange,
  onTextChange,
  labelledBy,
}: QuestionFieldProps & { labelledBy: string }) {
  const id = useId();
  const otherValue = getOtherOptionValue(question);
  const options =
    question.allowOther === false
      ? question.options
      : [...question.options, { label: 'Other', value: otherValue, description: '' }];
  const selected = Array.isArray(value) ? value : value ? [value] : [];
  const hasOther = selected.includes(otherValue);
  const choices = withOccurrenceKeys(options, (option) => option.value ?? option.label).map(
    ({ item: option, key }, index) => {
      const optionValue = option.value ?? option.label;
      const checked = selected.includes(optionValue);
      const controlId = `${id}-${index}`;
      return (
        <label
          key={key}
          htmlFor={controlId}
          className={cn(
            'flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5',
            checked ? 'bg-primary/10 hover:bg-primary/15' : 'hover:bg-background/70'
          )}
        >
          {question.multiSelect ? (
            <Checkbox
              id={controlId}
              checked={checked}
              className="mt-0.5"
              onCheckedChange={(next) => {
                if (next === true) {
                  onChange([...selected, optionValue]);
                } else {
                  if (optionValue === otherValue) {
                    onTextChange('');
                  }
                  onChange(selected.filter((item) => item !== optionValue));
                }
              }}
            />
          ) : (
            <RadioGroupItem id={controlId} value={optionValue} className="mt-0.5" />
          )}
          <div className="min-w-0 flex-1">
            <span className="block break-words text-sm leading-5">{option.label}</span>
            {option.description && option.description !== option.label && (
              <p className="break-words text-xs text-muted-foreground">{option.description}</p>
            )}
          </div>
        </label>
      );
    }
  );
  const arrayError =
    question.multiSelect && selected.length ? getArrayAnswerError(question, selected, text) : null;
  return (
    <div className="space-y-1">
      {question.multiSelect ? (
        <fieldset aria-labelledby={labelledBy} className="min-w-0 space-y-0.5">
          {choices}
        </fieldset>
      ) : (
        <RadioGroup
          aria-labelledby={labelledBy}
          value={typeof value === 'string' ? value : ''}
          onValueChange={onChange}
          className="gap-0.5"
        >
          {choices}
        </RadioGroup>
      )}
      {hasOther && (
        <div className="ml-8">
          <AnswerText
            label="Other response"
            value={text}
            onChange={onTextChange}
            error={getAnswerError(question, text)}
          />
        </div>
      )}
      {arrayError && (
        <p role="alert" className="text-xs text-destructive">
          {arrayError}
        </p>
      )}
    </div>
  );
}

export function QuestionField({
  question,
  text,
  onTextChange,
  onChange,
  value,
  titleRef,
}: QuestionFieldProps & { titleRef: Ref<HTMLHeadingElement> }) {
  const titleId = useId();
  const other = getOtherOptionValue(question);
  const options = Array.isArray(question.options) ? question.options : [];
  return (
    <div className="min-w-0 space-y-1">
      {question.header && (
        <h4 className="break-words text-xs font-medium text-muted-foreground">{question.header}</h4>
      )}
      <h3 ref={titleRef} tabIndex={-1} id={titleId} className="break-words text-sm font-medium">
        {question.question}
        {question.optional && ' (optional)'}
      </h3>
      {options.length > 0 ? (
        <QuestionOptions
          question={question}
          value={value}
          text={text}
          onChange={onChange}
          onTextChange={onTextChange}
          labelledBy={titleId}
        />
      ) : (
        <AnswerText
          labelledBy={titleId}
          value={text}
          onChange={(next) => {
            onTextChange(next);
            const selected = next.trim() ? other : '';
            onChange(question.multiSelect ? (selected ? [selected] : []) : selected);
          }}
          error={
            question.multiSelect
              ? getArrayAnswerError(question, Array.isArray(value) ? value : [], text)
              : getAnswerError(question, text)
          }
        />
      )}
    </div>
  );
}

export function CompanionNote({
  question,
  reveal,
  text,
  onChange,
}: Pick<QuestionFieldProps, 'question' | 'text'> & {
  reveal: boolean;
  onChange: (text: string) => void;
}) {
  const labelId = useId();
  const [open, setOpen] = useState(false);
  const focusOnOpen = useRef(false);
  if (!(open || reveal || text)) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="text-muted-foreground"
        onClick={() => {
          focusOnOpen.current = true;
          setOpen(true);
        }}
      >
        {question.companionNote?.revealOnValue === undefined ? 'Add a custom answer' : 'Add a note'}
      </Button>
    );
  }
  return (
    <div className="space-y-1 px-2">
      <p id={labelId} className="break-words text-xs text-muted-foreground">
        {question.question} (optional)
      </p>
      <AnswerText
        labelledBy={labelId}
        value={text}
        onChange={onChange}
        error={getAnswerError(question, text)}
        inputRef={(input) => {
          if (input && focusOnOpen.current) {
            focusOnOpen.current = false;
            input.focus();
          }
        }}
      />
    </div>
  );
}
