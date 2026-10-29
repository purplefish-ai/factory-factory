import { useAppHeader } from '@/client/components/app-header-context';
import { AgentsPage } from '@/client/features/agents/agents-page';

export default function AgentsRoute() {
  useAppHeader({ title: 'Agents' });
  return <AgentsPage />;
}
