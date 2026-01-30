# Markdown Preview Test

This file demonstrates the new markdown preview feature with Mermaid support!

## Features

- **GitHub Flavored Markdown** support
- **Mermaid diagram** rendering
- **Code highlighting** in markdown
- **Tables**, **lists**, and more

## Example Code Block

```typescript
function greet(name: string): string {
  return `Hello, ${name}!`;
}

console.log(greet("World"));
```

## Example Table

| Feature | Status | Notes |
|---------|--------|-------|
| Markdown Preview | ✅ Done | Toggle between code and preview |
| Mermaid Support | ✅ Done | Renders diagrams inline |
| Files Tab | ✅ Works | Preview markdown in Files browser |
| Unstaged Tab | ✅ Works | Preview markdown in Unstaged changes |
| Diff vs Main | ✅ Works | Preview markdown in Diff vs Main |

## Example Mermaid Diagrams

### Flowchart

```mermaid
graph TD
    A[User opens markdown file] --> B{Is in preview mode?}
    B -->|Yes| C[Render markdown with Mermaid]
    B -->|No| D[Show syntax highlighted code]
    C --> E[Display beautiful preview]
    D --> F[Display raw markdown]
```

### Sequence Diagram

```mermaid
sequenceDiagram
    participant User
    participant FileViewer
    participant MarkdownRenderer
    participant Mermaid

    User->>FileViewer: Click Preview button
    FileViewer->>MarkdownRenderer: Pass markdown content
    MarkdownRenderer->>Mermaid: Render diagrams
    Mermaid-->>MarkdownRenderer: SVG output
    MarkdownRenderer-->>FileViewer: Rendered HTML
    FileViewer-->>User: Display preview
```

### Class Diagram

```mermaid
classDiagram
    class FileViewer {
        +string workspaceId
        +string filePath
        +boolean showPreview
        +togglePreview()
    }

    class DiffViewer {
        +string workspaceId
        +string filePath
        +boolean showPreview
        +togglePreview()
    }

    class MarkdownRenderer {
        +string content
        +render()
    }

    FileViewer --> MarkdownRenderer : uses
    DiffViewer --> MarkdownRenderer : uses
```

### State Diagram

```mermaid
stateDiagram-v2
    [*] --> CodeView
    CodeView --> PreviewMode: Click Preview
    PreviewMode --> CodeView: Click Code
    PreviewMode --> Rendering: Loading
    Rendering --> PreviewMode: Complete
```

## Lists

### Unordered List
- Item 1
- Item 2
  - Nested item 2.1
  - Nested item 2.2
- Item 3

### Ordered List
1. First item
2. Second item
3. Third item

## Links

Check out the [Factory Factory repo](https://github.com/purplefish-ai/factory-factory) for more info!

## Emphasis

**Bold text** and *italic text* and ***bold italic text***

## Blockquotes

> This is a blockquote.
> It can span multiple lines.
>
> And have multiple paragraphs.

## Horizontal Rule

---

## Task Lists

- [x] Implement markdown preview
- [x] Add Mermaid support
- [x] Test with various markdown features
- [ ] Get user feedback
