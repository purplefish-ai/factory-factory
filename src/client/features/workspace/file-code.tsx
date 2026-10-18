import { Component, type CSSProperties, lazy, type ReactNode, Suspense } from 'react';
import type { SyntaxHighlighterProps } from 'react-syntax-highlighter';
import './file-code.css';

// Keep the full Prism grammar set behind the file viewer's first code render.
const SyntaxHighlighter = lazy(() => import('react-syntax-highlighter/dist/esm/prism'));

interface FileCodeProps {
  content: string;
  language: string;
  theme: 'dark' | 'light';
}

const preStyle: CSSProperties = {
  margin: 0,
  padding: '1rem',
  background: 'transparent',
  fontSize: '0.75rem',
  fontFamily: 'var(--font-mono)',
  lineHeight: '1.5',
};
const codeStyle: CSSProperties = { background: 'transparent', fontFamily: 'var(--font-mono)' };
const codeTagProps: SyntaxHighlighterProps['codeTagProps'] = { style: codeStyle };
const lineNumberStyle: CSSProperties = {
  minWidth: '3em',
  paddingRight: '1em',
  color: 'var(--muted-foreground)',
  background: 'transparent',
};

function PlainFileCode({
  content,
  language,
  theme,
  loading = true,
}: FileCodeProps & { loading?: boolean }) {
  const lines = content.split('\n').map((line, index) => ({ line, number: index + 1 }));
  return (
    <pre className="file-code" data-syntax-theme={theme} style={preStyle} aria-busy={loading}>
      <code className={`language-${language}`} style={codeStyle}>
        {lines.map(({ line, number }) => (
          <span key={number}>
            <span className="react-syntax-highlighter-line-number" style={lineNumberStyle}>
              {number}
            </span>
            {line}
            {number < lines.length ? '\n' : ''}
          </span>
        ))}
      </code>
    </pre>
  );
}

class HighlightErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function FileCode(props: FileCodeProps) {
  return (
    <HighlightErrorBoundary fallback={<PlainFileCode {...props} loading={false} />}>
      <Suspense fallback={<PlainFileCode {...props} />}>
        <SyntaxHighlighter
          className="file-code"
          data-syntax-theme={props.theme}
          language={props.language}
          useInlineStyles={false}
          showLineNumbers
          wrapLines
          customStyle={preStyle}
          codeTagProps={{ ...codeTagProps, className: `language-${props.language}` }}
          lineNumberStyle={lineNumberStyle}
        >
          {props.content}
        </SyntaxHighlighter>
      </Suspense>
    </HighlightErrorBoundary>
  );
}
