import { CheckCircleIcon } from '@phosphor-icons/react/dist/csr/CheckCircle';
import { QuestionIcon } from '@phosphor-icons/react/dist/csr/Question';
import { XCircleIcon } from '@phosphor-icons/react/dist/csr/XCircle';
import { MarkdownRenderer } from '@/client/components/markdown';
import { withOccurrenceKeys } from '@/client/lib/list-keys';
import { cn } from '@/lib/utils';
import type { AgentMessage } from '@/shared/acp-protocol';
import { CODEX_ASYNC_QUESTION_TOOL } from '@/shared/acp-protocol/protocol/question-response';

type QuestionResponseRendererProps = {
  message: Extract<AgentMessage, { type: 'question_response' }>;
  className?: string;
  resolveWorkspaceFileLink?: (href: string) => string | null;
  onWorkspaceFileLink?: (path: string) => void;
};

const presentation = {
  answered: { label: 'Answered', Icon: CheckCircleIcon },
  cancelled: { label: 'Question cancelled', Icon: XCircleIcon },
  unavailable: { label: 'Question outcome unavailable', Icon: QuestionIcon },
};

export function QuestionResponseRenderer({
  message,
  className,
  resolveWorkspaceFileLink,
  onWorkspaceFileLink,
}: QuestionResponseRendererProps) {
  const { status, questions } = message.questionResponse;
  const details = message.questionToolDetails;
  const showDetails =
    details &&
    !questions.some((question) => question.redacted) &&
    !(status === 'answered' && details.toolName === CODEX_ASYNC_QUESTION_TOOL);
  const { label, Icon } = presentation[status];
  const rows = withOccurrenceKeys(questions, ({ id, question, header }) =>
    JSON.stringify(id === undefined ? [header, question] : [id])
  );
  return (
    <section
      aria-label={label}
      className={cn('min-w-0 rounded-md border border-border/70 px-3 py-2.5 text-sm', className)}
    >
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Icon aria-hidden="true" className="size-3.5 shrink-0" />
        {label}
      </div>
      {questions.length > 0 && (
        <dl className="mt-2 space-y-2.5">
          {rows.map(({ key, item: { question, header, answers, note, redacted } }) => (
            <div key={key} className="min-w-0 break-words">
              <dt className="font-medium">
                {header && header !== question && (
                  <span className="block text-xs font-normal text-muted-foreground">{header}</span>
                )}
                <MarkdownRenderer
                  content={question}
                  className="[&_p]:my-0"
                  resolveWorkspaceFileLink={resolveWorkspaceFileLink}
                  onWorkspaceFileLink={onWorkspaceFileLink}
                />
              </dt>
              {status === 'answered' && (
                <dd className="mt-0.5 whitespace-pre-wrap">
                  {redacted ? (
                    <span className="text-muted-foreground">Private answer hidden</span>
                  ) : (
                    <QuestionAnswer answers={answers} note={note} />
                  )}
                </dd>
              )}
            </div>
          ))}
        </dl>
      )}
      {showDetails && (
        <details className="mt-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer hover:text-foreground">Raw tool details</summary>
          <pre className="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-2">
            {JSON.stringify(
              { tool: details.toolName, input: details.input, result: details.result },
              null,
              2
            )}
          </pre>
        </details>
      )}
    </section>
  );
}

function QuestionAnswer({ answers, note }: { answers: string[]; note?: string }) {
  return (
    <>
      {answers.length > 1 ? (
        <ul className="list-disc ps-5">
          {[...new Set(answers)].map((answer) => (
            <li key={answer}>{answer}</li>
          ))}
        </ul>
      ) : (
        (answers[0] ?? (!note && <span className="text-muted-foreground">Answer unavailable</span>))
      )}
      {note && <p className="mt-0.5 text-muted-foreground">{note}</p>}
    </>
  );
}
