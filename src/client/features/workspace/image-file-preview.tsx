import { useState } from 'react';
import { StatusCallout } from '@/client/components/status-callout';

export function ImageFilePreview({ src, filePath }: { src: string; filePath: string }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <StatusCallout tone="warning" variant="strip" className="px-4">
        Couldn't display image. The file may be damaged or use an unsupported format.
      </StatusCallout>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
      <img
        src={src}
        alt={filePath}
        className="max-h-full max-w-full object-contain"
        onError={() => setFailed(true)}
      />
    </div>
  );
}
