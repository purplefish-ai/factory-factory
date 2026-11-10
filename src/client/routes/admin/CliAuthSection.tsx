import { TerminalIcon } from '@phosphor-icons/react/dist/csr/Terminal';
import { useState } from 'react';
import { OnboardingCliHealth } from '@/client/features/project/onboarding-cli-health';
import { SetupTerminalModal } from '@/client/features/project/setup-terminal-modal';
import { useCLIHealthRefresh } from '@/client/hooks/use-cli-health-refresh';
import { SettingsSection } from './settings-section';

export function CliAuthSection() {
  const [terminalOpen, setTerminalOpen] = useState(false);
  const { refresh } = useCLIHealthRefresh();

  const handleCloseTerminal = () => {
    setTerminalOpen(false);
    void refresh();
  };

  return (
    <SettingsSection
      title="CLI authentication"
      icon={<TerminalIcon className="w-5 h-5" />}
      description="Check and manage authentication for Claude, Codex, and GitHub CLI"
    >
      <OnboardingCliHealth onOpenTerminal={() => setTerminalOpen(true)} />
      <SetupTerminalModal open={terminalOpen} onClose={handleCloseTerminal} />
    </SettingsSection>
  );
}
