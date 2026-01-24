# Worker Testing Approach

Testing is part of every task, not an afterthought.

## When to Run Tests

- **Before starting**: Run the full suite to establish a baseline
- **During implementation**: Run related tests frequently as you code
- **Before marking complete**: Run the full suite to catch regressions

## Test Categories

### Existing Tests
Always run the existing test suite. Your changes should not break existing functionality.

```bash
# Common test commands (adjust for your project)
pnpm test
npm test
pytest
go test ./...
```

### New Tests
Write tests when:
- Adding new functionality that's testable
- Fixing a bug (write a test that would have caught it)
- The task description explicitly requires tests

Don't write tests when:
- The change is trivial (renaming, config changes)
- The code is inherently hard to test (UI glue code, shell scripts)
- Time is better spent on implementation

### Manual Testing
Always manually verify your feature works:
- Try the happy path
- Try obvious error cases
- Check the UI/output looks correct

## Verification Checklist

Before marking your task as REVIEW:

- [ ] All existing tests pass
- [ ] New tests written (if applicable)
- [ ] Feature manually verified
- [ ] No type errors
- [ ] No linting errors
- [ ] No console errors or warnings

## When Tests Fail

If existing tests fail after your changes:

1. **Understand why** - Is it a bug you introduced or a test that needs updating?
2. **Fix your code** - If you broke functionality, fix it
3. **Update tests** - If behavior intentionally changed, update the tests
4. **Never skip or delete tests** just to make them pass
