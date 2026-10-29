/** Individual config option value */
export interface AcpConfigOptionValue {
  value: string;
  name: string;
  description?: string;
}

/** Grouped config option values (for hierarchical option lists) */
export interface AcpConfigOptionGroup {
  group: string;
  options: AcpConfigOptionValue[];
}

/** ACP agent-provided config option (model, mode, thought level, custom) */
export interface AcpConfigOption {
  id: string;
  name: string;
  description?: string | null;
  type: string;
  category?: string | null;
  currentValue: string;
  options: Array<AcpConfigOptionValue | AcpConfigOptionGroup>;
}
