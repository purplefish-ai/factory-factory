export function encodeGitHubTreeRef(ref: string): string {
  return ref
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}
