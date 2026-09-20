export interface ConfigIssue { readonly variable: string; readonly message: string; }
function formatMessage(issues: readonly ConfigIssue[]): string { const lines=issues.map(issue=>`  - ${issue.variable}: ${issue.message}`); return `Invalid configuration (${issues.length} problem${issues.length===1?'':'s'}):\n${lines.join('\n')}`; }
export class ConfigError extends Error { readonly issues: readonly ConfigIssue[]; constructor(issues: ConfigIssue[]){ super(formatMessage(issues)); this.name='ConfigError'; this.issues=issues; } }
