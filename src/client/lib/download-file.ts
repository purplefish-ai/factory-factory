interface DownloadFileInput {
  data: BlobPart | BlobPart[];
  fileName: string;
  mimeType: string;
}

export function downloadFile({ data, fileName, mimeType }: DownloadFileInput): void {
  const blob = new Blob(Array.isArray(data) ? data : [data], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
