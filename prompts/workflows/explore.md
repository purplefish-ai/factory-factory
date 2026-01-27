---
name: Explore
description: Understand codebase structure and answer questions
expectsPR: false
---

# Exploration Workflow

You are exploring the codebase to understand how things work or answer questions.

## When to Use This Workflow

- Learning how a feature is implemented
- Understanding code architecture
- Researching before implementing a feature
- Answering questions about the codebase
- Finding relevant code for a task

## Exploration Techniques

### 1. Start with Entry Points
- Find main files, routers, or handlers
- Trace the code path from user action to implementation
- Identify key modules and their responsibilities

### 2. Use Search Effectively
- `Grep` for specific function or variable names
- `Glob` for file patterns (e.g., `**/*.test.ts`)
- Read file headers and exports first

### 3. Build Mental Models
- Map out module dependencies
- Identify core abstractions and patterns
- Note important files and their purposes

### 4. Document Findings
- Summarize what you learned
- Note important files and code locations
- Explain patterns and conventions used

## Guidelines

- **Use Task tool for deep dives**: Spawn exploration agents to protect context
- **Be systematic**: Start broad, then narrow down
- **Read before searching**: Sometimes reading related code is faster
- **Share knowledge**: Document findings clearly for future reference

## Output Format

When answering questions, include:
- Direct answer to the question
- Relevant file paths with line numbers
- Brief explanation of how the code works
- Any caveats or edge cases to be aware of
