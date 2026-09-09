import { TerminalIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import { OnboardingCliHealth } from '@/client/features/project/onboarding-cli-health';
import { SetupTerminalModal } from '@/client/features/project/setup-terminal-modal';
import { trpc } from '@/client/lib/trpc';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function CliAuthSection() {
  const [terminalOpen, setTerminalOpen] = useState(false);
  const { refetch } = trpc.admin.checkCLIHealth.useQuery(
    { forceRefresh: false },
    { enabled: false }
  );

  const handleCloseTerminal = () => {
    setTerminalOpen(false);
    refetch();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TerminalIcon className="w-5 h-5" />
          CLI Authentication
        </CardTitle>
        <CardDescription>
          Check and manage authentication for Claude, Codex, and GitHub CLI
        </CardDescription>
      </CardHeader>
      <CardContent>
        <OnboardingCliHealth onOpenTerminal={() => setTerminalOpen(true)} />
        <SetupTerminalModal open={terminalOpen} onClose={handleCloseTerminal} />
      </CardContent>
    </Card>
  );
}
