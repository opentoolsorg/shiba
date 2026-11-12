// Planned catalog only: none of these are available integrations or connected accounts.
export const plannedCategories = [
  'All',
  'AI & Machine Learning',
  'Analytics',
  'Cloud & Data',
  'Communication',
  'Content & Media',
  'Customer Support',
  'Developer Tools',
  'E-Commerce',
  'Finance & Payments',
  'HR & Recruiting',
  'Marketing',
  'Other',
  'Productivity',
  'Sales & CRM',
] as const;

export type PlannedCategory = (typeof plannedCategories)[number];

export type PlannedTool = {
  name: string;
  category: Exclude<PlannedCategory, 'All'>;
};

export const plannedTools: PlannedTool[] = [
  { name: 'Microsoft Teams', category: 'Communication' },
  { name: 'Baremetrics', category: 'Analytics' },
  { name: 'Bright Data Social', category: 'Cloud & Data' },
  { name: 'Customer.io', category: 'Marketing' },
  { name: 'DeepWiki', category: 'AI & Machine Learning' },
  { name: 'GitHub (Git & CLI)', category: 'Developer Tools' },
  { name: 'Google Ads', category: 'Marketing' },
  { name: 'Google Drive', category: 'Cloud & Data' },
  { name: 'Granola', category: 'Productivity' },
  { name: 'Jira & Confluence', category: 'Productivity' },
  { name: 'Linear', category: 'Developer Tools' },
  { name: 'Meta Ads', category: 'Marketing' },
  { name: 'Monday.com', category: 'Productivity' },
  { name: 'Moz SEO', category: 'Marketing' },
  { name: 'Neon', category: 'Cloud & Data' },
  { name: 'Notion', category: 'Productivity' },
  { name: 'OneDrive', category: 'Cloud & Data' },
  { name: 'PayPal', category: 'Finance & Payments' },
  { name: 'PostHog', category: 'Analytics' },
  { name: 'PostHog (EU)', category: 'Analytics' },
  { name: 'QuickBooks', category: 'Finance & Payments' },
  { name: 'Salesforce', category: 'Sales & CRM' },
  { name: 'Sentry', category: 'Developer Tools' },
  { name: 'Square', category: 'Finance & Payments' },
];

/** Filters planned catalog entries by case-insensitive query and category. */
export function filterPlanned<T extends { name: string; category: string }>(
  tools: readonly T[],
  { query = '', category = 'All' }: { query?: string; category?: string },
): T[] {
  const q = query.trim().toLowerCase();
  return tools.filter(
    (t) => (category === 'All' || t.category === category) && (!q || `${t.name} ${t.category}`.toLowerCase().includes(q)),
  );
}

export const plannedCategoryCounts = plannedCategories.map((name) => ({
  name,
  count: filterPlanned(plannedTools, { category: name }).length,
}));
