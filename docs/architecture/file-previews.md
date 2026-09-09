# File previews

The workspace file reader caps disk reads at 1 MiB plus one byte of lookahead.
The shared reader in `src/backend/lib/file-preview.ts` reads from one open
file descriptor, loops over short reads until EOF or the limit, and closes the
descriptor on success or failure. It accepts only regular files, checking the
path before opening and the descriptor before reading. Nonblocking open prevents
a FIFO swapped in between these checks from waiting for a writer. File growth
after the descriptor stat cannot increase the read budget. The returned `size`
is the size observed by that stat;
previews are not an atomic snapshot of concurrently edited files.

`workspace.readFile` returns at most the first 1 MiB of file bytes decoded as
UTF-8, omitting a codepoint split at the cutoff. Its `truncated` flag identifies
oversized text files. Binary detection still looks for NUL bytes in the first
8 KiB and returns the binary placeholder, full stat size, and `truncated: false`.
Complete files retain their existing UTF-8 decoding behavior, including BOMs
and replacement characters for malformed bytes.

The untracked-file fallback in `workspace.getFileDiff` uses the same bounded
reader after confirming the path is absent from the Git index. Tracked files
with empty Git diffs retain an empty diff regardless of file size. Untracked
files larger than 1 MiB produce a `PAYLOAD_TOO_LARGE` error that directs
the user to the file preview, instead of expanding a partial file into a
misleading unified diff. Files within the limit retain the existing diff
format. Diffs produced by Git and screenshot reads follow their existing paths.
